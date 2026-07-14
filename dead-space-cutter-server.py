#!/usr/bin/env python3
import cgi
import importlib.util
import json
import mimetypes
import os
import re
import threading
import time
import urllib.parse
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get('DEAD_SPACE_CUTTER_PORT', '8877'))
VIDEO_EXTS = {'.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv'}
LOCK = threading.Lock()

spec = importlib.util.spec_from_file_location('watch_and_cut', ROOT / 'watch-and-cut.py')
cutter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cutter)

def file_info(path, base_url=''):
    stat = path.stat()
    return {
        'name': path.name,
        'size': stat.st_size,
        'size_label': format_size(stat.st_size),
        'modified': stat.st_mtime,
        'modified_label': time.strftime('%b %d, %I:%M %p', time.localtime(stat.st_mtime)),
        'url': f"{base_url}/{urllib.parse.quote(path.name)}" if base_url else '',
    }

def format_size(size):
    units = ['B', 'KB', 'MB', 'GB']
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.1f} {unit}" if unit != 'B' else f"{int(value)} B"
        value /= 1024

def list_files(folder, edited=False):
    files = []
    for path in folder.iterdir():
        if path.name.startswith('.') or path.suffix.lower() not in VIDEO_EXTS:
            continue
        files.append(file_info(path, '/edited' if edited else ''))
    return sorted(files, key=lambda item: item['modified'], reverse=True)

def log_tail():
    if not cutter.LOG.exists():
        return ''
    lines = cutter.LOG.read_text(encoding='utf-8', errors='replace').splitlines()
    return '\n'.join(lines[-30:])

def unique_upload_path(name):
    safe = re.sub(r'[^A-Za-z0-9 ._-]+', '', Path(name).name).strip() or 'video.mov'
    target = cutter.INBOX / safe
    if not target.exists():
        return target
    stem = target.stem
    suffix = target.suffix
    stamp = time.strftime('%Y%m%d-%H%M%S')
    return cutter.INBOX / f"{stem}-{stamp}{suffix}"

def process_path(path):
    if path.suffix.lower() not in VIDEO_EXTS:
        raise ValueError('That file is not a supported video.')
    out = cutter.output_for(path)
    stats = cutter.render(path, out)
    cutter.log(f"Edited {path.name} -> {out.name} {json.dumps(stats, sort_keys=True)}")
    return out, stats

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        cutter.log(f"WEB {fmt % args}")

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/status':
            self.send_json({
                'drop_files': list_files(cutter.INBOX),
                'edited_files': list_files(cutter.OUTBOX, edited=True),
                'log_tail': log_tail(),
            })
            return
        if parsed.path.startswith('/edited/'):
            name = urllib.parse.unquote(parsed.path.removeprefix('/edited/'))
            self.serve_file(cutter.OUTBOX / name)
            return
        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/upload':
            self.handle_upload()
            return
        if parsed.path == '/api/process-existing':
            self.handle_process_existing()
            return
        self.send_error(404)

    def handle_upload(self):
        if LOCK.locked():
            self.send_json({'error': 'A video is already being edited. Try again in a moment.'}, status=409)
            return

        form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ={
            'REQUEST_METHOD': 'POST',
            'CONTENT_TYPE': self.headers.get('Content-Type', ''),
        })
        item = form['video'] if 'video' in form else None
        if item is None or not getattr(item, 'filename', ''):
            self.send_json({'error': 'No video was uploaded.'}, status=400)
            return

        target = unique_upload_path(item.filename)
        with target.open('wb') as f:
            while True:
                chunk = item.file.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)

        with LOCK:
            try:
                out, stats = process_path(target)
            except Exception as exc:
                cutter.log(f"ERROR {type(exc).__name__}: {exc}")
                self.send_json({'error': str(exc)}, status=500)
                return

        self.send_json({
            'message': f"Edited {target.name} in {stats['output_duration']:.1f}s output",
            'output': out.name,
            'stats': stats,
        })

    def handle_process_existing(self):
        if LOCK.locked():
            self.send_json({'error': 'A video is already being edited. Try again in a moment.'}, status=409)
            return

        processed = []
        with LOCK:
            try:
                for path in sorted(cutter.INBOX.iterdir(), key=lambda p: p.stat().st_mtime if p.exists() else 0):
                    if not cutter.should_process(path):
                        continue
                    out, stats = process_path(path)
                    processed.append({'input': path.name, 'output': out.name, 'stats': stats})
            except Exception as exc:
                cutter.log(f"ERROR {type(exc).__name__}: {exc}")
                self.send_json({'error': str(exc)}, status=500)
                return

        noun = 'video' if len(processed) == 1 else 'videos'
        self.send_json({'message': f"Processed {len(processed)} {noun}", 'processed': processed})

    def serve_file(self, path):
        if not path.exists() or path.parent != cutter.OUTBOX:
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(path.stat().st_size))
        self.end_headers()
        with path.open('rb') as f:
            while True:
                chunk = f.read(1024 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def send_json(self, payload, status=200):
        data = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

def main():
    cutter.INBOX.mkdir(parents=True, exist_ok=True)
    cutter.OUTBOX.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    url = f'http://127.0.0.1:{PORT}/'
    cutter.log(f"Dashboard running at {url}")
    webbrowser.open(url)
    server.serve_forever()

if __name__ == '__main__':
    main()
