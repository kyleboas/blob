#!/bin/bash
# Example: GitHub Tool Built by Agent
# Uses github_tools.py instead of gh CLI (which is blocked by safety rules).
# See: github_tools.py for the full API reference.

set -e

# Parse arguments
COMMAND=""
OWNER=""
REPO=""
TITLE=""
BRANCH=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --command) COMMAND="$2"; shift 2 ;;
    --owner)   OWNER="$2";   shift 2 ;;
    --repo)    REPO="$2";    shift 2 ;;
    --title)   TITLE="$2";   shift 2 ;;
    --branch)  BRANCH="$2";  shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Resolve github_tools.py relative to this script's location (3 levels up from
# .blob/extensions/github/ → repo root)
GITHUB_TOOLS="$(cd "$(dirname "$0")/../../.." && pwd)/github_tools.py"

if [[ ! -f "$GITHUB_TOOLS" ]]; then
  echo "Error: github_tools.py not found at $GITHUB_TOOLS"
  exit 1
fi

# Execute command
case $COMMAND in
  pr_create)
    if [[ -z "$TITLE" || -z "$BRANCH" || -z "$OWNER" || -z "$REPO" ]]; then
      echo "Error: --title, --branch, --owner, and --repo are required"
      exit 1
    fi
    python "$GITHUB_TOOLS" create-pr \
      --owner "$OWNER" --repo "$REPO" \
      --title "$TITLE" --head "$BRANCH" \
      --body "Created by Blob"
    ;;

  pr_list)
    if [[ -z "$OWNER" || -z "$REPO" ]]; then
      echo "Error: --owner and --repo are required"
      exit 1
    fi
    python "$GITHUB_TOOLS" pr-list --owner "$OWNER" --repo "$REPO"
    ;;

  repo_clone)
    if [[ -z "$OWNER" || -z "$REPO" ]]; then
      echo "Error: --owner and --repo are required"
      exit 1
    fi
    # Use token-embedded URL so no interactive prompt is needed.
    REMOTE_URL="$(python "$GITHUB_TOOLS" remote-url --owner "$OWNER" --repo "$REPO")"
    git clone "$REMOTE_URL"
    ;;

  *)
    echo "Unknown command: $COMMAND"
    echo "Available: pr_create, pr_list, repo_clone"
    exit 1
    ;;
esac
