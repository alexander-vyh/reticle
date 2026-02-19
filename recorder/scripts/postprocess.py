#!/usr/bin/env python3
"""Batch post-processing pipeline for completed meeting recordings.

Takes a WAV file + meeting metadata, produces a speaker-attributed transcript JSON.

Pipeline:
  1. MLX Whisper transcription (VoiceInk quality params) with word-level timestamps
  2. pyannote speaker diarization (who spoke when)
  3. Align transcript words with speaker segments
  4. Speaker identification (match voices to enrolled speakers via ECAPA-TDNN)
  5. Vocabulary hints + dictionary corrections
  6. (Optional) LLM correction pass via Ollama
  7. Output JSON to transcripts directory

Launched by the Swift RecorderDaemon after recording stops.
"""

import sys
import json
import argparse
import logging
from pathlib import Path
from datetime import datetime

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s [postprocess] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# Paths for video-transcription-analysis integration
VTA_CONFIG_DIR = Path.home() / ".config" / "claudia"
SPEAKER_DB_PATH = VTA_CONFIG_DIR / "speaker-db.json"
VOCABULARY_PATH = VTA_CONFIG_DIR / "vocabulary.yaml"
CORRECTIONS_PATH = VTA_CONFIG_DIR / "corrections.yaml"


def parse_args():
    p = argparse.ArgumentParser(description="Post-process a meeting recording")
    p.add_argument("--wav", required=True, help="Path to the WAV recording")
    p.add_argument("--metadata", required=True, help="JSON string with meeting metadata")
    p.add_argument("--output-dir", required=True, help="Directory for output transcript JSON")
    p.add_argument(
        "--model",
        default="mlx-community/whisper-large-v3-turbo",
        help="MLX Whisper model",
    )
    p.add_argument("--language", default=None, help="Language code (None = auto)")
    p.add_argument(
        "--skip-diarization", action="store_true", help="Skip speaker diarization"
    )
    p.add_argument(
        "--skip-corrections", action="store_true", help="Skip correction passes"
    )
    p.add_argument(
        "--enable-llm-corrections",
        action="store_true",
        help="Enable Ollama LLM correction pass (slow)",
    )
    return p.parse_args()


def transcribe_audio(wav_path: str, model: str, language: str | None) -> dict:
    """Run MLX Whisper on the full audio file with VoiceInk quality parameters."""
    log.info("Transcribing with MLX Whisper: %s", model)

    import mlx_whisper

    # Build initial_prompt from vocabulary if available
    initial_prompt = None
    try:
        from video_transcription.vocabulary import VocabularyManager

        if VOCABULARY_PATH.exists():
            vocab = VocabularyManager(VOCABULARY_PATH)
            initial_prompt = vocab.build_initial_prompt()
            if initial_prompt:
                log.info("Vocabulary prompt: %s", initial_prompt[:80])
    except ImportError:
        log.debug("VocabularyManager not available, skipping vocabulary hints")

    result = mlx_whisper.transcribe(
        wav_path,
        path_or_hf_repo=model,
        language=language,
        # VoiceInk quality parameters
        temperature=0.2,
        condition_on_previous_text=False,
        no_speech_threshold=0.6,
        hallucination_silence_threshold=0.5,
        word_timestamps=True,
        initial_prompt=initial_prompt,
        verbose=False,
    )

    segments = result.get("segments", [])
    log.info("Transcription complete: %d segments", len(segments))
    return result


def run_diarization(wav_path: str) -> list[dict]:
    """Run pyannote speaker diarization, return list of {start, end, speaker} segments."""
    log.info("Running speaker diarization...")

    try:
        from pyannote.audio import Pipeline
    except ImportError:
        log.warning("pyannote.audio not installed, skipping diarization")
        return []

    import torch

    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        use_auth_token=True,
    )
    pipeline.to(device)

    diarization = pipeline(wav_path)

    speaker_segments = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        speaker_segments.append(
            {"start": round(turn.start, 2), "end": round(turn.end, 2), "speaker": speaker}
        )

    log.info("Diarization complete: %d turns, %d speakers",
             len(speaker_segments),
             len(set(s["speaker"] for s in speaker_segments)))
    return speaker_segments


def align_transcript_with_speakers(
    whisper_result: dict, speaker_segments: list[dict]
) -> list[dict]:
    """Align word-level Whisper timestamps with pyannote speaker segments.

    For each Whisper segment, find the speaker who was speaking at that time
    (based on majority overlap of word timestamps).
    """
    if not speaker_segments:
        # No diarization — return segments without speaker attribution
        return [
            {
                "start": round(seg["start"], 2),
                "end": round(seg["end"], 2),
                "text": seg["text"].strip(),
                "speaker": "Unknown",
            }
            for seg in whisper_result.get("segments", [])
            if seg.get("text", "").strip()
        ]

    def find_speaker_at(time_point: float) -> str:
        """Find the speaker active at a given timestamp."""
        for ss in speaker_segments:
            if ss["start"] <= time_point <= ss["end"]:
                return ss["speaker"]
        # Find nearest speaker segment
        min_dist = float("inf")
        nearest = "Unknown"
        for ss in speaker_segments:
            dist = min(abs(ss["start"] - time_point), abs(ss["end"] - time_point))
            if dist < min_dist:
                min_dist = dist
                nearest = ss["speaker"]
        return nearest if min_dist < 2.0 else "Unknown"

    aligned = []
    for seg in whisper_result.get("segments", []):
        text = seg.get("text", "").strip()
        if not text:
            continue

        # Use word timestamps if available for more precise speaker attribution
        words = seg.get("words", [])
        if words:
            # Majority vote: which speaker owns most words in this segment
            speaker_votes: dict[str, int] = {}
            for word in words:
                mid = (word.get("start", seg["start"]) + word.get("end", seg["end"])) / 2
                spk = find_speaker_at(mid)
                speaker_votes[spk] = speaker_votes.get(spk, 0) + 1
            speaker = max(speaker_votes, key=speaker_votes.get)  # type: ignore[arg-type]
        else:
            mid = (seg["start"] + seg["end"]) / 2
            speaker = find_speaker_at(mid)

        aligned.append(
            {
                "start": round(seg["start"], 2),
                "end": round(seg["end"], 2),
                "text": text,
                "speaker": speaker,
            }
        )

    # Merge consecutive segments from the same speaker
    merged = []
    for seg in aligned:
        if merged and merged[-1]["speaker"] == seg["speaker"]:
            # Check for reasonable gap (< 1.5s)
            gap = seg["start"] - merged[-1]["end"]
            if gap < 1.5:
                merged[-1]["end"] = seg["end"]
                merged[-1]["text"] += " " + seg["text"]
                continue
        merged.append(dict(seg))

    return merged


def identify_speakers(
    segments: list[dict], wav_path: str, attendees: list[str]
) -> tuple[list[dict], list[dict]]:
    """Replace generic speaker labels (SPEAKER_00) with real names using voice embeddings.

    Returns (updated_segments, speaker_info).
    """
    try:
        from video_transcription.speaker_db import SpeakerDatabase
    except ImportError:
        log.debug("SpeakerDatabase not available, skipping speaker identification")
        return segments, []

    if not SPEAKER_DB_PATH.exists():
        log.info("No speaker database at %s, skipping identification", SPEAKER_DB_PATH)
        return segments, []

    db = SpeakerDatabase(db_path=SPEAKER_DB_PATH)
    unique_speakers = set(s["speaker"] for s in segments if s["speaker"] != "Unknown")

    speaker_map: dict[str, str] = {}
    speaker_info: list[dict] = []

    for speaker_label in sorted(unique_speakers):
        # TODO: Extract audio for this speaker's segments and run identification
        # For now, use attendee list heuristics if available
        log.info("Speaker %s detected (identification requires enrolled voices)", speaker_label)
        speaker_info.append({"label": speaker_label, "name": speaker_label, "confidence": 0.0})

    # Apply any mappings
    if speaker_map:
        for seg in segments:
            if seg["speaker"] in speaker_map:
                seg["speaker"] = speaker_map[seg["speaker"]]

    return segments, speaker_info


def apply_corrections(segments: list[dict]) -> list[dict]:
    """Apply dictionary-based corrections to segment text."""
    try:
        from video_transcription.corrector import DictionaryCorrector
    except ImportError:
        log.debug("DictionaryCorrector not available, skipping corrections")
        return segments

    if not CORRECTIONS_PATH.exists():
        log.info("No corrections file at %s, skipping", CORRECTIONS_PATH)
        return segments

    corrector = DictionaryCorrector(CORRECTIONS_PATH)
    total_corrections = 0

    for seg in segments:
        corrected, stats = corrector.correct(seg["text"])
        if stats.total_replacements > 0:
            total_corrections += stats.total_replacements
            seg["text"] = corrected

    if total_corrections:
        log.info("Applied %d dictionary corrections", total_corrections)
    return segments


def apply_llm_corrections(segments: list[dict]) -> list[dict]:
    """Apply LLM-based corrections via Ollama."""
    try:
        from video_transcription.llm_corrector import LLMCorrector
    except ImportError:
        log.debug("LLMCorrector not available, skipping LLM corrections")
        return segments

    corrector = LLMCorrector()
    full_text = "\n".join(f"[{s['speaker']}] {s['text']}" for s in segments)

    corrected_text, stats = corrector.correct(full_text)
    if stats.total_corrections > 0:
        log.info("LLM made %d corrections", stats.total_corrections)
        # Re-split corrected text back into segments (best-effort)
        lines = corrected_text.strip().split("\n")
        for i, line in enumerate(lines):
            if i < len(segments):
                # Strip speaker prefix if present
                if line.startswith("[") and "] " in line:
                    line = line.split("] ", 1)[1]
                segments[i]["text"] = line

    return segments


def build_output(
    segments: list[dict],
    speaker_info: list[dict],
    metadata: dict,
    wav_path: str,
    model: str,
) -> dict:
    """Build the final output JSON."""
    full_text = "\n".join(
        f"[{s['speaker']}] {s['text']}" for s in segments
    )

    return {
        "meetingId": metadata.get("meetingId", ""),
        "title": metadata.get("title", ""),
        "startTime": metadata.get("startTime", ""),
        "endTime": metadata.get("endTime", ""),
        "attendees": metadata.get("attendees", []),
        "segments": segments,
        "fullText": full_text,
        "speakers": speaker_info,
        "model": model,
        "audioFile": wav_path,
        "processedAt": datetime.now().isoformat(),
    }


def main():
    args = parse_args()

    metadata = json.loads(args.metadata)
    wav_path = args.wav
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    log.info("Post-processing: %s (%s)", metadata.get("title", "?"), wav_path)

    # Step 1: Transcribe
    whisper_result = transcribe_audio(wav_path, args.model, args.language)

    # Step 2: Diarize
    speaker_segments = []
    if not args.skip_diarization:
        speaker_segments = run_diarization(wav_path)

    # Step 3: Align transcript with speakers
    segments = align_transcript_with_speakers(whisper_result, speaker_segments)
    log.info("Aligned %d segments", len(segments))

    # Step 4: Identify speakers
    attendees = metadata.get("attendees", [])
    segments, speaker_info = identify_speakers(segments, wav_path, attendees)

    # Step 5: Apply corrections
    if not args.skip_corrections:
        segments = apply_corrections(segments)

    # Step 6: Optional LLM corrections
    if args.enable_llm_corrections:
        segments = apply_llm_corrections(segments)

    # Step 7: Build and write output
    output = build_output(segments, speaker_info, metadata, wav_path, args.model)

    meeting_id = metadata.get("meetingId", "unknown")
    date_str = datetime.now().strftime("%Y-%m-%d")
    output_path = output_dir / f"meeting-{meeting_id}-{date_str}.json"

    with open(output_path, "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    log.info("Transcript written to %s", output_path)
    # Print path to stdout for the caller
    print(str(output_path))


if __name__ == "__main__":
    main()
