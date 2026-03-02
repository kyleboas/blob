FROM docker.io/cloudflare/sandbox:0.1.4

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  curl \
  git \
  python3 \
  python3-pip \
  nodejs \
  build-essential \
  && rm -rf /var/lib/apt/lists/*

# Install a non-interactive git credential helper used by Blob.
# Git calls this script for Username/Password prompts and it provides:
# - username: x-access-token
# - password: $GITHUB_TOKEN (or $GH_TOKEN)
RUN cat >/usr/local/bin/blob-git-askpass <<'EOF' \
 && chmod 755 /usr/local/bin/blob-git-askpass
#!/bin/sh
case "$1" in
  *Username*) echo "x-access-token" ;;
  *Password*) echo "${GITHUB_TOKEN}" ;;
  *) echo "" ;;
esac
EOF

RUN mkdir -p /workspace

# Install Codex CLI
RUN npm install -g @openai/codex

WORKDIR /workspace

# HTTP server with Codex support
COPY server.py /server.py
RUN chmod +x /server.py

# Script to restore auth from persistent storage on startup
COPY restore-auth.py /restore-auth.py
RUN chmod +x /restore-auth.py

EXPOSE 3000

ENV PORT=3000

# Restore auth then start server
CMD ["sh", "-c", "python3 /restore-auth.py && python3 /server.py"]