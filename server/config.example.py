# Telegram → Claude Bridge Configuration
# Copy this file to config.py and fill in your values

# Your Telegram bot token from @BotFather
TELEGRAM_BOT_TOKEN = "YOUR_BOT_TOKEN_HERE"
# Example: "1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"

# Allowed chat IDs (leave empty list to allow all chats)
# - DM chat IDs are positive numbers (your user ID)
# - Group chat IDs are negative numbers (usually start with -100)
# Check server logs to find chat IDs when messages come in
ALLOWED_CHAT_IDS = []
# Example: [123456789, -1001234567890]

# Long polling timeout in seconds
# Higher = less API calls, but slower shutdown
POLL_TIMEOUT = 30

# Whisper model for voice transcription
# Options: "tiny", "base", "small", "medium", "large-v2"
# Larger = more accurate but slower and more RAM
WHISPER_MODEL_SIZE = "medium"

# Whisper compute settings
# For CPU: "int8" (faster) or "float32" (more accurate)  
# For GPU: "float16"
WHISPER_COMPUTE_TYPE = "int8"
WHISPER_DEVICE = "cpu"  # "cpu" or "cuda"
