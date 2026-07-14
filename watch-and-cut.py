#!/usr/bin/env python3
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
INBOX = ROOT / 'Drop Videos Here'
OUTBOX = ROOT / 'edited'
LOG = ROOT / 'watch-and-cut.log'
FFMPEG = os.environ.get('FFMPEG') or shutil.which('ffmpeg') or '/opt/homebrew/bin/ffmpeg'
FFPROBE = os.environ.get('FFPROBE') or shutil.which('ffprobe') or '/opt/homebrew/bin/ffprobe'
VIDEO_EXTS = {'.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv'}
SILENCE_NOISE = '-18dB'
MINIMUM_SILENCE = 0.60
KEEP_EACH_SIDE = 0.32
EDGE_TRIM_PADDING = 0.25
MINIMUM_REMOVABLE_GAP = 0.60
FINAL_MINIMUM_REMOVABLE_GAP = 0.85
FINAL_EDGE_TRIM_PADDING = 0.65
MINIMUM_KEEP_SEGMENT = 1.50
MINIMUM_REMOVED_CUT = 0.35
TARGET_REMOVED_RATIO = 0.15
TARGET_REMOVED_MIN = 2.00
TARGET_REMOVED_MAX = 8.00
MAX_CUTS_PER_MINUTE = 18
MIN_TIME_BETWEEN_CUTS = 0.45
FADE = 0.020
DETECT_TIMEOUT_PER_MINUTE = 20
POLL_SECONDS = 1
VIDEO_CODEC = os.environ.get('VIDEO_CODEC') or 'h264_videotoolbox'
VIDEO_BITRATE = os.environ.get('VIDEO_BITRATE') or '8M'
RENDER_MODE = os.environ.get('RENDER_MODE') or 'encode'
WORD_AWARE = os.environ.get('WORD_AWARE', '1') != '0'
WHISPER_MODEL_NAME = os.environ.get('WHISPER_MODEL') or 'base'
WORD_LEAD_BUFFER = 0.10
WORD_POST_BUFFER = 0.22
WORD_PRE_BUFFER = 0.12
WORD_FINAL_BUFFER = 0.45
WORD_MIN_REMOVED_CUT = 0.15
WORD_MINIMUM_KEEP_SEGMENT = 0.85
WHISPER_MODEL = None
WORD_PROFILE = {
    'name': 'word-aware',
    'minimum_keep_segment': WORD_MINIMUM_KEEP_SEGMENT,
    'minimum_removed_cut': WORD_MIN_REMOVED_CUT,
}
CUT_PROFILES = [
    {
        'name': 'word-safe',
        'noise': '-18dB',
        'minimum_silence': 0.60,
        'keep_each_side': 0.40,
        'edge_trim_padding': 0.25,
        'minimum_removable_gap': 0.60,
        'final_minimum_removable_gap': 0.85,
        'final_edge_trim_padding': 0.75,
        'minimum_keep_segment': 1.50,
        'minimum_removed_cut': 0.35,
    },
    {
        'name': 'balanced',
        'noise': '-18dB',
        'minimum_silence': 0.55,
        'keep_each_side': 0.34,
        'edge_trim_padding': 0.25,
        'minimum_removable_gap': 0.55,
        'final_minimum_removable_gap': 0.75,
        'final_edge_trim_padding': 0.65,
        'minimum_keep_segment': 1.25,
        'minimum_removed_cut': 0.25,
    },
    {
        'name': 'strong',
        'noise': '-17dB',
        'minimum_silence': 0.50,
        'keep_each_side': 0.30,
        'edge_trim_padding': 0.22,
        'minimum_removable_gap': 0.50,
        'final_minimum_removable_gap': 0.70,
        'final_edge_trim_padding': 0.58,
        'minimum_keep_segment': 1.10,
        'minimum_removed_cut': 0.20,
    },
    {
        'name': 'hard',
        'noise': '-16dB',
        'minimum_silence': 0.45,
        'keep_each_side': 0.28,
        'edge_trim_padding': 0.20,
        'minimum_removable_gap': 0.45,
        'final_minimum_removable_gap': 0.65,
        'final_edge_trim_padding': 0.52,
        'minimum_keep_segment': 1.00,
        'minimum_removed_cut': 0.18,
    },
    {
        'name': 'auto-cut',
        'noise': '-15dB',
        'minimum_silence': 0.40,
        'keep_each_side': 0.18,
        'edge_trim_padding': 0.18,
        'minimum_removable_gap': 0.40,
        'final_minimum_removable_gap': 0.55,
        'final_edge_trim_padding': 0.35,
        'minimum_keep_segment': 0.85,
        'minimum_removed_cut': 0.15,
    },
    {
        'name': 'max-cut',
        'noise': '-14dB',
        'minimum_silence': 0.35,
        'keep_each_side': 0.16,
        'edge_trim_padding': 0.16,
        'minimum_removable_gap': 0.35,
        'final_minimum_removable_gap': 0.50,
        'final_edge_trim_padding': 0.32,
        'minimum_keep_segment': 0.75,
        'minimum_removed_cut': 0.12,
    },
]

INBOX.mkdir(parents=True, exist_ok=True)
OUTBOX.mkdir(parents=True, exist_ok=True)

def log(message):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}"
    print(line, flush=True)
    with LOG.open('a', encoding='utf-8') as f:
        f.write(line + '\n')

def safe_stem(path):
    stem = re.sub(r'[^A-Za-z0-9 _.-]+', '', path.stem).strip()
    stem = re.sub(r'\s+', '-', stem)
    return stem or 'video'

def output_for(path):
    return OUTBOX / f"{safe_stem(path)}-edited.mp4"

def stable(path, checks=2, delay=0.5):
    last = -1
    same = 0
    for _ in range(checks + 4):
        try:
            size = path.stat().st_size
        except FileNotFoundError:
            return False
        if size > 0 and size == last:
            same += 1
            if same >= checks:
                return True
        else:
            same = 0
            last = size
        time.sleep(delay)
    return False

def duration(path):
    out = subprocess.check_output([FFPROBE, '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', str(path)], text=True).strip()
    return float(out)

def default_profile():
    return CUT_PROFILES[0]

def detect_silences(path, total, profile=None):
    profile = profile or default_profile()
    timeout = max(120, int(total / 60 * DETECT_TIMEOUT_PER_MINUTE + 60))
    proc = subprocess.run([FFMPEG, '-nostdin', '-hide_banner', '-i', str(path), '-vn', '-af', f"silencedetect=noise={profile['noise']}:d={profile['minimum_silence']}", '-f', 'null', '-'], text=True, capture_output=True, timeout=timeout)
    starts = []
    silences = []
    for line in (proc.stderr + proc.stdout).splitlines():
        m = re.search(r'silence_start: ([0-9.]+)', line)
        if m:
            starts.append(float(m.group(1)))
        m = re.search(r'silence_end: ([0-9.]+) \| silence_duration: ([0-9.]+)', line)
        if m and starts:
            silences.append((starts.pop(0), float(m.group(1)), float(m.group(2))))
    _, removed = keep_intervals(total, silences, profile)
    log(f"Profile {profile['name']}: detected {len(silences)} silence gap(s), removable {sum(b - a for a, b in removed):.2f}s")
    return silences

def extract_audio_for_words(path, wav_path):
    subprocess.check_call([
        FFMPEG, '-nostdin', '-loglevel', 'error', '-y',
        '-i', str(path),
        '-vn', '-ac', '1', '-ar', '16000',
        str(wav_path),
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def load_whisper_model():
    global WHISPER_MODEL
    if WHISPER_MODEL is not None:
        return WHISPER_MODEL
    from faster_whisper import WhisperModel
    log(f"Loading word listener model ({WHISPER_MODEL_NAME})")
    WHISPER_MODEL = WhisperModel(WHISPER_MODEL_NAME, device='cpu', compute_type='int8')
    return WHISPER_MODEL

def transcribe_words(path):
    if not WORD_AWARE:
        return []
    try:
        with tempfile.TemporaryDirectory(prefix='dead-space-words-') as temp_dir:
            wav_path = Path(temp_dir) / 'audio.wav'
            extract_audio_for_words(path, wav_path)
            model = load_whisper_model()
            segments, _ = model.transcribe(str(wav_path), word_timestamps=True, vad_filter=False)
            words = []
            for segment in segments:
                for word in segment.words or []:
                    if word.start is None or word.end is None:
                        continue
                    text = (word.word or '').strip()
                    if text:
                        words.append((float(word.start), float(word.end), text))
            words.sort(key=lambda item: item[0])
            log(f"Word listener found {len(words)} word timestamp(s)")
            return words
    except Exception as exc:
        log(f"Word listener unavailable; using silence only ({type(exc).__name__}: {exc})")
        return []

def merge_intervals(intervals):
    merged = []
    for a, b in sorted((a, b) for a, b in intervals if b > a):
        if merged and a <= merged[-1][1] + 0.005:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged

def keep_from_removed(total, removed):
    keeps = []
    cur = 0.0
    for a, b in removed:
        if a > cur:
            keeps.append((cur, a))
        cur = max(cur, b)
    if cur < total:
        keeps.append((cur, total))
    keeps = [(a, b) for a, b in keeps if b - a > 0.04]
    return keeps or [(0, total)]

def word_protected_intervals(words, total):
    protected = []
    for start, end, _ in words:
        protected.append((max(0, start - WORD_LEAD_BUFFER), min(total, end + WORD_POST_BUFFER)))
    return merge_intervals(protected)

def subtract_protected_intervals(cut, protected):
    pieces = [cut]
    for protect_start, protect_end in protected:
        next_pieces = []
        for start, end in pieces:
            if protect_end <= start or protect_start >= end:
                next_pieces.append((start, end))
                continue
            if start < protect_start:
                next_pieces.append((start, protect_start))
            if protect_end < end:
                next_pieces.append((protect_end, end))
        pieces = next_pieces
        if not pieces:
            break
    return pieces

def clamp_removals_away_from_words(removals, words, total, profile=None):
    profile = profile or WORD_PROFILE
    protected = word_protected_intervals(words, total)
    safe = []
    for cut in removals:
        safe.extend(subtract_protected_intervals(cut, protected))
    safe = [(max(0, a), min(total, b)) for a, b in safe if b - a >= profile['minimum_removed_cut']]
    safe = merge_intervals(safe)
    safe = remove_fragmenting_cuts(total, safe, profile)
    safe = smooth_cut_cadence(total, safe)
    return safe

def word_gap_removals(words, total):
    if not words:
        return []

    removals = []
    first_start = max(0, words[0][0] - WORD_LEAD_BUFFER)
    if first_start >= WORD_MIN_REMOVED_CUT:
        removals.append((0, first_start))

    for prev_word, next_word in zip(words, words[1:]):
        prev_end = prev_word[1]
        next_start = next_word[0]
        start = prev_end + WORD_POST_BUFFER
        end = next_start - WORD_PRE_BUFFER
        if end - start >= WORD_MIN_REMOVED_CUT:
            removals.append((start, end))

    final_start = words[-1][1] + WORD_FINAL_BUFFER
    if total - final_start >= WORD_MIN_REMOVED_CUT:
        removals.append((final_start, total))

    removals = merge_intervals((max(0, a), min(total, b)) for a, b in removals)
    removals = remove_fragmenting_cuts(total, removals, WORD_PROFILE)
    removals = smooth_cut_cadence(total, removals)
    return removals

def word_aware_candidate(total, words, base_removed=None):
    removals = word_gap_removals(words, total)
    if base_removed:
        removals = merge_intervals(removals + clamp_removals_away_from_words(base_removed, words, total, WORD_PROFILE))
        removals = remove_fragmenting_cuts(total, removals, WORD_PROFILE)
        removals = smooth_cut_cadence(total, removals)
    keeps = keep_from_removed(total, removals)
    return {
        'profile': WORD_PROFILE,
        'silences': [],
        'keeps': keeps,
        'removed': removals,
        'removed_seconds': removed_seconds(removals),
        'words': words,
    }

def keep_intervals(total, silences, profile=None):
    profile = profile or default_profile()
    remove = []
    for start, end, gap in silences:
        if start <= 0.02:
            if gap >= profile['minimum_removable_gap']:
                remove.append((0, max(0, end - profile['edge_trim_padding'])))
        elif end >= total - 0.02:
            if gap >= profile['final_minimum_removable_gap']:
                remove.append((min(total, start + profile['final_edge_trim_padding']), total))
        elif gap >= max(profile['minimum_removable_gap'], profile['keep_each_side'] * 2 + 0.03):
            remove.append((start + profile['keep_each_side'], end - profile['keep_each_side']))
    remove = [(a, b) for a, b in remove if b - a >= profile['minimum_removed_cut']]
    remove.sort()
    merged = merge_intervals(remove)
    merged = remove_fragmenting_cuts(total, merged, profile)
    merged = smooth_cut_cadence(total, merged)
    return keep_from_removed(total, merged), merged

def remove_fragmenting_cuts(total, remove, profile=None):
    profile = profile or default_profile()
    filtered = list(remove)
    while True:
        keeps = keep_segments_from_removals(total, filtered)
        tiny = next(((index, a, b) for index, (a, b) in enumerate(keeps) if 0 < b - a < profile['minimum_keep_segment']), None)
        if tiny is None:
            return filtered

        keep_index, _, _ = tiny
        drop_indexes = []
        if keep_index > 0:
            drop_indexes.append(keep_index - 1)
        if keep_index < len(filtered):
            drop_indexes.append(keep_index)
        if not drop_indexes:
            return filtered

        filtered = [item for index, item in enumerate(filtered) if index not in set(drop_indexes)]

def keep_segments_from_removals(total, remove):
    keeps = []
    cur = 0.0
    for a, b in remove:
        if a > cur:
            keeps.append((cur, a))
        cur = max(cur, b)
    if cur < total:
        keeps.append((cur, total))
    return keeps

def max_cuts_for_duration(total):
    return max(3, int(total / 60 * MAX_CUTS_PER_MINUTE + 0.999))

def cut_duration(cut):
    return cut[1] - cut[0]

def smooth_cut_cadence(total, remove):
    filtered = list(remove)
    while True:
        close_pair = None
        for index in range(len(filtered) - 1):
            gap_between_cuts = filtered[index + 1][0] - filtered[index][1]
            if gap_between_cuts < MIN_TIME_BETWEEN_CUTS:
                close_pair = index
                break
        if close_pair is None:
            break

        first = filtered[close_pair]
        second = filtered[close_pair + 1]
        drop_index = close_pair if cut_duration(first) <= cut_duration(second) else close_pair + 1
        filtered.pop(drop_index)

    max_cuts = max_cuts_for_duration(total)
    while len(filtered) > max_cuts:
        drop_index = min(range(len(filtered)), key=lambda index: cut_duration(filtered[index]))
        filtered.pop(drop_index)
    return filtered

def removed_seconds(removed):
    return sum(b - a for a, b in removed)

def target_removed_seconds(total):
    return min(TARGET_REMOVED_MAX, max(TARGET_REMOVED_MIN, total * TARGET_REMOVED_RATIO))

def choose_cut_plan(path, total):
    target = target_removed_seconds(total)
    best = None
    words = transcribe_words(path)
    if words:
        word_candidate = word_aware_candidate(total, words)
        best = word_candidate
        log(f"Word-aware gaps remove {word_candidate['removed_seconds']:.2f}s before silence assist; target is {target:.2f}s")

    for profile in CUT_PROFILES:
        silences = detect_silences(path, total, profile)
        keeps, removed = keep_intervals(total, silences, profile)
        if words:
            removed = merge_intervals(word_gap_removals(words, total) + clamp_removals_away_from_words(removed, words, total, WORD_PROFILE))
            removed = remove_fragmenting_cuts(total, removed, WORD_PROFILE)
            removed = smooth_cut_cadence(total, removed)
            keeps = keep_from_removed(total, removed)
            profile = WORD_PROFILE
        candidate = {
            'profile': profile,
            'silences': silences,
            'keeps': keeps,
            'removed': removed,
            'removed_seconds': removed_seconds(removed),
            'words': words,
        }
        if best is None or candidate['removed_seconds'] > best['removed_seconds']:
            best = candidate
        if candidate['removed_seconds'] >= target:
            log(f"Selected {profile['name']} profile for {candidate['removed_seconds']:.2f}s removed; target was {target:.2f}s")
            return candidate
    log(f"Selected {best['profile']['name']} profile for best available {best['removed_seconds']:.2f}s removed; target was {target:.2f}s")
    return best

def encode_render(path, out, keeps):
    expr = '+'.join(f"between(t\\,{a:.6f}\\,{b:.6f})" for a, b in keeps)
    filters = f"[0:v]select='{expr}',setpts=N/FRAME_RATE/TB[v];[0:a]aselect='{expr}',asetpts=N/SR/TB[a]"
    tmp = out.with_suffix('.processing.mp4')
    if tmp.exists():
        tmp.unlink()
    cmd = [FFMPEG, '-nostdin', '-loglevel', 'error', '-y', '-i', str(path), '-filter_complex', filters, '-map', '[v]', '-map', '[a]', '-c:v', VIDEO_CODEC, '-b:v', VIDEO_BITRATE, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(tmp)]
    subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    tmp.replace(out)

def copy_render(path, out, keeps):
    tmp = out.with_suffix('.processing.mp4')
    if tmp.exists():
        tmp.unlink()
    with tempfile.TemporaryDirectory(prefix='dead-space-cutter-', dir=str(OUTBOX)) as temp_dir:
        temp_dir = Path(temp_dir)
        list_path = temp_dir / 'segments.txt'
        segment_paths = []
        for index, (start, end) in enumerate(keeps):
            segment = temp_dir / f'segment-{index:03d}.mp4'
            segment_paths.append(segment)
            subprocess.check_call([
                FFMPEG, '-nostdin', '-loglevel', 'error', '-y',
                '-i', str(path),
                '-ss', f'{start:.6f}', '-t', f'{end - start:.6f}',
                '-map', '0:v:0', '-map', '0:a?',
                '-c', 'copy',
                '-avoid_negative_ts', 'make_zero',
                str(segment),
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        list_path.write_text(''.join(f"file '{segment.name}'\n" for segment in segment_paths), encoding='utf-8')
        subprocess.check_call([
            FFMPEG, '-nostdin', '-loglevel', 'error', '-y',
            '-f', 'concat', '-safe', '0',
            '-i', str(list_path),
            '-c', 'copy',
            '-movflags', '+faststart',
            str(tmp),
        ], cwd=temp_dir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    tmp.replace(out)

def render(path, out):
    total = duration(path)
    plan = choose_cut_plan(path, total)
    keeps = plan['keeps']
    removed = plan['removed']
    log(f"Rendering {path.name}: {len(keeps)} kept segment(s), removing {plan['removed_seconds']:.2f}s with {plan['profile']['name']} profile")
    try:
        if RENDER_MODE == 'copy':
            copy_render(path, out, keeps)
        else:
            encode_render(path, out, keeps)
    except subprocess.CalledProcessError:
        log(f"Fast copy render failed for {path.name}; retrying with encoder")
        encode_render(path, out, keeps)
    return {
        'input_duration': total,
        'output_duration': sum(b - a for a, b in keeps),
        'removed_seconds': sum(b - a for a, b in removed),
        'segments': len(keeps),
    }

def should_process(path):
    if path.name.startswith('.') or path.suffix.lower() not in VIDEO_EXTS:
        return False
    out = output_for(path)
    if not out.exists():
        return True
    return out.stat().st_mtime < path.stat().st_mtime

def main():
    log(f"Watching {INBOX}")
    while True:
        try:
            for path in sorted(INBOX.iterdir(), key=lambda p: p.stat().st_mtime if p.exists() else 0):
                if not should_process(path):
                    continue
                log(f"Picked up {path.name}")
                if not stable(path):
                    log(f"Waiting for copy to finish: {path.name}")
                    continue
                out = output_for(path)
                stats = render(path, out)
                log(f"Edited {path.name} -> {out.name} {json.dumps(stats, sort_keys=True)}")
        except Exception as exc:
            log(f"ERROR {type(exc).__name__}: {exc}")
        time.sleep(POLL_SECONDS)

if __name__ == '__main__':
    main()
