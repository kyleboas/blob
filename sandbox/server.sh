#!/bin/sh

# Simple HTTP server for sandbox container
echo "Sandbox container ready on port 8080"

while true; do
  { 
    echo -e "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"status\":\"ok\"}" | nc -l -p 8080
  } &
done