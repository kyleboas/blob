FROM alpine:latest

RUN apk add --no-cache bash git nodejs npm python3 py3-pip

WORKDIR /workspace

# HTTP server to execute commands
COPY server.py /server.py
RUN chmod +x /server.py

EXPOSE 8080

CMD ["python3", "/server.py"]