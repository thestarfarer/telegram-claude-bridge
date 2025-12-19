"""
Telegram → Claude Bridge Server

Polls Telegram for updates, forwards to connected Chrome extension via WebSocket.
Optionally transcribes voice messages using local Whisper.

No public IP needed - works behind NAT, firewalls, whatever.
"""

import os
import json
import base64
import asyncio
from typing import Optional
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware


# --- Configuration (config.py > environment variables > defaults) ---

try:
    from config import *
    print("Loaded config from config.py")
except ImportError:
    print("No config.py found, using environment variables")
    TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    ALLOWED_CHAT_IDS = []
    POLL_TIMEOUT = 30
    WHISPER_MODEL_SIZE = "medium"
    WHISPER_COMPUTE_TYPE = "int8"
    WHISPER_DEVICE = "cpu"

# Allow env vars to override config file
if os.environ.get("TELEGRAM_BOT_TOKEN"):
    TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]

if os.environ.get("ALLOWED_CHAT_IDS"):
    ALLOWED_CHAT_IDS = [int(x.strip()) for x in os.environ["ALLOWED_CHAT_IDS"].split(",") if x.strip()]

# Convert to set for fast lookup
ALLOWED_CHATS = set(ALLOWED_CHAT_IDS) if ALLOWED_CHAT_IDS else set()

TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"


# --- Optional: Whisper for voice transcription ---

try:
    from faster_whisper import WhisperModel
    WHISPER_MODEL = WhisperModel(
        WHISPER_MODEL_SIZE, 
        device=WHISPER_DEVICE, 
        compute_type=WHISPER_COMPUTE_TYPE
    )
    WHISPER_AVAILABLE = True
    print(f"faster-whisper loaded ({WHISPER_MODEL_SIZE}, {WHISPER_COMPUTE_TYPE}, {WHISPER_DEVICE})")
except ImportError:
    WHISPER_MODEL = None
    WHISPER_AVAILABLE = False
except Exception as e:
    print(f"Whisper init failed: {e}")
    WHISPER_MODEL = None
    WHISPER_AVAILABLE = False


# --- State ---

class ConnectionManager:
    """Manages WebSocket connections to Chrome extension(s)."""
    
    def __init__(self):
        self.active_connections: list[WebSocket] = []
    
    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        print(f"Extension connected. Total: {len(self.active_connections)}")
    
    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        print(f"Extension disconnected. Total: {len(self.active_connections)}")
    
    async def broadcast(self, message: dict):
        """Send to all connected extensions."""
        if not self.active_connections:
            print("Warning: No extensions connected, message dropped")
            return
            
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception as e:
                print(f"Failed to send to extension: {e}")
                disconnected.append(connection)
        
        for conn in disconnected:
            if conn in self.active_connections:
                self.active_connections.remove(conn)


manager = ConnectionManager()


# --- Telegram helpers ---

async def get_file_url(file_id: str, client: httpx.AsyncClient) -> Optional[str]:
    """Get download URL for a Telegram file."""
    resp = await client.get(f"{TELEGRAM_API}/getFile", params={"file_id": file_id})
    data = resp.json()
    if data.get("ok"):
        file_path = data["result"]["file_path"]
        return f"https://api.telegram.org/file/bot{TELEGRAM_BOT_TOKEN}/{file_path}"
    return None


async def download_file(url: str, client: httpx.AsyncClient) -> bytes:
    """Download file content from Telegram."""
    resp = await client.get(url)
    return resp.content


async def transcribe_voice(audio_data: bytes, file_ext: str = "ogg") -> str:
    """Transcribe audio using faster-whisper. Falls back to [voice message] if unavailable."""
    if not WHISPER_AVAILABLE:
        return "[Voice message - Whisper not installed]"
    
    # Write temp file (Whisper needs file path)
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=f".{file_ext}", delete=False) as f:
        f.write(audio_data)
        temp_path = f.name
    
    try:
        # faster-whisper returns segments iterator
        segments, info = WHISPER_MODEL.transcribe(temp_path)
        text = " ".join(segment.text.strip() for segment in segments)
        print(f"Transcribed {info.duration:.1f}s audio (language: {info.language})")
        return text.strip() or "[Empty transcription]"
    except Exception as e:
        print(f"Transcription error: {e}")
        return f"[Transcription failed: {e}]"
    finally:
        os.unlink(temp_path)


def get_sender_name(message: dict) -> str:
    """Extract sender name from Telegram message."""
    sender = message.get("from", {})
    first = sender.get("first_name", "")
    last = sender.get("last_name", "")
    username = sender.get("username", "")
    
    if first or last:
        return f"{first} {last}".strip()
    return username or "Anonymous"


# --- Message Processing ---

async def process_telegram_message(message: dict, client: httpx.AsyncClient):
    """Process a single Telegram message and broadcast to extensions."""
    
    sender = get_sender_name(message)
    chat_id = message.get("chat", {}).get("id")
    
    # Filter by allowed chat IDs if configured
    if ALLOWED_CHATS and chat_id not in ALLOWED_CHATS:
        print(f"Ignoring message from chat {chat_id} (not in allowed list)")
        return
    
    print(f"Processing message from {sender} in chat {chat_id}")
    
    # Build payload for extension
    payload = {
        "type": "message",
        "sender": sender,
        "chat_id": chat_id,
        "message_id": message.get("message_id"),
        "timestamp": message.get("date"),
    }
    
    # Handle different message types
    
    if "text" in message:
        payload["content_type"] = "text"
        payload["text"] = message["text"]
        print(f"  Text: {message['text'][:50]}...")
    
    elif "voice" in message:
        # Voice message - download and transcribe
        voice = message["voice"]
        file_url = await get_file_url(voice["file_id"], client)
        if file_url:
            print(f"  Voice message, downloading...")
            audio_data = await download_file(file_url, client)
            
            # Transcribe or send as audio
            if WHISPER_AVAILABLE:
                print(f"  Transcribing...")
                transcription = await transcribe_voice(audio_data, "ogg")
                payload["content_type"] = "voice_transcribed"
                payload["text"] = transcription
                print(f"  Transcription: {transcription[:50]}...")
            else:
                payload["content_type"] = "voice_audio"
                payload["file_data"] = base64.b64encode(audio_data).decode()
                payload["file_name"] = f"voice_{message['message_id']}.ogg"
                payload["mime_type"] = "audio/ogg"
    
    elif "audio" in message:
        # Audio file (mp3, etc) - different from voice notes
        audio = message["audio"]
        file_url = await get_file_url(audio["file_id"], client)
        if file_url:
            title = audio.get("title", "audio")
            performer = audio.get("performer", "")
            print(f"  Audio: {performer} - {title}" if performer else f"  Audio: {title}")
            file_data = await download_file(file_url, client)
            payload["content_type"] = "file"
            payload["file_data"] = base64.b64encode(file_data).decode()
            # Use title/performer for filename if available
            ext = audio.get("mime_type", "audio/mpeg").split("/")[-1]
            if performer and title:
                payload["file_name"] = f"{performer} - {title}.{ext}"
            else:
                payload["file_name"] = audio.get("file_name", f"audio_{message['message_id']}.{ext}")
            payload["mime_type"] = audio.get("mime_type", "audio/mpeg")
    
    elif "document" in message:
        # File attachment
        doc = message["document"]
        file_url = await get_file_url(doc["file_id"], client)
        if file_url:
            print(f"  Document: {doc.get('file_name', 'unknown')}")
            file_data = await download_file(file_url, client)
            payload["content_type"] = "file"
            payload["file_data"] = base64.b64encode(file_data).decode()
            payload["file_name"] = doc.get("file_name", f"file_{message['message_id']}")
            payload["mime_type"] = doc.get("mime_type", "application/octet-stream")
    
    elif "photo" in message:
        # Photo - get largest size
        photo = message["photo"][-1]  # Last element is largest
        file_url = await get_file_url(photo["file_id"], client)
        if file_url:
            print(f"  Photo")
            file_data = await download_file(file_url, client)
            payload["content_type"] = "image"
            payload["file_data"] = base64.b64encode(file_data).decode()
            payload["file_name"] = f"photo_{message['message_id']}.jpg"
            payload["mime_type"] = "image/jpeg"
    
    else:
        # Unsupported message type
        payload["content_type"] = "unsupported"
        payload["text"] = "[Unsupported message type]"
        print(f"  Unsupported message type")
    
    # Include caption if present (for photos/docs with captions)
    if "caption" in message:
        payload["caption"] = message["caption"]
        print(f"  Caption: {message['caption'][:50]}...")
    
    # Broadcast to all connected extensions
    await manager.broadcast(payload)


# --- Telegram Polling ---

async def poll_telegram():
    """Long-poll Telegram for updates. Runs forever."""
    
    if not TELEGRAM_BOT_TOKEN:
        print("ERROR: TELEGRAM_BOT_TOKEN not set! Polling disabled.")
        return
    
    offset = 0  # Track which updates we've seen
    
    print(f"Starting Telegram polling (timeout={POLL_TIMEOUT}s)...")
    
    async with httpx.AsyncClient(timeout=POLL_TIMEOUT + 10) as client:
        while True:
            try:
                # Long poll - Telegram holds connection until message arrives or timeout
                resp = await client.get(
                    f"{TELEGRAM_API}/getUpdates",
                    params={
                        "offset": offset,
                        "timeout": POLL_TIMEOUT,
                        "allowed_updates": ["message"],  # Only messages, not edits/reactions/etc
                    }
                )
                
                data = resp.json()
                
                if not data.get("ok"):
                    print(f"Telegram API error: {data}")
                    await asyncio.sleep(5)
                    continue
                
                updates = data.get("result", [])
                
                for update in updates:
                    # Move offset past this update so we don't see it again
                    offset = update["update_id"] + 1
                    
                    # Process the message
                    message = update.get("message")
                    if message:
                        await process_telegram_message(message, client)
                
            except httpx.TimeoutException:
                # Normal - long poll timed out with no messages
                pass
            except Exception as e:
                print(f"Polling error: {e}")
                await asyncio.sleep(5)


# --- FastAPI app ---

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Bridge server starting...")
    print(f"Whisper available: {WHISPER_AVAILABLE}")
    
    if not TELEGRAM_BOT_TOKEN:
        print("WARNING: TELEGRAM_BOT_TOKEN not set!")
    
    # Start polling in background
    polling_task = asyncio.create_task(poll_telegram())
    
    yield
    
    # Cleanup
    polling_task.cancel()
    try:
        await polling_task
    except asyncio.CancelledError:
        pass
    print("Bridge server shutting down...")


app = FastAPI(title="Telegram-Claude Bridge", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "connections": len(manager.active_connections),
        "whisper": WHISPER_AVAILABLE,
        "mode": "polling"
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for Chrome extension."""
    await manager.connect(websocket)
    
    async def send_pings():
        """Send periodic pings to keep connection alive."""
        while True:
            try:
                await asyncio.sleep(20)  # Ping every 20 seconds
                await websocket.send_json({"type": "ping", "ts": asyncio.get_event_loop().time()})
            except Exception:
                break
    
    ping_task = asyncio.create_task(send_pings())
    
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            
            if msg.get("type") == "pong":
                # Keepalive response, ignore
                pass
            elif msg.get("type") == "status":
                print(f"Extension status: {msg.get('status')}")
                
    except WebSocketDisconnect:
        ping_task.cancel()
        manager.disconnect(websocket)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8765)
