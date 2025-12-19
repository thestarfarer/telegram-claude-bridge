// Injected into page's main world for console access
window.__claudeBridge = {
  testInject: (text) => {
    window.dispatchEvent(new CustomEvent('__claudeBridgeCommand', { 
      detail: { cmd: 'testInject', args: [text || 'Test message'] }
    }));
  },
  testFile: () => {
    window.dispatchEvent(new CustomEvent('__claudeBridgeCommand', { 
      detail: { cmd: 'testFile', args: [] }
    }));
  },
  dumpDOM: () => {
    window.dispatchEvent(new CustomEvent('__claudeBridgeCommand', { 
      detail: { cmd: 'dumpDOM', args: [] }
    }));
  },
  voice: (state) => {
    window.dispatchEvent(new CustomEvent('__claudeBridgeCommand', { 
      detail: { cmd: 'voice', args: [state] }
    }));
  },
  help: () => {
    console.log('Claude Bridge Commands:');
    console.log('  __claudeBridge.testInject("text") - Inject text into input');
    console.log('  __claudeBridge.testFile() - Attach a test file');
    console.log('  __claudeBridge.dumpDOM() - Scan DOM for elements');
    console.log('  __claudeBridge.voice() - Toggle TTS on/off');
    console.log('  __claudeBridge.voice(true/false) - Set TTS state');
    console.log('');
    console.log('Keyboard: Ctrl+Shift+V to toggle voice');
  }
};
console.log('[Claude Bridge] Debug API ready. Type __claudeBridge.help() for commands.');
