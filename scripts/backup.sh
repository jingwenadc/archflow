#!/bin/sh
set -eu
export LC_ALL=C

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file=${1:-"$repo_dir/.env.production"}

if [ ! -f "$env_file" ]; then
    echo "Environment file not found: $env_file" >&2
    exit 1
fi

set -a
. "$env_file"
set +a

data_dir=${ARCHFLOW_DATA_DIR:-/data/archflow}
backup_dir=${ARCHFLOW_BACKUP_DIR:-/data/archflow-backups}
retention_days=${BACKUP_RETENTION_DAYS:-14}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$backup_dir/archflow-$timestamp.tar.gz"
staged_database="$data_dir/.backup-db.sqlite3"
paused=0

cleanup() {
    if [ "$paused" -eq 1 ]; then
        docker compose --env-file "$env_file" -f "$repo_dir/compose.yaml" unpause api >/dev/null 2>&1 || true
    fi
    rm -f "$staged_database" "$archive.tmp"
}
trap cleanup EXIT HUP INT TERM

umask 077
mkdir -p "$backup_dir"
docker compose --env-file "$env_file" -f "$repo_dir/compose.yaml" exec -T api \
    python -c "import sqlite3; source=sqlite3.connect('/data/archflow.sqlite3'); target=sqlite3.connect('/data/.backup-db.sqlite3'); source.backup(target); target.close(); source.close()"

docker compose --env-file "$env_file" -f "$repo_dir/compose.yaml" pause api >/dev/null
paused=1
tar -czf "$archive.tmp" -C "$data_dir" uploads projects cases .backup-db.sqlite3
mv "$archive.tmp" "$archive"
docker compose --env-file "$env_file" -f "$repo_dir/compose.yaml" unpause api >/dev/null
paused=0
rm -f "$staged_database"

archive_name=$(basename -- "$archive")
if command -v sha256sum >/dev/null 2>&1; then
    checksum=$(sha256sum "$archive" | awk '{print $1}')
else
    checksum=$(shasum -a 256 "$archive" | awk '{print $1}')
fi
printf '%s  %s\n' "$checksum" "$archive_name" > "$archive.sha256"

find "$backup_dir" -type f -name 'archflow-*.tar.gz' -mtime "+$retention_days" -delete
find "$backup_dir" -type f -name 'archflow-*.tar.gz.sha256' -mtime "+$retention_days" -delete
echo "Backup created: $archive"
