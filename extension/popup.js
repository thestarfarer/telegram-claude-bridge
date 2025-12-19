// Popup script - handles configuration UI

document.addEventListener('DOMContentLoaded', () => {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const serverUrlInput = document.getElementById('serverUrl');
  const saveBtn = document.getElementById('saveBtn');
  const reconnectBtn = document.getElementById('reconnectBtn');
  
  // Load saved config
  chrome.storage.sync.get(['serverUrl'], (result) => {
    serverUrlInput.value = result.serverUrl || 'ws://localhost:8765/ws';
  });
  
  // Get current status
  chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
    if (response) {
      updateStatus(response.connected);
    }
  });
  
  // Save button
  saveBtn.addEventListener('click', () => {
    const url = serverUrlInput.value.trim();
    
    if (!url) {
      alert('Please enter a server URL');
      return;
    }
    
    chrome.storage.sync.set({ serverUrl: url }, () => {
      statusText.textContent = 'Saved! Reconnecting...';
      statusDot.className = 'status-dot connecting';
      
      // Trigger reconnect
      chrome.runtime.sendMessage({ type: 'reconnect' }, () => {
        setTimeout(checkStatus, 1500);
      });
    });
  });
  
  // Reconnect button
  reconnectBtn.addEventListener('click', () => {
    statusText.textContent = 'Reconnecting...';
    statusDot.className = 'status-dot connecting';
    
    chrome.runtime.sendMessage({ type: 'reconnect' }, () => {
      setTimeout(checkStatus, 1500);
    });
  });
  
  function checkStatus() {
    chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
      if (response) {
        updateStatus(response.connected);
      }
    });
  }
  
  function updateStatus(connected) {
    if (connected) {
      statusDot.className = 'status-dot connected';
      statusText.textContent = 'Connected';
    } else {
      statusDot.className = 'status-dot';
      statusText.textContent = 'Disconnected';
    }
  }
});
