#!/usr/bin/env python3
"""Tiny static server for VocalNudge (AudioWorklet needs http, not file://).

Usage:  python3 server.py [port]
"""
import http.server
import socketserver
import os
import sys
import json
import urllib.error
import urllib.request

os.chdir(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123

def load_dotenv():
    path = os.path.join(os.getcwd(), '.env')
    if not os.path.exists(path):
        return
    with open(path, encoding='utf-8') as env_file:
        for line in env_file:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"\''))

load_dotenv()

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/api/speak':
            self.send_error(404)
            return
        key = os.environ.get('ELEVENLABS_API_KEY')
        if not key:
            self.send_error(404, 'ElevenLabs is not configured')
            return
        try:
            length = min(int(self.headers.get('Content-Length', '0')), 4096)
            payload = json.loads(self.rfile.read(length))
            text = str(payload.get('text', '')).strip()
            if not text:
                self.send_error(400, 'Text is required')
                return
            voice_id = os.environ.get('ELEVENLABS_VOICE_ID', '21m00Tcm4TlvDq8ikWAM')
            request = urllib.request.Request(
                f'https://api.elevenlabs.io/v1/text-to-speech/{voice_id}',
                data=json.dumps({
                    'text': text,
                    'model_id': os.environ.get('ELEVENLABS_MODEL_ID', 'eleven_multilingual_v2'),
                    'voice_settings': {
                        'stability': 0.32,
                        'similarity_boost': 0.78,
                        'style': 0.72,
                        'use_speaker_boost': True,
                    },
                }).encode(),
                headers={'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg'},
                method='POST',
            )
            with urllib.request.urlopen(request, timeout=30) as response:
                audio = response.read()
            self.send_response(200)
            self.send_header('Content-Type', 'audio/mpeg')
            self.send_header('Content-Length', str(len(audio)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(audio)
        except (ValueError, urllib.error.URLError, TimeoutError) as error:
            self.send_error(502, f'Voice generation failed: {error}')

Handler.extensions_map[".js"] = "text/javascript"
Handler.extensions_map[".mjs"] = "text/javascript"

with socketserver.ThreadingTCPServer(("", PORT), Handler) as httpd:
    print(f"VocalNudge running at http://localhost:{PORT}")
    print("Press Ctrl+C to stop.")
    httpd.serve_forever()
