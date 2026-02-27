#!/bin/bash
# Example: GitHub CLI Tool Built by Agent
# This shows how Blob builds its own tools

set -e

# Parse arguments
COMMAND=""
REPO=""
TITLE=""
BRANCH=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --command) COMMAND="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --title) TITLE="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Ensure gh CLI is available
if ! command -v gh &> /dev/null; then
  echo "Error: gh CLI not found. Install with: bash -c 'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && apt update && apt install gh -y'"
  exit 1
fi

# Execute command
case $COMMAND in
  pr_create)
    if [[ -z "$TITLE" || -z "$BRANCH" ]]; then
      echo "Error: --title and --branch required"
      exit 1
    fi
    gh pr create --title "$TITLE" --head "$BRANCH" --body "Created by Blob"
    ;;
  
  pr_list)
    gh pr list --limit 10
    ;;
  
  pr_merge)
    if [[ -z "$BRANCH" ]]; then
      echo "Error: --branch required"
      exit 1
    fi
    gh pr merge "$BRANCH" --squash
    ;;
  
  repo_clone)
    if [[ -z "$REPO" ]]; then
      echo "Error: --repo required"
      exit 1
    fi
    gh repo clone "$REPO"
    ;;
  
  *)
    echo "Unknown command: $COMMAND"
    echo "Available: pr_create, pr_list, pr_merge, repo_clone"
    exit 1
    ;;
esac
