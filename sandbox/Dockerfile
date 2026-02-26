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
  *Password*) echo "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ;;
  *) echo "" ;;
esac
EOF

RUN mkdir -p /workspace
