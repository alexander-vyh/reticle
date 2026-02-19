#!/usr/bin/env python3
"""Live streaming transcription: reads PCM audio from stdin, emits JSON lines to stdout.

Protocol:
  - Input:  16kHz mono signed 16-bit little-endian PCM on stdin (raw bytes, no header)
  - Output: One JSON object per line on stdout with keys:
            {"text", "start", "end", "no_speech_prob", "is_final"}
  - Stderr: Diagnostic/log messages only

Launched by the Swift RecorderDaemon as a subprocess.
"""

import sys
import json
import time
import struct
import argparse
import logging
import numpy as np

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s [stream_transcribe] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


def parse_args():
    p = argparse.ArgumentParser(description="Live streaming Whisper transcription")
    p.add_argument(
        "--model",
        default="mlx-community/whisper-large-v3-turbo",
        help="HuggingFace model repo for MLX Whisper",
    )
    p.add_argument(
        "--language", default=None, help="Language code (e.g. 'en'). None = auto-detect."
    )
    p.add_argument(
        "--buffer-seconds",
        type=float,
        default=3.0,
        help="Audio buffer duration before transcribing",
    )
    p.add_argument(
        "--vocab-prompt",
        default=None,
        help="Vocabulary terms to include in initial_prompt",
    )
    return p.parse_args()


SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2  # 16-bit = 2 bytes per sample


def read_pcm_stdin(buffer_seconds: float) -> np.ndarray | None:
    """Read a chunk of PCM audio from stdin, return as float32 numpy array.

    Returns None on EOF.
    """
    num_samples = int(SAMPLE_RATE * buffer_seconds)
    num_bytes = num_samples * SAMPLE_WIDTH

    data = sys.stdin.buffer.read(num_bytes)
    if not data:
        return None

    # Pad with silence if we got a partial read (end of stream)
    if len(data) < num_bytes:
        data = data + b"\x00" * (num_bytes - len(data))

    # Convert signed 16-bit LE PCM to float32 in [-1, 1]
    samples = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
    return samples


def main():
    args = parse_args()

    log.info("Loading MLX Whisper model: %s", args.model)
    import mlx_whisper

    log.info("Model loaded. Listening for audio on stdin...")

    # Emit a ready signal so the Swift daemon knows we're initialized
    ready_msg = json.dumps({"status": "ready", "model": args.model})
    sys.stdout.write(ready_msg + "\n")
    sys.stdout.flush()

    elapsed_seconds = 0.0
    previous_text = ""

    while True:
        audio = read_pcm_stdin(args.buffer_seconds)
        if audio is None:
            log.info("EOF on stdin, exiting")
            break

        chunk_start = elapsed_seconds
        chunk_end = elapsed_seconds + args.buffer_seconds
        elapsed_seconds = chunk_end

        # Skip silence: if RMS is very low, don't bother transcribing
        rms = np.sqrt(np.mean(audio**2))
        if rms < 0.005:
            continue

        # Build initial_prompt for cross-chunk continuity
        initial_prompt = ""
        if args.vocab_prompt:
            initial_prompt = args.vocab_prompt
        if previous_text:
            # Append last segment's text for context (truncate to avoid token limit)
            prompt_suffix = previous_text[-200:]
            initial_prompt = f"{initial_prompt} {prompt_suffix}".strip()

        try:
            result = mlx_whisper.transcribe(
                audio,
                path_or_hf_repo=args.model,
                language=args.language,
                # VoiceInk quality parameters
                temperature=0.2,
                condition_on_previous_text=False,
                no_speech_threshold=0.6,
                hallucination_silence_threshold=0.5,
                word_timestamps=True,
                initial_prompt=initial_prompt if initial_prompt else None,
                verbose=False,
            )
        except Exception:
            log.exception("Transcription error on chunk at %.1fs", chunk_start)
            continue

        segments = result.get("segments", [])
        for seg in segments:
            text = seg.get("text", "").strip()
            if not text:
                continue

            no_speech = seg.get("no_speech_prob", 0.0)

            # Skip likely hallucinated segments
            if no_speech > 0.6:
                continue

            output = {
                "text": text,
                "start": round(chunk_start + seg.get("start", 0.0), 2),
                "end": round(chunk_start + seg.get("end", 0.0), 2),
                "no_speech_prob": round(no_speech, 3),
                "is_final": False,
            }
            sys.stdout.write(json.dumps(output) + "\n")
            sys.stdout.flush()

            previous_text = text

    # Signal completion
    done_msg = json.dumps({"status": "done", "total_seconds": round(elapsed_seconds, 1)})
    sys.stdout.write(done_msg + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
