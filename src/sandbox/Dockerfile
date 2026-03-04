FROM docker.io/cloudflare/sandbox:0.7.8

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  curl \
  git \
  python3 \
  python3-pip \
  build-essential \
  iproute2 \
  && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

RUN cat >/usr/local/bin/blob-git-askpass <<'EOF' \
 && chmod 755 /usr/local/bin/blob-git-askpass
#!/bin/sh
case "$1" in
  *Username*) echo "x-access-token" ;;
  *Password*) echo "${GITHUB_TOKEN}" ;;
  *) echo "" ;;
esac
EOF

RUN mkdir -p /workspace /workspace/.codex-auth /app
WORKDIR /workspace

RUN npm install -g @openai/codex

COPY restore-auth.py /restore-auth.py
RUN chmod +x /restore-auth.py

COPY index.ts ./index.ts

CMD ["bash", "-lc", "sleep infinity"]