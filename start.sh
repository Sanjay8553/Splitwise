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

if [ "$#" -gt 0 ]; then
  printf 'Usage: ./start.sh\n' >&2
  exit 2
fi

project_dir=$(pwd -P)
pid_file="$project_dir/.wayfarer-server-$port.pid"
log_file="$project_dir/.wayfarer-server-$port.log"

if [ -f "$pid_file" ]; then
  pid=$(cat "$pid_file")
  if kill -0 "$pid" 2>/dev/null; then
    command_line=$(ps -p "$pid" -o command= 2>/dev/null || true)
    case "$command_line" in
      *"-m http.server $port --bind 127.0.0.1"*)
        printf 'Wayfarer is already running at http://localhost:%s (PID %s).\n' "$port" "$pid"
        exit 0
        ;;
      *)
        printf 'PID file %s exists, but its process is not this Wayfarer server. Remove it only after checking that process.\n' "$pid_file" >&2
        exit 1
        ;;
    esac
  fi
  rm "$pid_file"
fi

nohup python3 -m http.server "$port" --bind 127.0.0.1 >"$log_file" 2>&1 &
pid=$!
printf '%s\n' "$pid" > "$pid_file"
sleep 1
if ! kill -0 "$pid" 2>/dev/null; then
  rm "$pid_file"
  printf 'Could not start the server. See %s for details.\n' "$log_file" >&2
  exit 1
fi
printf 'Wayfarer is running at http://localhost:%s (PID %s).\n' "$port" "$pid"
printf 'Stop it with: just local-stop\n'
