#!/bin/bash
# Model picker tool for Pi-style Blob
# Agent uses this to select the appropriate model for a task

CONFIG_FILE=".blob/extensions/model/cloudflare-config.json"

# Ensure config exists
mkdir -p .blob
if [[ ! -f "$CONFIG_FILE" ]]; then
cat > "$CONFIG_FILE" << 'EOF'
{
  "current": "auto",
  "models": {
    "chat": {
      "id": "@cf/zai-org/glm-4.7-flash",
      "description": "Fast, cheap model for conversations and simple queries",
      "cost_per_1k": 0.001,
      "strengths": ["chat", "simple tasks", "quick responses"],
      "context": "128k tokens"
    },
    "routine": {
      "id": "@cf/qwen/qwen3-30b-a3b-fp8", 
      "description": "Balanced model for routine coding tasks",
      "cost_per_1k": 0.003,
      "strengths": ["code generation", "file editing", "bash commands"],
      "context": "128k tokens"
    },
    "complex": {
      "id": "claude-sonnet-4-6",
      "description": "Powerful model for complex reasoning and architecture",
      "cost_per_1k": 0.015,
      "strengths": ["complex planning", "architecture", "debugging", "self-modification"],
      "context": "200k tokens"
    }
  },
  "auto_rules": [
    {"pattern": "^(hi|hello|hey|what|how|why|explain)", "model": "chat"},
    {"pattern": "(create|write|edit|fix|add|remove).*file", "model": "routine"},
    {"pattern": "(architecture|design|plan|refactor|complex)", "model": "complex"},
    {"pattern": "(self.?modify|improve|extension|build tool)", "model": "complex"}
  ]
}
EOF
fi

# Parse command
COMMAND=""
TASK=""
MODEL=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --command) COMMAND="$2"; shift 2 ;;
    --task) TASK="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    *) shift ;;
  esac
done

case $COMMAND in
  list)
    echo "Available models:"
    jq -r '.models | to_entries[] | "  \(.key): \(.value.id)\n    \(.value.description)\n    Cost: $\(.value.cost_per_1k)/1k tokens\n    Strengths: \(.value.strengths | join(\", \"))\n"' "$CONFIG_FILE"
    echo "Current: $(jq -r '.current' "$CONFIG_FILE")"
    ;;
    
  pick)
    if [[ -z "$TASK" ]]; then
      echo "Error: --task required for pick"
      exit 1
    fi
    
    if [[ "$(jq -r '.current' "$CONFIG_FILE")" != "auto" ]]; then
      # Manual mode - return current model
      CURRENT=$(jq -r '.current' "$CONFIG_FILE")
      MODEL_ID=$(jq -r ".models.\$CURRENT.id" "$CONFIG_FILE")
      echo "Using manual model: $CURRENT ($MODEL_ID)"
      exit 0
    fi
    
    # Auto mode - match task to model
    TASK_LOWER=$(echo "$TASK" | tr '[:upper:]' '[:lower:]')
    
    # Check auto rules
    MATCH=$(jq -r --arg task "$TASK_LOWER" '
      .auto_rules[] | 
      select($task | test(.pattern; "i")) | 
      .model
    ' "$CONFIG_FILE" | head -1)
    
    if [[ -n "$MATCH" && "$MATCH" != "null" ]]; then
      MODEL_ID=$(jq -r ".models.\$MATCH.id" "$CONFIG_FILE")
      echo "Auto-selected: $MATCH ($MODEL_ID)"
      echo "Reason: Task matches pattern for $MATCH model"
    else
      # Default to routine
      MODEL_ID=$(jq -r '.models.routine.id' "$CONFIG_FILE")
      echo "Auto-selected: routine ($MODEL_ID)"
      echo "Reason: Default for unmatched tasks"
    fi
    ;;
    
  switch)
    if [[ -z "$MODEL" ]]; then
      echo "Error: --model required for switch"
      exit 1
    fi
    
    # Validate model exists
    if ! jq -e ".models.\$MODEL" "$CONFIG_FILE" > /dev/null 2>&1; then
      echo "Error: Unknown model '$MODEL'. Available:"
      jq -r '.models | keys[]' "$CONFIG_FILE"
      exit 1
    fi
    
    # Update config
    jq --arg model "$MODEL" '.current = $model' "$CONFIG_FILE" > "$CONFIG_FILE.tmp"
    mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
    
    MODEL_ID=$(jq -r ".models.\$MODEL.id" "$CONFIG_FILE")
    echo "Switched to: $MODEL ($MODEL_ID)"
    ;;
    
  auto)
    # Switch back to auto mode
    jq '.current = "auto"' "$CONFIG_FILE" > "$CONFIG_FILE.tmp"
    mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
    echo "Switched to auto mode (agent picks model based on task)"
    ;;
    
  info)
    CURRENT=$(jq -r '.current' "$CONFIG_FILE")
    if [[ "$CURRENT" == "auto" ]]; then
      echo "Mode: Auto (agent picks model)"
    else
      MODEL_ID=$(jq -r ".models.\$CURRENT.id" "$CONFIG_FILE")
      echo "Mode: Manual"
      echo "Current: $CURRENT ($MODEL_ID)"
    fi
    echo ""
    echo "Available models:"
    jq -r '.models | keys[]' "$CONFIG_FILE"
    ;;
    
  *)
    echo "Usage:"
    echo "  model --command list              # List all models"
    echo "  model --command pick --task '...' # Pick best model for task"
    echo "  model --command switch --model X  # Switch to specific model"
    echo "  model --command auto              # Enable auto-selection"
    echo "  model --command info              # Show current settings"
    exit 1
    ;;
esac
