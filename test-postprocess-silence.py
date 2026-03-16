#!/usr/bin/env python3
"""Tests for postprocess.py check_audio_present() function."""

import sys
import os
import wave
import struct
import tempfile
import math

# Add recorder/scripts to path so we can import the function
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "recorder", "scripts"))
from postprocess import check_audio_present


def make_wav(path, samples, sample_rate=16000):
    """Write a 16-bit mono WAV file from a list of int16 samples."""
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(struct.pack(f"{len(samples)}h", *samples))


def test_digital_silence_returns_false():
    """All-zero samples should be detected as silence."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        path = f.name
    try:
        make_wav(path, [0] * 16000)  # 1 second of silence
        result = check_audio_present(path)
        assert result is False, f"Expected False for digital silence, got {result}"
        print("  PASS: digital silence returns False")
    finally:
        os.unlink(path)


def test_low_noise_below_threshold_returns_false():
    """Noise floor samples (~-70 dBFS) should be detected as silence."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        path = f.name
    try:
        # RMS ~0.0003 (well below 0.003 threshold) — simulates DAC noise
        import random
        random.seed(42)
        samples = [random.randint(-10, 10) for _ in range(16000)]
        make_wav(path, samples)
        result = check_audio_present(path)
        assert result is False, f"Expected False for low noise, got {result}"
        print("  PASS: low noise below threshold returns False")
    finally:
        os.unlink(path)


def test_speech_level_returns_true():
    """Normal speech-level audio should be detected as present."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        path = f.name
    try:
        # Generate a sine wave at ~-20 dBFS (normal speech)
        freq = 440
        amplitude = 3277  # ~0.1 normalized = -20 dBFS
        samples = [int(amplitude * math.sin(2 * math.pi * freq * i / 16000))
                   for i in range(16000)]
        make_wav(path, samples)
        result = check_audio_present(path)
        assert result is True, f"Expected True for speech-level audio, got {result}"
        print("  PASS: speech-level audio returns True")
    finally:
        os.unlink(path)


def test_threshold_boundary():
    """Audio just above the threshold should return True."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        path = f.name
    try:
        # RMS ~0.005 (above 0.003 threshold)
        freq = 200
        amplitude = 164  # ~0.005 normalized
        samples = [int(amplitude * math.sin(2 * math.pi * freq * i / 16000))
                   for i in range(16000)]
        make_wav(path, samples)
        result = check_audio_present(path)
        assert result is True, f"Expected True at boundary, got {result}"
        print("  PASS: audio at threshold boundary returns True")
    finally:
        os.unlink(path)


def test_empty_wav_returns_false():
    """A WAV with zero frames should return False."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        path = f.name
    try:
        make_wav(path, [])
        result = check_audio_present(path)
        assert result is False, f"Expected False for empty WAV, got {result}"
        print("  PASS: empty WAV returns False")
    finally:
        os.unlink(path)


def test_nonexistent_file_returns_true():
    """Missing file should return True (fail open — let Whisper handle it)."""
    result = check_audio_present("/tmp/nonexistent-test-file.wav")
    assert result is True, f"Expected True for missing file (fail open), got {result}"
    print("  PASS: nonexistent file returns True (fail open)")


def test_custom_threshold():
    """Custom threshold should be respected."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        path = f.name
    try:
        # RMS ~0.005 — below custom threshold of 0.01, above default 0.003
        freq = 200
        amplitude = 164
        samples = [int(amplitude * math.sin(2 * math.pi * freq * i / 16000))
                   for i in range(16000)]
        make_wav(path, samples)
        result_default = check_audio_present(path, threshold_rms=0.003)
        result_custom = check_audio_present(path, threshold_rms=0.01)
        assert result_default is True, "Should pass default threshold"
        assert result_custom is False, "Should fail custom higher threshold"
        print("  PASS: custom threshold respected")
    finally:
        os.unlink(path)


if __name__ == "__main__":
    print("test-postprocess-silence.py")
    test_digital_silence_returns_false()
    test_low_noise_below_threshold_returns_false()
    test_speech_level_returns_true()
    test_threshold_boundary()
    test_empty_wav_returns_false()
    test_nonexistent_file_returns_true()
    test_custom_threshold()
    print("All tests passed")
