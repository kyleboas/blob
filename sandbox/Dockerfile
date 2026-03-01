FROM docker.io/cloudflare/sandbox:0.1.4

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  curl \
  git \
  python3 \
  nodejs \
  build-essential \
  && rm -rf /var/lib/apt/lists/*

# Non-interactive git credential helper - provides GitHub token for auth
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
