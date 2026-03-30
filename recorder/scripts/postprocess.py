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
VTA_CONFIG_DIR = Path.home() / ".config" / "reticle"
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
    p.add_argument(
        "--mic-wav",
        default=None,
        help="Path to mic WAV recording (user's own voice, transcribed separately)",
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


def load_audio(wav_path: str) -> dict:
    """Load a WAV file into a waveform dict compatible with pyannote pipelines.

    Uses scipy.io.wavfile to avoid torchcodec/FFmpeg dependency issues.
    Returns {"waveform": torch.Tensor (channels, samples), "sample_rate": int}.
    """
    import torch
    from scipy.io import wavfile

    sample_rate, data = wavfile.read(wav_path)
    import numpy as np

    # Convert to float32 in [-1, 1]
    if data.dtype == np.int16:
        audio = data.astype(np.float32) / 32768.0
    elif data.dtype == np.int32:
        audio = data.astype(np.float32) / 2147483648.0
    elif data.dtype == np.float32:
        audio = data
    else:
        audio = data.astype(np.float32)

    # Ensure 2D: (channels, samples)
    if audio.ndim == 1:
        audio = audio[np.newaxis, :]
    elif audio.ndim == 2:
        # scipy returns (samples, channels) — transpose to (channels, samples)
        audio = audio.T

    waveform = torch.from_numpy(audio)
    return {"waveform": waveform, "sample_rate": sample_rate}


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
    try:
        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-community-1",
            token=True,
        )
        pipeline.to(device)

        # Pre-load audio with scipy to avoid torchcodec/FFmpeg issues
        audio = load_audio(wav_path)
        result = pipeline(audio)

        # pyannote 4.x returns DiarizeOutput; extract the Annotation object
        if hasattr(result, 'speaker_diarization'):
            diarization = result.speaker_diarization
        else:
            diarization = result  # pyannote 3.x returns Annotation directly
    except Exception as e:
        log.warning("Diarization failed (continuing without speaker labels): %s", e)
        return []

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

    Uses overlap-weighted assignment: each word's speaker is determined by
    which speaker segment has the most temporal overlap with the word's
    time span. Words at speaker boundaries get correctly attributed by
    overlap duration rather than a single midpoint lookup.

    Segment-level speaker is then determined by duration-weighted vote
    across words (longer words count more).
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

    def compute_speaker_overlap(word_start: float, word_end: float) -> str:
        """Assign a word to the speaker with the greatest temporal overlap."""
        best_speaker = "Unknown"
        best_overlap = 0.0

        for ss in speaker_segments:
            overlap_start = max(word_start, ss["start"])
            overlap_end = min(word_end, ss["end"])
            overlap = max(0.0, overlap_end - overlap_start)
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = ss["speaker"]

        if best_overlap > 0:
            return best_speaker

        # No overlap — find nearest speaker segment within 2s
        min_dist = float("inf")
        nearest = "Unknown"
        word_mid = (word_start + word_end) / 2
        for ss in speaker_segments:
            dist = min(abs(ss["start"] - word_mid), abs(ss["end"] - word_mid))
            if dist < min_dist:
                min_dist = dist
                nearest = ss["speaker"]
        return nearest if min_dist < 2.0 else "Unknown"

    aligned = []
    for seg in whisper_result.get("segments", []):
        text = seg.get("text", "").strip()
        if not text:
            continue

        words = seg.get("words", [])
        if words:
            # Duration-weighted vote: longer words count more
            speaker_weight: dict[str, float] = {}
            for word in words:
                ws = word.get("start", seg["start"])
                we = word.get("end", seg["end"])
                duration = max(we - ws, 0.01)  # avoid zero-weight
                spk = compute_speaker_overlap(ws, we)
                speaker_weight[spk] = speaker_weight.get(spk, 0.0) + duration
            speaker = max(speaker_weight, key=speaker_weight.get)  # type: ignore[arg-type]
        else:
            speaker = compute_speaker_overlap(seg["start"], seg["end"])

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
    segments: list[dict], wav_path: str, attendees: list[str],
    gateway_url: str = "http://127.0.0.1:3001",
) -> tuple[list[dict], list[dict]]:
    """Replace generic speaker labels (SPEAKER_00) with real names using ECAPA-TDNN embeddings.

    Pipeline:
    1. Extract audio clips for each unique speaker cluster
    2. Compute ECAPA-TDNN embedding for each cluster
    3. Compare against known embeddings from Gateway API
    4. Assign names where cosine similarity exceeds threshold

    Returns (updated_segments, speaker_info).
    """
    unique_speakers = sorted(set(s["speaker"] for s in segments if s["speaker"] != "Unknown"))
    if not unique_speakers:
        return segments, []

    # Try to load known embeddings from Gateway
    known_embeddings = _fetch_known_embeddings(gateway_url)
    if not known_embeddings:
        log.info("No known speaker embeddings available, skipping identification")
        return segments, [{"label": s, "name": s, "confidence": 0.0} for s in unique_speakers]

    # Try to compute embeddings for each speaker cluster
    try:
        import torch
        import numpy as np
        from scipy.io import wavfile
    except ImportError:
        log.warning("torch/scipy not available for speaker embedding extraction")
        return segments, [{"label": s, "name": s, "confidence": 0.0} for s in unique_speakers]

    try:
        from speechbrain.inference.speaker import EncoderClassifier
        classifier = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            run_opts={"device": "cpu"},
        )
    except Exception as e:
        log.warning("ECAPA-TDNN model unavailable (%s), skipping identification", e)
        return segments, [{"label": s, "name": s, "confidence": 0.0} for s in unique_speakers]

    sample_rate, full_audio = wavfile.read(wav_path)
    if full_audio.dtype == np.int16:
        full_audio = full_audio.astype(np.float32) / 32768.0
    # Mono
    if full_audio.ndim == 2:
        full_audio = full_audio.mean(axis=1)

    speaker_map: dict[str, str] = {}
    speaker_info: list[dict] = []
    SIMILARITY_THRESHOLD = 0.65

    for speaker_label in unique_speakers:
        # Extract up to 30s of audio for this speaker cluster
        clips = []
        total_samples = 0
        max_samples = sample_rate * 30
        for seg in segments:
            if seg["speaker"] == speaker_label and total_samples < max_samples:
                start_sample = int(seg["start"] * sample_rate)
                end_sample = int(seg["end"] * sample_rate)
                clip = full_audio[start_sample:end_sample]
                clips.append(clip)
                total_samples += len(clip)

        if not clips or total_samples < sample_rate:  # need at least 1s
            speaker_info.append({"label": speaker_label, "name": speaker_label, "confidence": 0.0})
            continue

        combined = np.concatenate(clips)
        waveform = torch.from_numpy(combined).unsqueeze(0)
        embedding = classifier.encode_batch(waveform).squeeze().detach().numpy()

        # Compare against known embeddings
        best_name = speaker_label
        best_sim = 0.0
        for known in known_embeddings:
            sim = _cosine_similarity(embedding, known["embedding"])
            if sim > best_sim:
                best_sim = sim
                best_name = known["name"]

        if best_sim >= SIMILARITY_THRESHOLD:
            speaker_map[speaker_label] = best_name
            log.info("Speaker %s → %s (similarity: %.3f)", speaker_label, best_name, best_sim)
        else:
            log.info("Speaker %s unmatched (best: %s at %.3f)", speaker_label, best_name, best_sim)

        speaker_info.append({
            "label": speaker_label,
            "name": speaker_map.get(speaker_label, speaker_label),
            "confidence": round(best_sim, 3),
        })

    # Apply mappings to segments
    if speaker_map:
        for seg in segments:
            if seg["speaker"] in speaker_map:
                seg["speaker"] = speaker_map[seg["speaker"]]

    return segments, speaker_info


def _fetch_known_embeddings(gateway_url: str) -> list[dict]:
    """Fetch known speaker embeddings from the Gateway API."""
    import urllib.request
    import struct

    try:
        req = urllib.request.Request(f"{gateway_url}/api/speakers/embeddings", method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        log.debug("Could not fetch speaker embeddings from Gateway: %s", e)
        return []

    result = []
    for entry in data.get("embeddings", []):
        # Embeddings are stored as base64-encoded float32 arrays
        import base64
        raw = base64.b64decode(entry["embedding"])
        embedding = list(struct.unpack(f"{len(raw) // 4}f", raw))
        result.append({"name": entry["name"], "embedding": embedding})

    return result


def _cosine_similarity(a, b) -> float:
    """Compute cosine similarity between two vectors."""
    import numpy as np
    a = np.array(a, dtype=np.float32)
    b = np.array(b, dtype=np.float32)
    dot = np.dot(a, b)
    norm = np.linalg.norm(a) * np.linalg.norm(b)
    return float(dot / norm) if norm > 0 else 0.0


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


def whisper_segments_to_canonical(whisper_result: dict, speaker: str) -> list[dict]:
    """Convert raw Whisper result segments to canonical {start, end, text, speaker} format.

    Used for mic transcription where diarization is unnecessary (single speaker).
    """
    segments = []
    for seg in whisper_result.get("segments", []):
        text = seg.get("text", "").strip()
        if not text:
            continue
        segments.append({
            "start": round(seg["start"], 2),
            "end": round(seg["end"], 2),
            "text": text,
            "speaker": speaker,
        })
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


def check_audio_present(wav_path: str, threshold_rms: float = 0.003, sample_size: int = 50_000) -> bool:
    """Return False if the WAV is mostly digital silence, True if real audio is present.

    Samples up to `sample_size` frames to avoid reading large files fully.
    Threshold: ~-50 dBFS — above noise floor, below any speech.
    """
    import wave
    import struct
    import math

    try:
        with wave.open(wav_path, "rb") as wf:
            n_frames = wf.getnframes()
            sampwidth = wf.getsampwidth()
            if n_frames == 0 or sampwidth == 0:
                return False
            frames_to_read = min(n_frames, sample_size)
            raw = wf.readframes(frames_to_read)
            if sampwidth == 2:
                samples = struct.unpack(f"{len(raw) // 2}h", raw)
                rms = math.sqrt(sum(s * s for s in samples) / len(samples)) / 32768.0
            else:
                return True  # Non-16-bit: assume present
    except Exception as e:
        log.warning("Audio presence check failed (%s), proceeding anyway", e)
        return True

    if rms < threshold_rms:
        log.warning("Audio below silence threshold (rms=%.6f < %.3f) — skipping transcription", rms, threshold_rms)
        return False
    log.info("Audio presence confirmed (rms=%.4f)", rms)
    return True


def main():
    args = parse_args()

    metadata = json.loads(args.metadata)
    wav_path = args.wav
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    log.info("Post-processing: %s (%s)", metadata.get("title", "?"), wav_path)

    # Pre-check: skip Whisper entirely if the WAV is silent (phantom recording guard)
    if not check_audio_present(wav_path):
        log.warning("Skipping transcription: WAV is silent. No transcript will be written.")
        return

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

    # Step 7: Mic transcription (if --mic-wav provided)
    if args.mic_wav and Path(args.mic_wav).exists():
        log.info("Processing mic audio: %s", args.mic_wav)
        if check_audio_present(args.mic_wav):
            mic_result = transcribe_audio(args.mic_wav, args.model, args.language)
            # Speaker label for mic segments: "Self" unless metadata provides a name
            mic_speaker = metadata.get("selfName", "Self")
            mic_segments = whisper_segments_to_canonical(mic_result, mic_speaker)
            # Apply dictionary corrections to mic segments too
            if not args.skip_corrections:
                mic_segments = apply_corrections(mic_segments)
            mic_words = sum(len(s["text"].split()) for s in mic_segments)
            log.info("Mic transcription: %d segments, %d words (speaker: %s)",
                     len(mic_segments), mic_words, mic_speaker)
            # Merge: combine both segment lists and sort by start timestamp
            segments = sorted(segments + mic_segments, key=lambda s: s["start"])
        else:
            log.warning("Mic WAV is silent, skipping mic transcription")
    elif args.mic_wav:
        log.warning("Mic WAV not found: %s", args.mic_wav)

    # Step 8: Build and write output
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
