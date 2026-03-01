#!/usr/bin/env python3
"""Simple HTTP server for Cloudflare Sandbox container."""
import http.server
import json
import subprocess
import sys
import os
import time
import re

AUTH_PATH = os.path.expanduser("~/.codex/auth.json")
AUTH_DIR = os.path.dirname(AUTH_PATH)
PERSISTENT_AUTH_DIR = "/workspace/.codex-auth"


def parse_codex_login_output(output: str):
    """Extract device login URL + code from codex login output."""
    url_match = re.search(r"https://[^\s\)\]]+", output)
    code_match = re.search(r"\b([A-Z0-9]{4}-[A-Z0-9]{4}|[A-Z0-9]{8})\b", output)
    return (
        url_match.group(0) if url_match else None,
        code_match.group(1) if code_match else None,
    )

class SandboxHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"[SERVER] {format % args}", file=sys.stderr)
    
    def do_GET(self):
        self.log_message(f"GET {self.path}")
        if self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"status": "healthy", "time": time.time()}).encode())
        elif self.path == '/codex/status':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                "authenticated": os.path.exists(AUTH_PATH)
            }).encode())
        else:
            self.send_response(404)
            self.end_headers()
    
    def do_POST(self):
        self.log_message(f"POST {self.path}")
        if self.path == '/execute':
            self.handle_execute()
        elif self.path == '/codex/login/start':
            self.handle_codex_login_start()
        elif self.path == '/codex/auth/save':
            self.handle_codex_auth_save()
        elif self.path == '/codex/run':
            self.handle_codex_run()
        else:
            self.send_response(404)
            self.end_headers()
    
    def handle_execute(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8')
        
        try:
            data = json.loads(body)
            command = data.get('command', '')
            timeout = data.get('timeout', 30000) / 1000
        except json.JSONDecodeError:
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Invalid JSON"}).encode())
            return
        
        # Block dangerous commands
        dangerous = ['rm -rf /', ':(){ :|: & };:']
        for d in dangerous:
            if d in command:
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Dangerous command blocked"}).encode())
                return
        
        try:
            result = subprocess.run(
                command, shell=True, capture_output=True, text=True,
                timeout=timeout, cwd='/workspace'
            )
            response = {
                "stdout": result.stdout,
                "stderr": result.stderr,
                "exitCode": result.returncode
            }
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())
        except subprocess.TimeoutExpired:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                "stdout": "",
                "stderr": f"Command timed out after {timeout}s",
                "exitCode": 124
            }).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                "stdout": "",
                "stderr": str(e),
                "exitCode": 1
            }).encode())
    
    def handle_codex_login_start(self):
        """Start Codex device-code login flow."""
        try:
            # Run codex login to get device code
            result = subprocess.run(
                ["codex", "login"],
                capture_output=True,
                text=True,
                timeout=30
            )
            
            output = result.stdout + result.stderr
            url, code = parse_codex_login_output(output)

            if not url or not code:
                self.send_response(502)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({
                    "error": "Could not parse device-login details from codex output.",
                    "output": output,
                }).encode())
                return
            
            response = {
                "url": url,
                "code": code,
                "instructions": f"1. Open {url} on your device\n2. Enter code: {code}\n3. Complete login\n4. Call /codex/auth/save to persist credentials"
            }
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())
            
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())
    
    def handle_codex_auth_save(self):
        """Save Codex auth to persistent storage."""
        try:
            if not os.path.exists(AUTH_PATH):
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": "No auth.json found. Complete login first."}).encode())
                return
            
            # Read auth file
            with open(AUTH_PATH, 'r') as f:
                auth_data = json.load(f)
            
            # Ensure persistent directory exists
            os.makedirs(PERSISTENT_AUTH_DIR, exist_ok=True)
            
            # Copy to persistent storage
            persistent_path = os.path.join(PERSISTENT_AUTH_DIR, "auth.json")
            with open(persistent_path, 'w') as f:
                json.dump(auth_data, f)
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                "saved": True,
                "message": "Auth credentials persisted to storage"
            }).encode())
            
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())
    
    def handle_codex_run(self):
        """Run Codex with a prompt."""
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8')
        
        try:
            data = json.loads(body)
            prompt = data.get('prompt', '')
            timeout = data.get('timeout', 120000) / 1000  # Default 2 min
        except json.JSONDecodeError:
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Invalid JSON"}).encode())
            return
        
        # Check auth exists
        if not os.path.exists(AUTH_PATH):
            self.send_response(401)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                "error": "Not authenticated. Call /codex/login/start first."
            }).encode())
            return
        
        try:
            # Run codex with the prompt
            result = subprocess.run(
                ["codex", "--quiet", prompt],
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd='/workspace'
            )
            
            response = {
                "stdout": result.stdout,
                "stderr": result.stderr,
                "exitCode": result.returncode
            }
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())
            
        except subprocess.TimeoutExpired:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                "stdout": "",
                "stderr": f"Codex timed out after {timeout}s",
                "exitCode": 124
            }).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                "stdout": "",
                "stderr": str(e),
                "exitCode": 1
            }).encode())

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    print(f"Starting sandbox server on port {port}...", file=sys.stderr)
    sys.stderr.flush()
    
    try:
        server = http.server.HTTPServer(('0.0.0.0', port), SandboxHandler)
        print(f"Sandbox server running on port {port}", file=sys.stderr)
        sys.stderr.flush()
        server.serve_forever()
    except Exception as e:
        print(f"Failed to start server: {e}", file=sys.stderr)
        sys.stderr.flush()
        raise
