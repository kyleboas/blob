#!/bin/bash
# /answer - Extract questions from agent responses
# Inspired by Armin Ronacher's Pi extension

TEXT="$1"

if [ -z "$TEXT" ]; then
  echo "Usage: answer --text 'agent response here'"
  exit 1
fi

# Extract questions (lines ending with ? or containing question words)
echo "┌─ Questions ──────────────────────────────────────────────┐"
echo "│"

# Find questions in the text
echo "$TEXT" | grep -E "\?\s*$|^(What|How|Why|When|Where|Who|Which|Can|Could|Would|Will|Should|Do|Does|Did|Is|Are|Was|Were)" | while read -r line; do
  # Clean up the line
  clean_line=$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  if [ -n "$clean_line" ]; then
    echo "│ • $clean_line"
  fi
done

echo "│"
echo "└─ Type your answers below, one per line ───────────────────┘"
