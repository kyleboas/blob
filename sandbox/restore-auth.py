#!/usr/bin/env python3
"""Restore Codex auth from persistent storage on sandbox startup."""
import os
import json

AUTH_PATH = os.path.expanduser("~/.codex/auth.json")
AUTH_DIR = os.path.dirname(AUTH_PATH)

def restore_auth():
    # Check if auth file exists in mounted persistent storage
    persistent_auth = "/workspace/.codex-auth/auth.json"
    
    if os.path.exists(persistent_auth):
        # Create .codex directory
        os.makedirs(AUTH_DIR, exist_ok=True)
        
        # Copy auth file
        with open(persistent_auth, 'r') as f:
            auth_data = json.load(f)
        
        with open(AUTH_PATH, 'w') as f:
            json.dump(auth_data, f)
        
        print(f"Restored Codex auth from {persistent_auth}", file=os.sys.stderr)
        return True
    
    return False

if __name__ == "__main__":
    restore_auth()
