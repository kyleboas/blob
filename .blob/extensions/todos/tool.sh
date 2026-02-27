#!/bin/bash
# /todos - Local agent-managed todo list
# Inspired by Armin Ronacher's Pi workflow

TODO_FILE=".blob/todos.json"
COMMAND="$1"
shift

# Ensure todo file exists
if [ ! -f "$TODO_FILE" ]; then
  echo "[]" > "$TODO_FILE"
fi

add_todo() {
  local text="$1"
  local tag="${2:-task}"
  local id=$(date +%s)
  
  # Read current todos
  local current=$(cat "$TODO_FILE")
  
  # Add new todo
  local new_todo="{\"id\":\"$id\",\"text\":\"$text\",\"tag\":\"$tag\",\"status\":\"open\",\"created\":$id}"
  
  if [ "$current" = "[]" ]; then
    echo "[$new_todo]" > "$TODO_FILE"
  else
    # Insert before closing bracket
    echo "${current%]},$new_todo]" > "$TODO_FILE"
  fi
  
  echo "✓ Added todo #$id: $text"
}

list_todos() {
  local filter="$1"
  
  echo "┌─ Todos ────────────────────────────────────────────────┐"
  echo "│"
  
  # Parse and display todos
  cat "$TODO_FILE" | python3 -c "
import json, sys
todos = json.load(sys.stdin)
for t in todos:
    if '$filter' and t.get('tag') != '$filter':
        continue
    status = '✓' if t['status'] == 'done' else '○'
    tag = t.get('tag', 'task')
    print(f\"│ {status} #{t['id'][:6]} [{tag}] {t['text'][:40]}\")
" 2>/dev/null || echo "│ (No todos yet)"
  
  echo "│"
  echo "└─ Use: todos add 'text' [--tag bug|feature|task] ────────┘"
}

mark_done() {
  local id="$1"
  
  cat "$TODO_FILE" | python3 -c "
import json, sys
todos = json.load(sys.stdin)
found = False
for t in todos:
    if t['id'].startswith('$id'):
        t['status'] = 'done'
        found = True
        print(f\"✓ Marked #{t['id'][:6]} as done: {t['text'][:30]}...\")
json.dump(todos, sys.stdout)
" > "$TODO_FILE.tmp" && mv "$TODO_FILE.tmp" "$TODO_FILE"
}

remove_todo() {
  local id="$1"
  
  cat "$TODO_FILE" | python3 -c "
import json, sys
todos = json.load(sys.stdin)
removed = [t for t in todos if not t['id'].startswith('$id')]
json.dump(removed, sys.stdout)
" > "$TODO_FILE.tmp" && mv "$TODO_FILE.tmp" "$TODO_FILE"
  
  echo "✓ Removed todo"
}

search_todos() {
  local query="$1"
  
  echo "┌─ Search Results ───────────────────────────────────────┐"
  echo "│"
  
  cat "$TODO_FILE" | python3 -c "
import json, sys
todos = json.load(sys.stdin)
found = False
for t in todos:
    if '$query'.lower() in t['text'].lower():
        status = '✓' if t['status'] == 'done' else '○'
        print(f\"│ {status} #{t['id'][:6]} {t['text'][:40]}\")
        found = True
if not found:
    print('│ (No matches)')
" 2>/dev/null
  
  echo "│"
  echo "└─────────────────────────────────────────────────────────┘"
}

# Parse arguments
TEXT=""
TAG=""
ID=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --text) TEXT="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --id) ID="$2"; shift 2 ;;
    *) shift ;;
  esac
done

case "$COMMAND" in
  add)
    if [ -z "$TEXT" ]; then
      echo "Usage: todos add --text 'task description' [--tag bug|feature|task]"
      exit 1
    fi
    add_todo "$TEXT" "$TAG"
    ;;
  list)
    list_todos "$TAG"
    ;;
  done)
    if [ -z "$ID" ]; then
      echo "Usage: todos done --id <todo-id>"
      exit 1
    fi
    mark_done "$ID"
    ;;
  remove)
    if [ -z "$ID" ]; then
      echo "Usage: todos remove --id <todo-id>"
      exit 1
    fi
    remove_todo "$ID"
    ;;
  search)
    if [ -z "$TEXT" ]; then
      echo "Usage: todos search --text 'query'"
      exit 1
    fi
    search_todos "$TEXT"
    ;;
  *)
    echo "Usage: todos {add|list|done|remove|search} [options]"
    echo ""
    echo "Commands:"
    echo "  add --text 'description' [--tag bug|feature|task]"
    echo "  list [--tag bug|feature|task]"
    echo "  done --id <id>"
    echo "  remove --id <id>"
    echo "  search --text 'query'"
    ;;
esac
