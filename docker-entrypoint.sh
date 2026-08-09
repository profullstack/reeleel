#!/bin/sh
# Fix up the data volume, then drop privileges.
#
# Platform volumes (Railway, Fly, plain `docker run -v`) mount root-owned and
# empty. A container that started as an unprivileged user could not create
# anything inside them, so ReelEel would crash on its first write. Start as
# root, take ownership of the data directory, then hand off to `node`.
set -e

DATA_DIR="${REELEEL_HOME:-/data}"
PROJECTS_DIR="${REELEEL_PROJECTS_DIR:-$DATA_DIR/projects}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" "$PROJECTS_DIR"
  # Only touch ownership when it is wrong, so a large existing volume does not
  # pay a recursive chown on every boot.
  if [ "$(stat -c '%u' "$DATA_DIR")" != "$(id -u node)" ]; then
    chown -R node:node "$DATA_DIR"
  fi
  exec gosu node "$@"
fi

# Already unprivileged (someone passed --user): run as-is.
exec "$@"
