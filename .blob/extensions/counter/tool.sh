#!/bin/bash
# Counter extension - demonstrates session state persistence
# Usage: counter --action {get|increment|reset|set} [--value N]

ACTION="$1"
SESSION_ID="${SESSION_ID:-default}"

# In a real implementation, this would call the session API
# For now, we simulate with a file-based store
STATE_FILE=".blob/.extension-state/${SESSION_ID}-counter.json"

# Ensure state directory exists
mkdir -p "$(dirname "$STATE_FILE")"

# Read current state
if [ -f "$STATE_FILE" ]; then
  COUNT=$(cat "$STATE_FILE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('count',0))" 2>/dev/null || echo 0)
else
  COUNT=0
fi

case "$ACTION" in
  get)
    echo "Current count: $COUNT"
    ;;
  increment)
    COUNT=$((COUNT + 1))
    echo '{"count": '$COUNT'}' > "$STATE_FILE"
    echo "Incremented! New count: $COUNT"
    ;;
  reset)
    echo '{"count": 0}' > "$STATE_FILE"
    echo "Reset! Count is now 0"
    ;;
  set)
    VALUE="${2:-0}"
    echo '{"count": '$VALUE'}' > "$STATE_FILE"
    echo "Set! Count is now $VALUE"
    ;;
  *)
    echo "Usage: counter {get|increment|reset|set [value]}"
    exit 1
    ;;
esac
