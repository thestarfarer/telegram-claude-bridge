/**
 * Content Script for claude.ai
 * 
 * Injects messages from Telegram into Claude's input field,
 * handles file attachments via synthetic drag-and-drop.
 */

// Configuration
const CONFIG = {
  attributionPrefix: true,    // Include [Sender]: prefix
  autoSend: true,             // If true, auto-click send. If false, just inject.
  messageDelay: 500,          // ms to wait between injection and send (text only)
  attachmentDelay: 2000,      // ms to wait when files were attached (React needs time)
  showNotifications: true,    // Toast notifications for incoming messages
  debug: true,                // Comprehensive DOM logging
};

// TTS Language Configuration
// Add/remove languages as needed. Each language needs:
//   - pattern: regex to detect this language's characters
//   - langPrefix: voice.lang prefix to match (e.g., 'ru', 'en', 'de')
//   - name: display name for debug logs
const TTS_LANGUAGES = [
  {
    name: 'German',
    pattern: /[äöüßÄÖÜẞ]/g,  // German-specific characters
    langPrefix: 'de',
  },
  {
    name: 'French',
    pattern: /[àâæçéèêëîïôùûüœÀÂÆÇÉÈÊËÎÏÔÙÛÜŒ«»]/g,  // French-specific characters
    langPrefix: 'fr',
  },
  {
    name: 'Chinese',
    pattern: /[\u4E00-\u9FFF]/g,  // CJK Unified Ideographs
    langPrefix: 'zh',
  },
  {
    name: 'Japanese',
    pattern: /[\u3040-\u309F\u30A0-\u30FF]/g,  // Hiragana + Katakana
    langPrefix: 'ja',
  },
  {
    name: 'Korean',
    pattern: /[\uAC00-\uD7AF]/g,  // Hangul
    langPrefix: 'ko',
  },
  {
    name: 'Arabic',
    pattern: /[\u0600-\u06FF]/g,  // Arabic
    langPrefix: 'ar',
  },
  {
    name: 'Russian',
    pattern: /[\u0400-\u04FF]/g,  // Cyrillic
    langPrefix: 'ru',
  },
  // Default fallback (English/Latin) - always last
  {
    name: 'English',
    pattern: /[a-zA-Z]/g,
    langPrefix: 'en',
    isDefault: true,
  },
];

// Connection to background script
let port = null;
let isConnected = false;

// Queue for messages while Claude is busy
const messageQueue = [];
let isProcessing = false;


// --- Debug Logging ---

function debug(...args) {
  if (CONFIG.debug) {
    console.log('[Claude Bridge]', ...args);
  }
}

function debugDOM(label, element) {
  if (!CONFIG.debug) return;
  
  if (!element) {
    console.log(`[Claude Bridge] ${label}: NOT FOUND`);
    return;
  }
  
  console.group(`[Claude Bridge] ${label}`);
  console.log('Element:', element);
  console.log('Tag:', element.tagName);
  console.log('Classes:', element.className);
  console.log('ID:', element.id);
  console.log('Attributes:', Array.from(element.attributes).map(a => `${a.name}="${a.value}"`).join(', '));
  console.log('ContentEditable:', element.contentEditable);
  console.log('Children count:', element.children.length);
  console.log('Text content preview:', (element.textContent || '').slice(0, 100));
  console.groupEnd();
}

function dumpInputCandidates() {
  console.group('[Claude Bridge] DOM Scan - Input Field Candidates');
  
  const selectors = [
    '[contenteditable="true"]',
    '[data-placeholder]',
    '.ProseMirror',
    'textarea',
    '[role="textbox"]',
    '[data-testid*="input"]',
    '[data-testid*="composer"]',
  ];
  
  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    if (elements.length > 0) {
      console.log(`\n${selector}: ${elements.length} found`);
      elements.forEach((el, i) => {
        console.log(`  [${i}] <${el.tagName.toLowerCase()}> class="${el.className}" id="${el.id}"`);
      });
    }
  }
  
  console.groupEnd();
}

function dumpDropTargets() {
  console.group('[Claude Bridge] DOM Scan - Drop Zone Candidates');
  
  const selectors = [
    '[data-drop-target]',
    '[data-testid*="drop"]',
    '.drop-zone',
    'main',
    '[role="main"]',
    'form',
  ];
  
  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    if (elements.length > 0) {
      console.log(`\n${selector}: ${elements.length} found`);
      elements.forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        console.log(`  [${i}] <${el.tagName.toLowerCase()}> class="${el.className}" size=${rect.width}x${rect.height}`);
      });
    }
  }
  
  console.groupEnd();
}

function dumpButtonCandidates() {
  console.group('[Claude Bridge] DOM Scan - Send Button Candidates');
  
  const selectors = [
    'button[type="submit"]',
    'button[aria-label*="send" i]',
    'button[aria-label*="Send" i]',
    'button[data-testid*="send"]',
    '[role="button"]',
  ];
  
  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    if (elements.length > 0) {
      console.log(`\n${selector}: ${elements.length} found`);
      elements.forEach((el, i) => {
        console.log(`  [${i}] <${el.tagName.toLowerCase()}> aria-label="${el.getAttribute('aria-label')}" disabled=${el.disabled} text="${(el.textContent || '').slice(0, 30)}"`);
      });
    }
  }
  
  console.groupEnd();
}

function dumpFileInputs() {
  console.group('[Claude Bridge] DOM Scan - File Input Candidates');
  
  const inputs = document.querySelectorAll('input[type="file"]');
  console.log(`Found ${inputs.length} file inputs:`);
  
  inputs.forEach((el, i) => {
    console.log(`  [${i}] accept="${el.accept}" multiple=${el.multiple} hidden=${el.hidden} style.display="${el.style.display}"`);
    console.log(`       parent: <${el.parentElement?.tagName.toLowerCase()}> class="${el.parentElement?.className}"`);
  });
  
  console.groupEnd();
}

function fullDOMDump() {
  console.log('\n========== CLAUDE BRIDGE FULL DOM SCAN ==========\n');
  dumpInputCandidates();
  dumpDropTargets();
  dumpButtonCandidates();
  dumpFileInputs();
  console.log('\n========== END DOM SCAN ==========\n');
}


// --- Initialization ---

function init() {
  debug('Content script loaded');
  debug('URL:', window.location.href);
  debug('Document ready state:', document.readyState);
  
  // Wait for page to be fully loaded before DOM dump
  if (document.readyState === 'complete') {
    setTimeout(fullDOMDump, 1000);  // Give React time to hydrate
  } else {
    window.addEventListener('load', () => {
      setTimeout(fullDOMDump, 1000);
    });
  }
  
  // Connect to background script
  connectToBackground();
  
  // Watch for page navigation (SPA)
  observePageChanges();
  
  // Listen for direct messages (fallback)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    debug('Direct message received:', message.type);
    handleMessage(message);
    sendResponse({ received: true });
    return true;
  });
  
  // Expose debug functions - store references for injection
  const debugAPI = {
    dumpDOM: fullDOMDump,
    dumpInputs: dumpInputCandidates,
    dumpDrops: dumpDropTargets,
    dumpButtons: dumpButtonCandidates,
    dumpFiles: dumpFileInputs,
    testInject: (text) => injectText(text || 'Test message from Claude Bridge'),
    testFile: () => {
      const testData = btoa('Hello from Claude Bridge test file');
      attachFile(testData, 'test.txt', 'text/plain');
    },
    getInput: getInputField,
    getSend: getSendButton,
    getDrop: getDropZone,
    queue: pendingAttachments,
    config: CONFIG,
  };
  
  // Store in content script's window for internal use
  window.__claudeBridgeInternal = debugAPI;
  
  // Inject into page's main world for console access via external script (CSP-safe)
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  script.onload = () => script.remove();
  document.documentElement.appendChild(script);
  
  // Listen for commands from main world
  window.addEventListener('__claudeBridgeCommand', (e) => {
    const { cmd, args } = e.detail;
    debug('Command from console:', cmd, args);
    if (cmd === 'testInject') debugAPI.testInject(args[0]);
    else if (cmd === 'testFile') debugAPI.testFile();
    else if (cmd === 'dumpDOM') debugAPI.dumpDOM();
    else if (cmd === 'voice') {
      if (args[0] === undefined) TTS.toggle();
      else TTS.enabled = !!args[0];
    }
  });
  
  debug('Debug functions exposed as window.__claudeBridge');
  debug('Try: __claudeBridge.testInject("hello")');
}


function connectToBackground() {
  debug('Connecting to background script...');
  port = chrome.runtime.connect({ name: 'claude-bridge' });
  
  port.onMessage.addListener((message) => {
    if (message.type === 'status') {
      isConnected = message.connected;
      debug('Server connection status:', isConnected ? 'connected' : 'disconnected');
    } else {
      debug('Message from background:', message.type, message.sender || '');
      handleMessage(message);
    }
  });
  
  port.onDisconnect.addListener(() => {
    debug('Background disconnected, reconnecting in 1s...');
    setTimeout(connectToBackground, 1000);
  });
  
  debug('Background connection established');
}


// --- Message Handling ---

function handleMessage(message) {
  if (message.type !== 'message') {
    debug('Ignoring non-message:', message.type);
    return;
  }
  
  debug('=== INCOMING MESSAGE ===');
  debug('From:', message.sender);
  debug('Type:', message.content_type);
  debug('Has text:', !!message.text);
  debug('Has file:', !!message.file_data);
  debug('Has caption:', !!message.caption);
  
  // Add to queue
  messageQueue.push(message);
  debug('Queue length:', messageQueue.length);
  
  // Process queue
  processQueue();
}


async function processQueue() {
  if (isProcessing || messageQueue.length === 0) return;
  
  isProcessing = true;
  debug('Processing queue...');
  
  while (messageQueue.length > 0) {
    const message = messageQueue.shift();
    
    try {
      await processMessage(message);
    } catch (err) {
      debug('ERROR processing message:', err.message);
      console.error('[Claude Bridge] Error processing message:', err);
      showToast(`Error: ${err.message}`, 'error');
    }
    
    // Small delay between messages
    await sleep(300);
  }
  
  isProcessing = false;
  debug('Queue processing complete');
}


async function processMessage(message) {
  const { sender, content_type, text, caption, file_data, file_name, mime_type } = message;
  
  debug('Processing message:', { sender, content_type, hasText: !!text, hasFile: !!file_data });
  
  // Handle files - attach immediately so upload starts right away
  if (file_data && ['file', 'image', 'voice_audio'].includes(content_type)) {
    debug('File received, attaching immediately');
    await attachFile(file_data, file_name, mime_type);
    showToast(`📎 ${sender} attached: ${file_name}`);
    
    // If there's a caption, inject it as text and send
    if (caption) {
      const textContent = CONFIG.attributionPrefix
        ? `[${sender}]: ${caption}`
        : caption;
      
      await injectText(textContent);
      showToast(`💬 ${sender}: ${caption.slice(0, 50)}...`);
      
      if (CONFIG.autoSend) {
        debug(`Auto-send enabled, clicking send after ${CONFIG.attachmentDelay}ms delay`);
        await sleep(CONFIG.attachmentDelay);
        clickSend();
      }
    }
    // No caption = file only, don't send yet, wait for text
    return;
  }
  
  // Text message - just inject and send
  if (content_type === 'text' || content_type === 'voice_transcribed') {
    const textContent = CONFIG.attributionPrefix 
      ? `[${sender}]: ${text}`
      : text;
    
    await injectText(textContent);
    showToast(`💬 ${sender}: ${text.slice(0, 50)}...`);
    
    if (CONFIG.autoSend) {
      debug(`Auto-send enabled, clicking send after ${CONFIG.messageDelay}ms delay`);
      await sleep(CONFIG.messageDelay);
      clickSend();
    }
  }
}


// --- DOM Manipulation ---

function getInputField() {
  // Claude's input field - may need adjustment if UI changes
  const selectors = [
    '[contenteditable="true"][data-placeholder]',
    'div[contenteditable="true"].ProseMirror',
    'div.ProseMirror[contenteditable="true"]',
    '[data-testid="composer-input"]',
    '[contenteditable="true"]',  // fallback - any contenteditable
  ];
  
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) {
      debug(`Input field found with selector: ${selector}`);
      debugDOM('Input Field', el);
      return el;
    }
  }
  
  debug('ERROR: Could not find input field with any selector');
  dumpInputCandidates();
  return null;
}


function getSendButton() {
  // Send button selectors
  const selectors = [
    'button[aria-label="Send message"]',
    'button[aria-label="Send Message"]',
    'button[data-testid="send-button"]',
    'button:has(svg[data-icon="arrow-up"])',
    'form button[type="submit"]',
    'button[type="submit"]',
  ];
  
  for (const selector of selectors) {
    try {
      const el = document.querySelector(selector);
      if (el && !el.disabled) {
        debug(`Send button found with selector: ${selector}`);
        debugDOM('Send Button', el);
        return el;
      }
    } catch (e) {
      // :has() selector might not be supported
      debug(`Selector failed: ${selector}`, e.message);
    }
  }
  
  debug('WARNING: Send button not found or disabled');
  dumpButtonCandidates();
  return null;
}


function getDropZone() {
  // The area that accepts file drops
  const selectors = [
    '[data-drop-target="true"]',
    '[data-testid="drop-zone"]',
    '.drop-zone',
    'form',
    'main',  // fallback to main content area
  ];
  
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) {
      debug(`Drop zone found with selector: ${selector}`);
      debugDOM('Drop Zone', el);
      return el;
    }
  }
  
  debug('WARNING: No specific drop zone found, using document.body');
  return document.body;
}


function getFileInput() {
  // Look for hidden file input that might be used for uploads
  const inputs = document.querySelectorAll('input[type="file"]');
  
  debug(`Found ${inputs.length} file input(s)`);
  
  for (const input of inputs) {
    debugDOM('File Input', input);
    // Return the first one that's not disabled
    if (!input.disabled) {
      return input;
    }
  }
  
  return inputs[0] || null;
}


async function injectText(text) {
  debug('=== TEXT INJECTION START ===');
  debug('Text to inject:', text.slice(0, 100) + (text.length > 100 ? '...' : ''));
  
  const input = getInputField();
  if (!input) {
    throw new Error('Input field not found');
  }
  
  // Focus the input
  debug('Focusing input...');
  input.focus();
  
  // Log current state
  debug('Input state before:', {
    textContent: (input.textContent || '').slice(0, 50),
    innerHTML: (input.innerHTML || '').slice(0, 100),
    value: input.value,
  });
  
  // For contenteditable divs (ProseMirror), we need to work with the selection
  const selection = window.getSelection();
  const range = document.createRange();
  
  // Clear existing content if any, or append
  const existingText = input.textContent || '';
  const newText = existingText ? `${existingText}\n${text}` : text;
  
  debug('Setting textContent...');
  input.textContent = newText;
  
  // Move cursor to end
  range.selectNodeContents(input);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  
  // Try multiple event types to trigger React
  const events = [
    new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    }),
    new Event('input', { bubbles: true }),
    new Event('change', { bubbles: true }),
    new KeyboardEvent('keydown', { bubbles: true, key: 'a' }),
    new KeyboardEvent('keyup', { bubbles: true, key: 'a' }),
  ];
  
  for (const event of events) {
    debug(`Dispatching ${event.type} event...`);
    input.dispatchEvent(event);
  }
  
  // Log state after
  debug('Input state after:', {
    textContent: (input.textContent || '').slice(0, 50),
    innerHTML: (input.innerHTML || '').slice(0, 100),
  });
  
  debug('=== TEXT INJECTION COMPLETE ===');
}


async function attachFile(base64Data, filename, mimeType) {
  debug('=== FILE ATTACHMENT START ===');
  debug('File:', filename, 'Type:', mimeType, 'Size:', base64Data.length, 'chars base64');
  
  // Decode base64 to binary
  let bytes;
  try {
    const binaryString = atob(base64Data);
    bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    debug('Decoded to', bytes.length, 'bytes');
  } catch (e) {
    debug('ERROR: Base64 decode failed:', e.message);
    throw e;
  }
  
  // Create File object
  const file = new File([bytes], filename, { type: mimeType });
  debug('Created File object:', { name: file.name, size: file.size, type: file.type });
  
  // Try Method 1: DataTransfer drag-and-drop
  debug('--- Trying Method 1: Drag-and-drop ---');
  try {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    debug('DataTransfer created with', dataTransfer.files.length, 'file(s)');
    
    const dropZone = getDropZone();
    
    const eventProps = {
      bubbles: true,
      cancelable: true,
      dataTransfer: dataTransfer,
    };
    
    debug('Dispatching dragenter...');
    dropZone.dispatchEvent(new DragEvent('dragenter', eventProps));
    await sleep(50);
    
    debug('Dispatching dragover...');
    dropZone.dispatchEvent(new DragEvent('dragover', eventProps));
    await sleep(50);
    
    debug('Dispatching drop...');
    const dropResult = dropZone.dispatchEvent(new DragEvent('drop', eventProps));
    debug('Drop event result (not cancelled):', dropResult);
    
  } catch (e) {
    debug('Method 1 failed:', e.message);
  }
  
  // Try Method 2: Hidden file input
  debug('--- Trying Method 2: File input ---');
  try {
    const fileInput = getFileInput();
    if (fileInput) {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInput.files = dataTransfer.files;
      debug('Set files on input, dispatching change...');
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      fileInput.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      debug('No file input found');
    }
  } catch (e) {
    debug('Method 2 failed:', e.message);
  }
  
  debug('=== FILE ATTACHMENT COMPLETE ===');
  await sleep(200);
}


function clickSend() {
  debug('=== SEND BUTTON CLICK ===');
  const button = getSendButton();
  if (button) {
    debug('Clicking send button...');
    button.click();
    debug('Send clicked');
    return true;
  }
  debug('ERROR: Send button not found or disabled');
  return false;
}


// --- UI Feedback ---

function showToast(message, type = 'info') {
  if (!CONFIG.showNotifications) return;
  
  // Remove existing toast
  const existing = document.getElementById('claude-bridge-toast');
  if (existing) existing.remove();
  
  const toast = document.createElement('div');
  toast.id = 'claude-bridge-toast';
  toast.textContent = message;
  
  const colors = {
    info: { bg: '#1e40af', text: '#fff' },
    success: { bg: '#15803d', text: '#fff' },
    error: { bg: '#b91c1c', text: '#fff' },
  };
  const color = colors[type] || colors.info;
  
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '80px',
    right: '20px',
    backgroundColor: color.bg,
    color: color.text,
    padding: '12px 20px',
    borderRadius: '8px',
    fontSize: '14px',
    fontFamily: 'system-ui, sans-serif',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    zIndex: '99999',
    maxWidth: '400px',
    wordWrap: 'break-word',
    opacity: '0',
    transform: 'translateY(10px)',
    transition: 'opacity 0.2s, transform 0.2s',
  });
  
  document.body.appendChild(toast);
  
  // Animate in
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });
  
  // Remove after delay
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 200);
  }, 4000);
}


// --- Utilities ---

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


function observePageChanges() {
  // Re-initialize on SPA navigation
  const observer = new MutationObserver((mutations) => {
    // Could add logic here to detect when Claude's UI resets
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}


// --- Attachment Accumulation ---

// Accumulated files waiting to be sent with next text message
const pendingAttachments = [];

async function accumulateAttachment(base64Data, filename, mimeType, sender) {
  pendingAttachments.push({ base64Data, filename, mimeType, sender });
  debug(`Attachment queued: ${filename} from ${sender}`);
  debug(`Pending attachments: ${pendingAttachments.length}`);
  debug('Queue contents:', pendingAttachments.map(a => a.filename));
  showToast(`📎 Queued: ${filename} from ${sender} (${pendingAttachments.length} pending)`);
}

async function flushAttachments() {
  // Attach all pending files
  if (pendingAttachments.length === 0) {
    debug('No attachments to flush');
    return 0;
  }
  
  debug(`=== FLUSHING ${pendingAttachments.length} ATTACHMENTS ===`);
  
  for (let i = 0; i < pendingAttachments.length; i++) {
    const att = pendingAttachments[i];
    debug(`Attaching [${i + 1}/${pendingAttachments.length}]: ${att.filename}`);
    await attachFile(att.base64Data, att.filename, att.mimeType);
    await sleep(200); // Small delay between attachments
  }
  
  // Clear the queue
  const count = pendingAttachments.length;
  pendingAttachments.length = 0;
  
  debug(`Flush complete, attached ${count} files`);
  return count;
}


// --- Text-to-Speech for Claude's responses ---

const TTS = {
  enabled: false,  // Start disabled - needs user gesture to unlock
  speaking: false,
  lastSpokenLength: 0,
  observer: null,
  voiceName: null,
  rate: 1.0,
  pitch: 1.0,
  unlocked: false,  // Track if we've had a user gesture
  
  init() {
    // Find a good voice (prefer English female voices)
    const voices = speechSynthesis.getVoices();
    const preferred = voices.find(v => 
      v.name.includes('Microsoft Zira') ||  // Windows
      v.name.includes('Google UK English Female') ||
      v.name.includes('Samantha') ||  // macOS
      v.name.includes('Female')
    );
    if (preferred) {
      this.voiceName = preferred.name;
      debug('TTS: Selected voice:', preferred.name);
    }
    
    // Watch for Claude's responses
    this.startObserving();
    debug('TTS: Initialized');
  },
  
  startObserving() {
    this.pendingText = '';
    this.speakTimeout = null;
    this.lastStreamingElement = null;  // Track the actual element
    
    this.observer = new MutationObserver((mutations) => {
      if (!this.enabled) return;
      
      // Find streaming response
      const streaming = document.querySelector('[data-is-streaming="true"]');
      
      if (streaming) {
        const progressive = streaming.querySelector('.progressive-markdown');
        
        // Check if this is a NEW streaming element (new response)
        if (streaming !== this.lastStreamingElement) {
          debug('TTS: New streaming response detected, resetting');
          this.lastSpokenLength = 0;
          this.pendingText = '';
          if (this.speakTimeout) {
            clearTimeout(this.speakTimeout);
            this.speakTimeout = null;
          }
          this.lastStreamingElement = streaming;
        }
        
        if (progressive) {
          this.processResponseElement(progressive);
        }
        return;
      }
      
      // No streaming - clear the reference so next stream is detected as new
      if (this.lastStreamingElement) {
        this.lastStreamingElement = null;
      }
      
      // Completed responses
      const responses = document.querySelectorAll('[data-is-streaming="false"] .font-claude-response');
      if (responses.length > 0) {
        const latest = responses[responses.length - 1];
        const text = latest.innerText || '';
        if (text.length > this.lastSpokenLength) {
          this.processResponseElement(latest);
        }
      }
    });
    
    const target = document.body;
    this.observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: true
    });
  },
  
  processResponseElement(element) {
    // Get only the actual response paragraphs, not the thinking block
    // The thinking block is inside a collapsed container with height: 0px
    // Actual response is in .progressive-markdown > div > .standard-markdown
    let text = '';
    
    // During streaming, get from progressive-markdown's standard-markdown children
    const markdownBlocks = element.querySelectorAll(':scope > div > .standard-markdown .font-claude-response-body');
    if (markdownBlocks.length > 0) {
      text = Array.from(markdownBlocks).map(el => el.innerText || el.textContent).join(' ');
    } else {
      // Fallback for completed responses - skip the collapsed thinking section
      const allBodies = element.querySelectorAll('.font-claude-response-body');
      const visibleBodies = Array.from(allBodies).filter(el => {
        // Check if any ancestor has height: 0px (collapsed thinking block)
        let parent = el.parentElement;
        while (parent && parent !== element) {
          if (parent.style.height === '0px' || parent.style.opacity === '0') {
            return false;
          }
          parent = parent.parentElement;
        }
        return true;
      });
      text = visibleBodies.map(el => el.innerText || el.textContent).join(' ');
    }
    
    text = text.replace(/\s+/g, ' ').trim();
    
    if (text.length > this.lastSpokenLength) {
      const newText = text.slice(this.lastSpokenLength);
      this.lastSpokenLength = text.length;
      
      this.pendingText += newText;
      
      if (this.speakTimeout) {
        clearTimeout(this.speakTimeout);
      }
      
      this.speakTimeout = setTimeout(() => {
        if (this.pendingText.trim()) {
          this.speak(this.pendingText);
          this.pendingText = '';
        }
      }, 800);
    }
  },
  
  speak(text) {
    if (!text.trim()) return;
    if (!this.unlocked) {
      debug('TTS: blocked - needs user gesture (Ctrl+Shift+V to enable)');
      return;
    }
    
    // Cancel any queued speech to avoid buildup
    speechSynthesis.cancel();
    
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = this.rate;
    utterance.pitch = this.pitch;
    
    // Detect language and pick appropriate voice
    const voice = this.pickVoiceForText(text);
    if (voice) {
      utterance.voice = voice;
      debug('TTS: using voice', voice.name, 'lang', voice.lang);
    }
    
    utterance.onstart = () => { this.speaking = true; };
    utterance.onend = () => { this.speaking = false; };
    utterance.onerror = (e) => { 
      debug('TTS error:', e.error);
      this.speaking = false; 
    };
    
    debug('TTS: speaking', text.length, 'chars');
    speechSynthesis.speak(utterance);
  },
  
  pickVoiceForText(text) {
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return null;
    
    // Count characters for each configured language
    const counts = TTS_LANGUAGES.map(lang => ({
      ...lang,
      count: (text.match(lang.pattern) || []).length
    }));
    
    // Find the dominant non-default language
    const nonDefault = counts.filter(l => !l.isDefault && l.count > 0);
    const defaultLang = counts.find(l => l.isDefault);
    
    // Determine which language won
    let detected;
    if (nonDefault.length > 0) {
      // Pick the non-default language with most matches
      const topNonDefault = nonDefault.reduce((a, b) => a.count > b.count ? a : b);
      // Only use it if it beats the default count
      if (!defaultLang || topNonDefault.count > (defaultLang.count || 0)) {
        detected = topNonDefault;
      } else {
        detected = defaultLang;
      }
    } else {
      detected = defaultLang || counts[0];
    }
    
    debug('TTS: detected', detected.name, `(${detected.count} chars)`);
    
    // Helper: prefer Google voices
    const preferGoogle = (voiceList) => {
      return voiceList.find(v => v.name.toLowerCase().includes('google'))
          || voiceList[0];
    };
    
    // Find voices matching the detected language
    const matchingVoices = voices.filter(v => v.lang.startsWith(detected.langPrefix));
    if (matchingVoices.length) {
      debug('TTS:', detected.name, 'voices available:', matchingVoices.map(v => v.name).join(', '));
      return preferGoogle(matchingVoices);
    }
    
    debug('TTS: no', detected.name, 'voice found, falling back');
    
    // Fallback to English
    const enVoices = voices.filter(v => v.lang.startsWith('en'));
    if (enVoices.length) {
      return preferGoogle(enVoices);
    }
    
    return voices[0];
  },
  
  toggle() {
    this.unlocked = true;  // User gesture unlocks audio
    this.enabled = !this.enabled;
    debug('TTS:', this.enabled ? 'enabled' : 'disabled');
    
    if (!this.enabled) {
      speechSynthesis.cancel();
      this.speaking = false;
    } else {
      // Mark current content as "already spoken" so we only catch NEW responses
      const streaming = document.querySelector('[data-is-streaming="true"]');
      if (streaming) {
        const progressive = streaming.querySelector('.progressive-markdown');
        if (progressive) {
          const text = progressive.innerText || '';
          this.lastSpokenLength = text.length;
          this.lastStreamingElement = streaming;
        }
      } else {
        // No streaming - mark all existing content as read
        const responses = document.querySelectorAll('.font-claude-response');
        if (responses.length > 0) {
          const latest = responses[responses.length - 1];
          this.lastSpokenLength = (latest.innerText || '').length;
        }
      }
      
      // Confirmation sound
      const test = new SpeechSynthesisUtterance('Voice enabled');
      test.volume = 0.5;
      speechSynthesis.speak(test);
    }
    
    this.pendingText = '';
    showToast(`🔊 Voice ${this.enabled ? 'ON' : 'OFF'}`, this.enabled ? 'success' : 'info');
    return this.enabled;
  },
  
  stop() {
    speechSynthesis.cancel();
    this.speaking = false;
    this.lastSpokenLength = 0;
  },
  
  // Reset when navigating to new chat
  reset() {
    this.stop();
    this.lastSpokenLength = 0;
  }
};

// Initialize TTS after a short delay (voices need to load)
setTimeout(() => {
  // Voices may load asynchronously
  if (speechSynthesis.getVoices().length === 0) {
    speechSynthesis.onvoiceschanged = () => TTS.init();
  } else {
    TTS.init();
  }
}, 1000);

// Keyboard shortcut: Ctrl+Shift+V to toggle TTS
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'V') {
    e.preventDefault();
    TTS.toggle();
  }
});

// Reset TTS on navigation
window.addEventListener('popstate', () => TTS.reset());


// --- Start ---

init();
