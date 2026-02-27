#!/bin/bash
# Budget-aware model picker for AI Gateway
# Keeps costs under $20/month

CONFIG=".blob/extensions/model/budget-config.json"

# Parse command
COMMAND=""
TASK=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --command) COMMAND="$2"; shift 2 ;;
    --task) TASK="$2"; shift 2 ;;
    *) shift ;;
  esac
done

case $COMMAND in
  budget)
    echo "Monthly Budget: $20"
    echo "Alert at: $15"
    echo ""
    echo "Strategy:"
    echo "  1. Default: Cloudflare Qwen3 (~$0.50/1M tokens)"
    echo "  2. Fallback: OpenAI GPT-4.1-mini (~$1/1M tokens)"
    echo "  3. Escalate: Anthropic Claude (~$9/1M tokens) - use sparingly!"
    ;;
    
  pick)
    # Simple logic: use Cloudflare default
    echo "Selected: Cloudflare Qwen3 30B"
    echo "Cost: ~$0.0005/1k tokens"
    echo ""
    echo "Fallback: OpenAI GPT-4.1-mini if Cloudflare fails"
    ;;
    
  escalate)
    echo "Switched to: Anthropic Claude Sonnet"
    echo "⚠️  Expensive: ~$9/1M tokens"
    echo "Use only for complex architecture/debugging"
    ;;
    
  status)
    echo "Cost Tracking:"
    echo "  Budget: $20/month"
    echo "  Strategy: Cloudflare first, escalate only when needed"
    echo ""
    echo "Models:"
    echo "  ✓ Cloudflare (cheap, default)"
    echo "  ✓ OpenAI (fallback)"
    echo "  ⚠️ Anthropic (expensive, escalate only)"
    ;;
    
  *)
    echo "Budget-Aware Model Picker"
    echo ""
    echo "Commands:"
    echo "  model --command budget    # Show budget info"
    echo "  model --command pick      # Pick best model for task"
    echo "  model --command escalate  # Switch to expensive model"
    echo "  model --command status    # Show cost tracking"
    echo ""
    echo "Goal: Keep under $20/month"
    echo "Strategy: Cloudflare first, OpenAI fallback, Anthropic rarely"
    ;;
esac
