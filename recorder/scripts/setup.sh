#!/bin/bash
set -euo pipefail

# Setup script for meeting-recorder Python environment.
# Creates a venv, installs dependencies, and configures PYTHONPATH
# for video-transcription-analysis imports.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="${RECORDER_VENV_PATH:-$HOME/.config/claudia/recorder-venv}"
VTA_DIR="${VTA_PATH:-$HOME/GitHub/video-transcription-analysis}"

echo "=== Meeting Recorder Python Setup ==="
echo "Venv:  $VENV_DIR"
echo "VTA:   $VTA_DIR"
echo ""

# Check Python version
PYTHON="${PYTHON:-python3}"
PY_VERSION=$($PYTHON --version 2>&1)
echo "Python: $PY_VERSION"

# Verify Apple Silicon (MLX requirement)
if [[ "$(uname -m)" != "arm64" ]]; then
    echo "WARNING: MLX Whisper requires Apple Silicon (arm64). Detected: $(uname -m)"
    echo "Transcription may not work on this machine."
fi

# Create venv
if [ ! -d "$VENV_DIR" ]; then
    echo ""
    echo "Creating virtual environment..."
    $PYTHON -m venv "$VENV_DIR"
else
    echo "Venv already exists at $VENV_DIR"
fi

# Activate and install
source "$VENV_DIR/bin/activate"

echo ""
echo "Installing dependencies..."
pip install --upgrade pip -q
pip install -r "$SCRIPT_DIR/requirements.txt"

# Install video-transcription-analysis in editable mode if available
if [ -d "$VTA_DIR" ]; then
    echo ""
    echo "Installing video-transcription-analysis (editable)..."
    pip install -e "$VTA_DIR"
else
    echo ""
    echo "WARNING: video-transcription-analysis not found at $VTA_DIR"
    echo "Speaker identification, vocabulary, and corrections will be unavailable."
    echo "Set VTA_PATH to the correct location and re-run."
fi

# Download spaCy English model for name detection
echo ""
echo "Downloading spaCy English model..."
python -m spacy download en_core_web_sm 2>/dev/null || echo "spaCy model download failed (non-critical)"

# Ensure config directories exist
mkdir -p ~/.config/claudia/transcripts
mkdir -p ~/.config/claudia/recordings

# Write an activation helper that RecorderConfig can reference
cat > "$VENV_DIR/activate-recorder.sh" <<'ACTIVATE'
#!/bin/bash
# Source this to activate the recorder Python environment
VENV_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$VENV_DIR/bin/activate"
ACTIVATE
chmod +x "$VENV_DIR/activate-recorder.sh"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Venv:   $VENV_DIR"
echo "Python: $VENV_DIR/bin/python3"
echo ""
echo "Test with:"
echo "  $VENV_DIR/bin/python3 -c 'import mlx_whisper; print(\"MLX Whisper OK\")'"
echo ""
echo "Note: The whisper model will be downloaded on first use (~3GB for large-v3-turbo)."
echo ""
echo "For pyannote diarization, you need a HuggingFace token:"
echo "  1. Accept the terms at https://huggingface.co/pyannote/speaker-diarization-3.1"
echo "  2. Run: $VENV_DIR/bin/python3 -c 'from huggingface_hub import login; login()'"
