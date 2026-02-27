#!/bin/bash
# Memory Extension for Pi-Style Blob
# Simple key-value storage with search

MEMORY_FILE=".blob/memory.json"

# Ensure memory file exists
mkdir -p .blob
touch "$MEMORY_FILE"

# Parse command
COMMAND=""
KEY=""
VALUE=""
QUERY=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --command) COMMAND="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --value) VALUE="$2"; shift 2 ;;
    --query) QUERY="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Ensure valid JSON file
if [[ ! -s "$MEMORY_FILE" ]] || ! jq empty "$MEMORY_FILE" 2>/dev/null; then
  echo "[]" > "$MEMORY_FILE"
fi

case $COMMAND in
  save)
    if [[ -z "$KEY" || -z "$VALUE" ]]; then
      echo "Error: --key and --value required for save"
      exit 1
    fi
    
    # Add new entry with timestamp
    jq --arg key "$KEY" --arg value "$VALUE" --arg time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '. + [{key: $key, value: $value, created_at: $time}]' "$MEMORY_FILE" > "$MEMORY_FILE.tmp"
    mv "$MEMORY_FILE.tmp" "$MEMORY_FILE"
    
    # Keep only last 100 entries
    jq '.[-100:]' "$MEMORY_FILE" > "$MEMORY_FILE.tmp"
    mv "$MEMORY_FILE.tmp" "$MEMORY_FILE"
    
    echo "Saved: $KEY"
    ;;
    
  recall)
    if [[ -z "$KEY" ]]; then
      echo "Error: --key required for recall"
      exit 1
    fi
    
    # Find by exact key match (most recent)
    RESULT=$(jq -r --arg key "$KEY" 'map(select(.key == $key)) | last | .value' "$MEMORY_FILE")
    
    if [[ "$RESULT" == "null" || -z "$RESULT" ]]; then
      echo "No memory found for: $KEY"
      exit 1
    else
      echo "$RESULT"
    fi
    ;;
    
  search)
    if [[ -z "$QUERY" ]]; then
      echo "Error: --query required for search"
      exit 1
    fi
    
    # Simple substring search in keys
    RESULT=$(jq -r --arg query "$QUERY" \
      'map(select(.key | contains($query))) | .[-5:] | .[] | "\(.key): \(.value)"' "$MEMORY_FILE")
    
    if [[ -z "$RESULT" ]]; then
      echo "No matches for: $QUERY"
    else
      echo "$RESULT"
    fi
    ;;
    
  list)
    # List all keys (last 20)
    jq -r '.[-20:] | .[] | "\(.created_at) \(.key)"' "$MEMORY_FILE"
    ;;
    
  *)
    echo "Unknown command: $COMMAND"
    echo "Usage:"
    echo "  memory --command save --key 'task name' --value 'solution'"
    echo "  memory --command recall --key 'task name'"
    echo "  memory --command search --query 'partial key'"
    echo "  memory --command list"
    exit 1
    ;;
esac
