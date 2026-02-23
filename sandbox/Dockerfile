FROM docker.io/cloudflare/sandbox:0.1.0

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  curl \
  git \
  python3 \
  python3-pip \
  nodejs \
  npm \
  build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
