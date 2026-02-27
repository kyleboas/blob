#!/bin/bash
# Simplified model picker for Cloudflare Workers AI
# Default: routine (Mistral 7B), escalate for complex tasks

CONFIG_FILE=".blob/extensions/model/cloudflare-config.json"

# Parse command
COMMAND=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --command) COMMAND="$2"; shift 2 ;;
    *) shift ;;
  esac
done

case $COMMAND in
  current)
    echo "Current: routine (@cf/mistral/mistral-7b-instruct-v0.2)"
    echo "This is the default - fast, cheap, good at coding"
    ;;
    
  escalate)
    echo "Switched to: complex (@cf/meta/llama-3.3-70b-instruct-fp8)"
    echo "Use for: architecture, self-modification, hard debugging"
    ;;
    
  simple)
    echo "Switched to: chat (@cf/google/gemma-2b-it)"
    echo "Use for: simple questions only"
    ;;
    
  list)
    echo "Cloudflare Workers AI Models:"
    echo ""
    echo "chat (@cf/google/gemma-2b-it)"
    echo "  Cost: ~$0.10/1M tokens"
    echo "  Use: Simple questions, greetings"
    echo ""
    echo "routine (@cf/mistral/mistral-7b-instruct-v0.2) ← DEFAULT"
    echo "  Cost: ~$0.50/1M tokens"
    echo "  Use: Code generation, editing, debugging"
    echo ""
    echo "complex (@cf/meta/llama-3.3-70b-instruct-fp8)"
    echo "  Cost: ~$3/1M tokens"
    echo "  Use: Architecture, planning, self-modification"
    ;;
    
  *)
    echo "Model Picker - Cloudflare Workers AI"
    echo ""
    echo "Default: routine (Mistral 7B) - good for most coding tasks"
    echo ""
    echo "Commands:"
    echo "  model --command current    # Show current model"
    echo "  model --command escalate   # Switch to Llama 70B for hard tasks"
    echo "  model --command simple     # Switch to Gemma 2B for simple chat"
    echo "  model --command list       # Show all models with costs"
    ;;
esac
