#!/usr/bin/env python3
"""Restore Codex auth from persistent storage on sandbox startup."""
import os
import json
import sys

AUTH_PATH = os.path.expanduser("~/.codex/auth.json")
AUTH_DIR = os.path.dirname(AUTH_PATH)
PERSISTENT_AUTH = "/workspace/.codex-auth/auth.json"

def restore_auth() -> bool:
    if not os.path.exists(PERSISTENT_AUTH):
        print(f"[RESTORE] No persisted auth at {PERSISTENT_AUTH}", file=sys.stderr)
        return False

    try:
        os.makedirs(AUTH_DIR, exist_ok=True)

        with open(PERSISTENT_AUTH, "r") as f:
            auth_data = json.load(f)

        with open(AUTH_PATH, "w") as f:
            json.dump(auth_data, f)

        print(f"[RESTORE] Restored Codex auth from {PERSISTENT_AUTH} -> {AUTH_PATH}", file=sys.stderr)
        return True

    except Exception as e:
        # Never block server startup
        print(f"[RESTORE] Failed to restore auth (continuing without it): {e}", file=sys.stderr)
        return False

if __name__ == "__main__":
    restore_auth()