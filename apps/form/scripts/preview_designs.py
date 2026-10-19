from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit
import argparse
import hashlib
import json
import re
import signal
import struct
import time

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, required=True)
parser.add_argument('--host', required=True)
parser.add_argument('--port', type=int, required=True)
parser.add_argument('--lifetime', type=int, default=7200)
parser.add_argument('--capture-root', type=Path, required=True)
args = parser.parse_args()
root = args.root.resolve(strict=True)
capture_root = args.capture_root.resolve()
capture_root.mkdir(parents=True, exist_ok=True)

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/__raster.js':
            data = (Path(__file__).parent / 't3-raster.js').read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'text/javascript')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            super().do_GET()

    def do_POST(self):
        match = re.fullmatch(r'/__capture__/([abc])/([a-z0-9][a-z0-9._-]*\.png)', self.path)
        length = int(self.headers.get('Content-Length', '0'))
        if not match or not 0 < length <= 2_000_000:
            self.send_error(400)
            return
        data = self.rfile.read(length)
        if len(data) != length or data[:8] != b'\x89PNG\r\n\x1a\n' or len(data) < 24:
            self.send_error(400)
            return
        dimensions = struct.unpack('>II', data[16:24])
        if dimensions not in ((1206, 2622), (1320, 2868)):
            self.send_error(400, 'Expected exact phone raster dimensions')
            return
        target = capture_root / match[1] / match[2]
        target.parent.mkdir(parents=True, exist_ok=True)
        if len(list(capture_root.glob('*/*.png'))) >= 600:
            self.send_error(429)
            return
        digest = hashlib.sha256(data).hexdigest()
        if target.exists():
            if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                self.send_error(409)
                return
        else:
            with target.open('xb') as stream:
                stream.write(data)
        response = json.dumps({'path': str(target), 'sha256': digest,
                               'bytes': len(data), 'dimensions': dimensions}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def send_head(self):
        parts = PurePosixPath(unquote(urlsplit(self.path).path)).parts
        target = Path(self.translate_path(self.path)).resolve()
        if any(part.startswith('.') for part in parts) or not target.is_relative_to(root):
            self.send_error(404)
            return None
        return super().send_head()

def stop(signum, frame):
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
server = ThreadingHTTPServer((args.host, args.port), partial(Handler, directory=str(root)))
server.timeout = 1
deadline = time.monotonic() + args.lifetime
try:
    while time.monotonic() < deadline:
        server.handle_request()
finally:
    server.server_close()
