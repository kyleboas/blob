FROM node:20-alpine

RUN apk add --no-cache bash git python3 py3-pip

# Install Codex CLI
RUN npm install -g @openai/codex

WORKDIR /workspace

# HTTP server with Codex support
COPY server.py /server.py
RUN chmod +x /server.py

# Script to restore auth from persistent storage on startup
COPY restore-auth.py /restore-auth.py
RUN chmod +x /restore-auth.py

EXPOSE 8080

# Restore auth then start server
CMD ["sh", "-c", "python3 /restore-auth.py && python3 /server.py"]