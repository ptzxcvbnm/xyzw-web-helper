#!/usr/bin/env bash
set -Eeuo pipefail

stage=/tmp/xyzw-frontend-update
frontend=/var/www/xyzw-web-helper
stamp=$(date +%Y%m%d-%H%M%S)
backup=/var/www/xyzw-backups/$stamp
failed=/tmp/xyzw-frontend-failed-$stamp
swapped=0

rollback() {
  trap - ERR
  set +e
  if [[ $swapped -eq 1 ]]; then
    mv "$frontend" "$failed"
    mv "$backup/site" "$frontend"
  fi
  echo "Frontend deployment failed; rollback completed." >&2
}

trap rollback ERR

test -f "$stage/dist/index.html"
install -d -m 0700 "$backup"
mv "$frontend" "$backup/site"
mv "$stage/dist" "$frontend"
swapped=1

curl -kfsS https://127.0.0.1/ >/dev/null

trap - ERR
rm -rf -- "$stage"
echo "frontend_backup=$backup"
