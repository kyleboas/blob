"""User-facing settings manager for Blob.

Blob calls this script to persist runtime preferences in blob_settings.json
so users can configure behaviour in plain English without touching env vars.

Usage:
    python blob_config.py list              # show all settings and current values
    python blob_config.py get KEY           # print a single value
    python blob_config.py set KEY VALUE     # persist a setting
    python blob_config.py unset KEY         # revert a setting to its default
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Settings that can be configured by the user via plain English.
# Maps env-var key → (human label, default, description)
SETTINGS_SCHEMA: dict[str, tuple[str, object, str]] = {
    "AUTONOMOUS_DAILY_TASK_LIMIT": (
        "daily task limit",
        10,
        "Max tasks the autonomous loop runs per day (~$1.50/task at mixed Haiku/Sonnet rates). "
        "10 ≈ $15/month, 20 ≈ $38/month.",
    ),
    "MAX_STEPS": (
        "max steps per task",
        25,
        "Max agent steps (LLM calls) per task. Lower = cheaper per task but may not finish complex work.",
    ),
    "AUTONOMOUS_LOOP_INTERVAL": (
        "idle sleep (seconds)",
        60,
        "Seconds to sleep when the task queue is empty and no new tasks can be generated.",
    ),
    "SELF_MODIFY_LIMIT_SESSION": (
        "self-modifications per session",
        3,
        "Max times Blob can modify its own source files in a single session.",
    ),
    "SELF_MODIFY_LIMIT_DAY": (
        "self-modifications per day",
        10,
        "Max times Blob can modify its own source files per day (resets midnight UTC).",
    ),
    "APPROVAL_TIMEOUT_MINUTES": (
        "approval timeout (minutes)",
        30,
        "Minutes to wait for a human to approve a command before auto-rejecting.",
    ),
    "COMMAND_TIMEOUT": (
        "command timeout (seconds)",
        30,
        "Max seconds a sandboxed bash command may run.",
    ),
    "MODEL_ROUTINE": (
        "model for routine tasks",
        "claude-haiku-4-5",
        "Model used for routine (non-complex) tasks.",
    ),
    "MODEL_COMPLEX": (
        "model for complex tasks",
        "claude-sonnet-4-5",
        "Model used for tasks with keywords: refactor, architecture, security, self-modify.",
    ),
}

SETTINGS_FILE = Path(__file__).resolve().parent / "blob_settings.json"


def _load() -> dict:
    if not SETTINGS_FILE.exists():
        return {}
    try:
        return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save(data: dict) -> None:
    SETTINGS_FILE.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _coerce(key: str, raw: str) -> object:
    """Cast VALUE string to the type implied by the schema default."""
    _, default, _ = SETTINGS_SCHEMA.get(key, ("", raw, ""))
    if isinstance(default, int):
        return int(raw)
    if isinstance(default, float):
        return float(raw)
    return raw


def cmd_list() -> None:
    settings = _load()
    print(f"{'KEY':<35} {'ACTIVE VALUE':<30} DESCRIPTION")
    print("-" * 110)
    for key, (label, default, desc) in SETTINGS_SCHEMA.items():
        value = settings.get(key, default)
        source = "(user)" if key in settings else "(default)"
        print(f"{key:<35} {str(value):<20} {source:<10} {desc}")


def cmd_get(key: str) -> None:
    key = key.upper()
    if key not in SETTINGS_SCHEMA:
        print(f"Unknown setting: {key}")
        sys.exit(1)
    settings = _load()
    _, default, _ = SETTINGS_SCHEMA[key]
    value = settings.get(key, default)
    print(value)


def cmd_set(key: str, raw_value: str) -> None:
    key = key.upper()
    if key not in SETTINGS_SCHEMA:
        print(f"Unknown setting: {key}")
        print(f"Known settings: {', '.join(SETTINGS_SCHEMA)}")
        sys.exit(1)
    value = _coerce(key, raw_value)
    settings = _load()
    settings[key] = value
    _save(settings)
    _, _, desc = SETTINGS_SCHEMA[key]
    print(f"Set {key} = {value!r}  ({desc})")


def cmd_unset(key: str) -> None:
    key = key.upper()
    settings = _load()
    if key in settings:
        del settings[key]
        _save(settings)
        _, default, _ = SETTINGS_SCHEMA.get(key, ("", "?", ""))
        print(f"Removed {key}; will revert to default ({default})")
    else:
        print(f"{key} was not overridden (already using default)")


def main(argv: list[str]) -> None:
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__)
        return
    cmd = argv[0].lower()
    if cmd == "list":
        cmd_list()
    elif cmd == "get":
        if len(argv) < 2:
            print("Usage: blob_config.py get KEY")
            sys.exit(1)
        cmd_get(argv[1])
    elif cmd == "set":
        if len(argv) < 3:
            print("Usage: blob_config.py set KEY VALUE")
            sys.exit(1)
        cmd_set(argv[1], argv[2])
    elif cmd == "unset":
        if len(argv) < 2:
            print("Usage: blob_config.py unset KEY")
            sys.exit(1)
        cmd_unset(argv[1])
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1:])
