#!/bin/sh
set -eu

cd "$(dirname "$0")"
port="${PORT:-8000}"

printf 'Wayfarer is running at http://localhost:%s\n' "$port"
printf 'Press Ctrl+C to stop the server.\n'
exec python3 -m http.server "$port" --bind 127.0.0.1
