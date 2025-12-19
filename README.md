# Telegram → Claude Web Bridge

Control Claude's web interface from Telegram. Voice in, voice out, full artifacts and projects support.

<!-- TODO: Add demo GIF here -->
<!-- ![Demo](demo.gif) -->

## Why This Exists

API-based Claude bots give you text in, text out. That's it.

This bridge connects to **claude.ai** — the actual web interface. You get:

- **Full web features** — artifacts, projects, file handling, visual outputs
- **Voice I/O** — speak to Claude, hear responses in 8 languages
- **Group collaboration** — multiple people control one Claude session from their phones

## The Setup That Actually Matters

Put Claude on a big screen. Connect a Telegram group. Now your whole team can:

1. Send questions from their phones
2. Upload documents, images, spreadsheets
3. Watch Claude analyze and build artifacts in real-time
4. Hear answers spoken aloud

Preload meeting materials into a Claude project. Let people ask questions without fighting over a keyboard. Claude responds out loud. Works well for workshops, demos, or hands-free personal use.

## How It Works

```
Telegram  →  Bridge Server  →  Chrome Extension  →  claude.ai
(phone)      (your machine)    (injects messages)   (does the work)
```

The extension watches for Claude's responses and speaks them via TTS with automatic language detection.

## Quick Start

### 1. Telegram Bot

```bash
# Message @BotFather on Telegram
/newbot           # Create bot, save the token
/setprivacy       # Set to DISABLED (sees group messages)
```

### 2. Server

```bash
cd server
pip install -r requirements.txt
cp config.example.py config.py
# Edit config.py: add TELEGRAM_BOT_TOKEN
python main.py
```

### 3. Chrome Extension

1. `chrome://extensions` → Enable "Developer mode"
2. "Load unpacked" → select `extension/` folder
3. Open [claude.ai](https://claude.ai), log in
4. Extension icon shows "Connected"

### 4. Test It

Send a message to your Telegram bot. It should appear in Claude's input and auto-send.

Press **Ctrl+Shift+V** to enable voice output.

## Features

| Feature | Details |
|---------|---------|
| Text messages | With sender attribution `[Name]: message` |
| File attachments | Images, PDFs, docs, spreadsheets, audio |
| Voice messages | Transcribed via Whisper (optional) or sent as audio |
| TTS responses | Auto-detects language, switches voice accordingly |
| Chat filtering | Whitelist specific Telegram chats |

### Supported Languages (TTS)

English, German, French, Chinese, Japanese, Korean, Arabic, Russian — detected automatically from response content.

## Configuration

**Server** (`config.py`):

```python
TELEGRAM_BOT_TOKEN = "your_token"
ALLOWED_CHAT_IDS = []           # Empty = allow all, or [-1001234567890]
WHISPER_MODEL_SIZE = "medium"   # For voice transcription (optional)
```

**Extension** (`content.js` CONFIG):

```javascript
autoSend: true,          // Auto-submit messages
messageDelay: 500,       // ms before sending
attributionPrefix: true, // Show [Sender]: prefix
```

## Voice Output

TTS is off by default (browsers require user interaction to enable audio).

| Command | Effect |
|---------|--------|
| `Ctrl+Shift+V` | Toggle voice on/off |
| `__claudeBridge.voice()` | Toggle from console |

## Debugging

Open DevTools on claude.ai:

```javascript
__claudeBridge.help()           // List all commands
__claudeBridge.testInject("hi") // Test text injection
__claudeBridge.voice()          // Toggle TTS
```

## Requirements

- Python 3.8+
- Chrome/Chromium
- Telegram bot token (free from @BotFather)
- Claude account with claude.ai access

## What This Isn't

- Not a Claude API wrapper — connects to the web UI directly
- Not standalone — requires a browser running claude.ai
- Not affiliated with Anthropic

## License

MIT
