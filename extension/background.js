/**
 * Background Service Worker
 * 
 * Maintains WebSocket connection to bridge server,
 * forwards messages to content script on claude.ai
 */

// Configuration - will be overridden by storage
let CONFIG = {
  serverUrl: 'ws://localhost:8765/ws',
  reconnectDelay: 3000,
  maxReconnectDelay: 30000,
};

let ws = null;
let reconnectAttempts = 0;
let contentScriptPort = null;

// Load config from storage
chrome.storage.sync.get(['serverUrl'], (result) => {
  if (result.serverUrl) {
    CONFIG.serverUrl = result.serverUrl;
  }
  connect();
});

// Listen for config changes
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.serverUrl) {
    CONFIG.serverUrl = changes.serverUrl.newValue;
    reconnect();
  }
});


// --- Keepalive via chrome.alarms ---

// Create alarm to keep service worker alive
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });  // Every ~24 seconds

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    // Just checking connection status is enough to keep worker alive
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.log('[Bridge] Keepalive alarm - not connected, attempting reconnect');
      connect();
    }
  }
});


// --- WebSocket Connection ---

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  console.log(`[Bridge] Connecting to ${CONFIG.serverUrl}...`);
  updateBadge('connecting');

  try {
    ws = new WebSocket(CONFIG.serverUrl);
  } catch (err) {
    console.error('[Bridge] Failed to create WebSocket:', err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[Bridge] Connected!');
    reconnectAttempts = 0;
    updateBadge('connected');
    
    // Notify server we're ready
    ws.send(JSON.stringify({ type: 'status', status: 'ready' }));
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      
      // Handle ping/pong keepalive
      if (message.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: message.ts }));
        return;
      }
      
      console.log('[Bridge] Received:', message.type, message.sender || '');
      handleServerMessage(message);
    } catch (err) {
      console.error('[Bridge] Failed to parse message:', err);
    }
  };

  ws.onerror = (error) => {
    console.error('[Bridge] WebSocket error:', error);
    updateBadge('error');
  };

  ws.onclose = (event) => {
    console.log(`[Bridge] Disconnected (code: ${event.code})`);
    ws = null;
    updateBadge('disconnected');
    scheduleReconnect();
  };
}

function reconnect() {
  if (ws) {
    // Remove handlers before closing to prevent race condition
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
    ws = null;
  }
  reconnectAttempts = 0;
  connect();
}

function scheduleReconnect() {
  const delay = Math.min(
    CONFIG.reconnectDelay * Math.pow(2, reconnectAttempts),
    CONFIG.maxReconnectDelay
  );
  reconnectAttempts++;
  
  console.log(`[Bridge] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})...`);
  setTimeout(connect, delay);
}


// --- Message Handling ---

function handleServerMessage(message) {
  // Forward to content script
  if (contentScriptPort) {
    try {
      contentScriptPort.postMessage(message);
    } catch (err) {
      console.error('[Bridge] Failed to forward to content script:', err);
      contentScriptPort = null;
    }
  } else {
    console.warn('[Bridge] No content script connected, message dropped');
    
    // Try to find claude.ai tab and inject
    chrome.tabs.query({ url: 'https://claude.ai/*' }, (tabs) => {
      if (tabs.length > 0) {
        // Send via chrome.tabs.sendMessage as fallback
        chrome.tabs.sendMessage(tabs[0].id, message).catch(() => {
          console.warn('[Bridge] Could not reach content script');
        });
      }
    });
  }
}


// --- Content Script Communication ---

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'claude-bridge') {
    console.log('[Bridge] Content script connected');
    contentScriptPort = port;
    
    // Send current connection status
    port.postMessage({
      type: 'status',
      connected: ws && ws.readyState === WebSocket.OPEN
    });
    
    port.onMessage.addListener((message) => {
      // Forward responses back to server
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    });
    
    port.onDisconnect.addListener(() => {
      console.log('[Bridge] Content script disconnected');
      contentScriptPort = null;
    });
  }
});

// Also listen for one-off messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getStatus') {
    sendResponse({
      connected: ws && ws.readyState === WebSocket.OPEN,
      serverUrl: CONFIG.serverUrl
    });
    return true;
  }
  
  if (message.type === 'reconnect') {
    reconnect();
    sendResponse({ ok: true });
    return true;
  }
});


// --- Badge Updates ---

function updateBadge(status) {
  const badges = {
    connected: { text: '●', color: '#22c55e' },
    connecting: { text: '◐', color: '#eab308' },
    disconnected: { text: '○', color: '#6b7280' },
    error: { text: '!', color: '#ef4444' },
  };
  
  const badge = badges[status] || badges.disconnected;
  
  chrome.action.setBadgeText({ text: badge.text });
  chrome.action.setBadgeBackgroundColor({ color: badge.color });
}


// --- Initialization ---

// Set initial badge
updateBadge('disconnected');
