"""Tests for audio loading in the post-processing pipeline.

Bug 2: pyannote can't load WAV files because torchcodec/FFmpeg is broken.
Fix: pre-load audio with scipy and pass waveform dict to pyannote.
"""

import tempfile
import wave
import struct

import numpy as np
import pytest
from unittest.mock import patch, MagicMock


def create_test_wav(path: str, duration: float = 1.0, sample_rate: int = 16000):
    """Create a short WAV file with a sine wave for testing."""
    n_samples = int(sample_rate * duration)
    t = np.linspace(0, duration, n_samples, endpoint=False)
    samples = (np.sin(2 * np.pi * 440 * t) * 16000).astype(np.int16)

    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(samples.tobytes())


class TestLoadAudio:
    """The postprocess module should be able to load WAV files without torchcodec."""

    def test_load_audio_returns_waveform_dict(self, tmp_path):
        """load_audio should return a dict with 'waveform' tensor and 'sample_rate'."""
        wav_path = str(tmp_path / "test.wav")
        create_test_wav(wav_path, duration=1.0)

        # Import from the scripts directory
        import sys
        import os
        scripts_dir = os.path.join(os.path.dirname(__file__), "..", "scripts")
        sys.path.insert(0, scripts_dir)

        from postprocess import load_audio

        result = load_audio(wav_path)

        assert "waveform" in result, "Should return a dict with 'waveform' key"
        assert "sample_rate" in result, "Should return a dict with 'sample_rate' key"
        assert result["sample_rate"] == 16000

    def test_load_audio_waveform_shape(self, tmp_path):
        """Waveform should be a 2D tensor: (channels, samples)."""
        wav_path = str(tmp_path / "test.wav")
        create_test_wav(wav_path, duration=2.0, sample_rate=16000)

        import sys
        import os
        scripts_dir = os.path.join(os.path.dirname(__file__), "..", "scripts")
        sys.path.insert(0, scripts_dir)

        from postprocess import load_audio

        result = load_audio(wav_path)
        waveform = result["waveform"]

        assert len(waveform.shape) == 2, f"Expected 2D tensor, got {waveform.shape}"
        assert waveform.shape[0] == 1, f"Expected 1 channel, got {waveform.shape[0]}"
        # ~32000 samples for 2s at 16kHz
        assert abs(waveform.shape[1] - 32000) < 100

    def test_run_diarization_uses_load_audio(self, tmp_path):
        """run_diarization should use load_audio instead of passing file path directly."""
        wav_path = str(tmp_path / "test.wav")
        create_test_wav(wav_path, duration=1.0)

        import sys
        import os
        scripts_dir = os.path.join(os.path.dirname(__file__), "..", "scripts")
        sys.path.insert(0, scripts_dir)

        import postprocess

        # Verify run_diarization source code uses load_audio, not raw path
        import inspect
        source = inspect.getsource(postprocess.run_diarization)
        assert "load_audio" in source, (
            "run_diarization should call load_audio() to pre-load WAV, "
            "not pass the file path directly to pyannote"
        )


class TestDiarizationFallback:
    """Diarization failures should be non-fatal — return [] instead of crashing."""

    def _ensure_postprocess_importable(self):
        import sys
        import os
        scripts_dir = os.path.join(os.path.dirname(__file__), "..", "scripts")
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)

    def test_run_diarization_returns_empty_on_pipeline_error(self, tmp_path):
        """run_diarization should return [] when Pipeline.from_pretrained raises."""
        self._ensure_postprocess_importable()
        import postprocess

        wav_path = str(tmp_path / "test.wav")
        create_test_wav(wav_path, duration=1.0)

        with patch.object(postprocess, "Pipeline", create=True) as mock_pipeline_cls:
            mock_pipeline_cls.from_pretrained.side_effect = OSError(
                "No HuggingFace token found"
            )
            result = postprocess.run_diarization(wav_path)

        assert result == [], f"Expected empty list on pipeline error, got {result}"

    def test_run_diarization_returns_empty_on_runtime_error(self, tmp_path):
        """run_diarization should return [] on any runtime error during inference."""
        self._ensure_postprocess_importable()
        import postprocess

        wav_path = str(tmp_path / "test.wav")
        create_test_wav(wav_path, duration=1.0)

        mock_pipeline = MagicMock()
        with patch.object(postprocess, "Pipeline", create=True) as mock_pipeline_cls:
            mock_pipeline_cls.from_pretrained.return_value = mock_pipeline
            mock_pipeline.side_effect = RuntimeError("CUDA out of memory")
            result = postprocess.run_diarization(wav_path)

        assert result == [], f"Expected empty list on runtime error, got {result}"
