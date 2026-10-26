#!/usr/bin/env bash
set -euo pipefail
cd /srv/docker
docker compose config -q
docker compose up -d --build minyanmate-dev
echo "minyanmate-dev rebuilt and restarted"
