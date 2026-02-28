FROM alpine:latest

RUN apk add --no-cache bash git nodejs npm python3 py3-pip

WORKDIR /workspace

# Simple HTTP server to receive commands
COPY server.sh /server.sh
RUN chmod +x /server.sh

EXPOSE 8080

CMD ["/server.sh"]