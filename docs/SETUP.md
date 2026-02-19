# Setup Guide (Start to Finish)

This guide walks you through everything you need to run this project, even if you are new to Python or development.

## What this project is

This repository is a minimal AI agent project. It can run as:

- a local command-line tool, and
- a Slack bot (when you provide Slack credentials).

---

## 1) Install the basic tools

You need these installed on your computer:

1. **Python 3.11 or newer**
2. **Git**
3. (Optional) **Docker** if you want to run it in a container
4. (Optional) **Fly CLI (`flyctl`)** if you plan to deploy to Fly.io

### Check versions

Open a terminal and run:

```bash
python3 --version
git --version
```

If Python says lower than 3.11, install a newer version first.

---

## 2) Download the project

If you do not have the code yet:

```bash
git clone <YOUR_REPO_URL>
cd blob
```

If you already have it, just open a terminal in the project folder.

---

## 3) Create a virtual environment (recommended)

A virtual environment keeps project packages isolated from your system Python.

```bash
python3 -m venv .venv
source .venv/bin/activate
```

After activation, your terminal usually shows `(.venv)`.

---

## 4) Install project dependencies

Install this project in editable mode:

```bash
pip install --upgrade pip
pip install -e .
```

This installs all required packages listed by the project.

---

## 5) Configure environment variables

Copy the example environment file:

```bash
cp .env.example .env
```

Open `.env` and fill in your values:

- `ANTHROPIC_API_KEY` (required for model calls)
- `SLACK_BOT_TOKEN` (required only for Slack bot mode)
- `SLACK_APP_TOKEN` (required only for Slack bot mode)
- `FLY_API_TOKEN` (required only for Fly deployment)
- `AGENT_ENV` can usually stay `dev`

Tip: keep `.env` private and never commit secrets to git.

---

## 6) Run tests (quick health check)

Before running the app, verify the setup:

```bash
pytest
```

If tests pass, your local environment is set up correctly.

---

## 7) Run the project locally

### Option A: Run from command line

The project exposes a CLI command called `agent`.

Example:

```bash
agent "list files in the current directory"
```

If your shell cannot find `agent`, run it with Python instead:

```bash
python agent.py "list files in the current directory"
```

### Option B: Run the Slack bot

If Slack tokens are set in `.env`, start the bot:

```bash
python slack_bot.py
```

The bot starts a health endpoint at:

- `http://localhost:8080/healthz`

---

## 8) (Optional) Run with Docker

Build and run:

```bash
docker build -t self-modifying-agent .
docker run --rm --env-file .env -p 8080:8080 self-modifying-agent
```

Then check health:

- `http://localhost:8080/healthz`

---

## 9) (Optional) Deploy to Fly.io + Slack

For full deployment steps, see `DEPLOY.md`.

High-level flow:

1. Create/configure Slack app with Socket Mode.
2. Run `flyctl launch --no-deploy`.
3. Create a Fly volume.
4. Set secrets (`ANTHROPIC_API_KEY`, Slack tokens, Fly token).
5. Deploy with `flyctl deploy`.
6. Verify with `flyctl status` and `flyctl logs`.

---

## 10) Common troubleshooting

### `ModuleNotFoundError` or missing packages

- Make sure virtual environment is active.
- Re-run: `pip install -e .`

### Slack bot does not connect

- Double-check `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`.
- Confirm Socket Mode is enabled in Slack app settings.

### Model/API errors

- Confirm `ANTHROPIC_API_KEY` is set and valid.

### Tests fail unexpectedly

- Ensure you are using Python 3.11+.
- Reinstall dependencies in a clean virtual environment.

---

## 11) Day-to-day workflow (simple)

1. `cd blob`
2. `source .venv/bin/activate`
3. Pull latest changes: `git pull`
4. Install/update deps if needed: `pip install -e .`
5. Run tests: `pytest`
6. Run app (`agent ...` or `python slack_bot.py`)

That’s it—you’re ready to work with the project.
