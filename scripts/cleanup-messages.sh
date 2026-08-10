#!/bin/bash
set -euo pipefail
mkdir -p /data/t3/messages/archive
find /data/t3/messages -maxdepth 1 -name "session-*.json" -mtime +1 -delete
find /data/t3/messages/archive -name "*.json.gz" -mtime +30 -delete
