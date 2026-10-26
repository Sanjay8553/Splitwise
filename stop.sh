#!/bin/sh
set -eu

cd "$(dirname "$0")"
port="${PORT:-8000}"

case "$port" in
  ''|*[!0-9]*)
    printf 'PORT must be a number between 1 and 65535.\n' >&2
    exit 2
    ;;
esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
  printf 'PORT must be a number between 1 and 65535.\n' >&2
  exit 2
fi

pid_file="$(pwd -P)/.wayfarer-server-$port.pid"
if [ ! -f "$pid_file" ]; then
  printf 'No managed Wayfarer server found on port %s.\n' "$port"
  printf 'A foreground server must be stopped with Ctrl+C in its Terminal.\n'
  exit 0
fi

pid=$(cat "$pid_file")
case "$pid" in
  ''|*[!0-9]*)
    printf 'PID file %s is invalid; inspect it before removing it.\n' "$pid_file" >&2
    exit 1
    ;;
esac

if ! kill -0 "$pid" 2>/dev/null; then
  rm "$pid_file"
  printf 'Removed stale PID file; no server was running on port %s.\n' "$port"
  exit 0
fi

command_line=$(ps -p "$pid" -o command= 2>/dev/null || true)
case "$command_line" in
  *"-m http.server $port --bind 127.0.0.1"*) ;;
  *)
    printf 'PID %s does not appear to be this project’s server; leaving it untouched.\n' "$pid" >&2
    exit 1
    ;;
esac

kill "$pid"
attempt=0
while kill -0 "$pid" 2>/dev/null && [ "$attempt" -lt 5 ]; do
  sleep 1
  attempt=$((attempt + 1))
done
if kill -0 "$pid" 2>/dev/null; then
  printf 'Server process %s did not stop. Stop it from its Terminal with Ctrl+C.\n' "$pid" >&2
  exit 1
fi

rm "$pid_file"
printf 'Stopped Wayfarer on port %s.\n' "$port"
