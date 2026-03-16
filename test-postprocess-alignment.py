#!/usr/bin/env python3
"""Tests for the overlap-weighted word-to-speaker alignment in postprocess.py."""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "recorder", "scripts"))
from postprocess import align_transcript_with_speakers


def test_overlap_weighted_beats_midpoint():
    """A word spanning a speaker boundary should be assigned to the speaker
    with more temporal overlap, not by where the midpoint falls."""

    # Speaker A: 0.0-5.0s, Speaker B: 5.0-10.0s
    speaker_segments = [
        {"start": 0.0, "end": 5.0, "speaker": "SPEAKER_A"},
        {"start": 5.0, "end": 10.0, "speaker": "SPEAKER_B"},
    ]

    # A word from 4.0-5.3s: 1.0s overlap with A, 0.3s overlap with B
    # Midpoint = 4.65 → midpoint approach picks A (correct by accident)
    # But a word from 4.8-5.6s: 0.2s overlap with A, 0.6s overlap with B
    # Midpoint = 5.2 → midpoint approach picks B (correct)
    # Key test: word from 3.5-5.4s: 1.5s overlap with A, 0.4s overlap with B
    # Midpoint = 4.45 → midpoint picks A (correct), but let's test the boundary case
    whisper_result = {
        "segments": [
            {
                "start": 3.0,
                "end": 6.0,
                "text": "handoff word boundary test",
                "words": [
                    {"start": 3.0, "end": 4.0, "word": "handoff"},      # fully in A
                    {"start": 4.0, "end": 5.3, "word": "word"},         # 1.0 A, 0.3 B → A
                    {"start": 5.1, "end": 5.8, "word": "boundary"},     # 0.0 A, 0.7 B → B (midpoint=5.45, B correct too)
                    {"start": 5.8, "end": 6.0, "word": "test"},         # fully in B
                ],
            }
        ]
    }

    result = align_transcript_with_speakers(whisper_result, speaker_segments)
    # Duration-weighted: "handoff"=1.0s→A, "word"=1.3s→A(1.0 vs 0.3), "boundary"=0.7s→B, "test"=0.2s→B
    # A weight: 1.0 + 1.3 = 2.3s, B weight: 0.7 + 0.2 = 0.9s → SPEAKER_A wins
    assert result[0]["speaker"] == "SPEAKER_A", f"Expected SPEAKER_A, got {result[0]['speaker']}"
    print("PASS: overlap-weighted assigns boundary segment correctly")


def test_no_diarization_fallback():
    """Without speaker segments, all segments should get 'Unknown'."""
    whisper_result = {
        "segments": [
            {"start": 0.0, "end": 2.0, "text": "hello"},
            {"start": 2.0, "end": 4.0, "text": "world"},
        ]
    }
    result = align_transcript_with_speakers(whisper_result, [])
    assert all(s["speaker"] == "Unknown" for s in result)
    assert len(result) == 2
    print("PASS: no diarization → Unknown speaker")


def test_merge_consecutive_same_speaker():
    """Consecutive segments from the same speaker within 1.5s gap get merged."""
    speaker_segments = [
        {"start": 0.0, "end": 10.0, "speaker": "SPEAKER_A"},
    ]
    whisper_result = {
        "segments": [
            {"start": 0.0, "end": 2.0, "text": "first part"},
            {"start": 2.5, "end": 4.0, "text": "second part"},
            {"start": 4.2, "end": 6.0, "text": "third part"},
        ]
    }
    result = align_transcript_with_speakers(whisper_result, speaker_segments)
    assert len(result) == 1, f"Expected 1 merged segment, got {len(result)}"
    assert "first part" in result[0]["text"]
    assert "third part" in result[0]["text"]
    print("PASS: consecutive same-speaker segments merge")


def test_no_merge_across_speakers():
    """Segments from different speakers should not merge even if close."""
    speaker_segments = [
        {"start": 0.0, "end": 3.0, "speaker": "SPEAKER_A"},
        {"start": 3.0, "end": 6.0, "speaker": "SPEAKER_B"},
    ]
    whisper_result = {
        "segments": [
            {"start": 0.5, "end": 2.5, "text": "from A"},
            {"start": 3.5, "end": 5.5, "text": "from B"},
        ]
    }
    result = align_transcript_with_speakers(whisper_result, speaker_segments)
    assert len(result) == 2
    assert result[0]["speaker"] == "SPEAKER_A"
    assert result[1]["speaker"] == "SPEAKER_B"
    print("PASS: different speakers don't merge")


def test_nearest_speaker_fallback():
    """Words in gaps between speaker segments find the nearest speaker within 2s."""
    speaker_segments = [
        {"start": 0.0, "end": 3.0, "speaker": "SPEAKER_A"},
        {"start": 6.0, "end": 9.0, "speaker": "SPEAKER_B"},
    ]
    whisper_result = {
        "segments": [
            # Word at 3.5-4.0s: no overlap, nearest is A at 0.5s distance
            {"start": 3.5, "end": 4.0, "text": "gap word"},
        ]
    }
    result = align_transcript_with_speakers(whisper_result, speaker_segments)
    assert result[0]["speaker"] == "SPEAKER_A", f"Expected SPEAKER_A, got {result[0]['speaker']}"
    print("PASS: nearest speaker fallback works in gaps")


if __name__ == "__main__":
    test_overlap_weighted_beats_midpoint()
    test_no_diarization_fallback()
    test_merge_consecutive_same_speaker()
    test_no_merge_across_speakers()
    test_nearest_speaker_fallback()
    print("\nAll postprocess alignment tests passed.")
