#!/usr/bin/env python3
import http.server
import json
import subprocess
import sys
import os

class SandboxHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress default logging
        pass
    
    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"status": "healthy"}).encode())
        else:
            self.send_response(404)
            self.end_headers()
    
    def do_POST(self):
        if self.path != '/execute':
            self.send_response(404)
            self.end_headers()
            return
        
        # Read request body
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8')
        
        try:
            data = json.loads(body)
            command = data.get('command', '')
            timeout = data.get('timeout', 30000) / 1000  # Convert ms to seconds
        except json.JSONDecodeError:
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Invalid JSON"}).encode())
            return
        
        # Block dangerous commands
        dangerous = ['rm -rf /', ':(){ :|: & };:', '> /dev/null']
        for d in dangerous:
            if d in command:
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Dangerous command blocked"}).encode())
                return
        
        # Execute command
        try:
            result = subprocess.run(
                command,
                shell=True,
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

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    server = http.server.HTTPServer(('0.0.0.0', port), SandboxHandler)
    print(f"Sandbox server running on port {port}", file=sys.stderr)
    server.serve_forever()
