#!/bin/sh
set -eu

source_file=/run/secrets/archflow.htpasswd
target_file=/var/run/archflow.htpasswd

if [ ! -s "$source_file" ]; then
    echo "Basic Auth file is missing or empty: $source_file" >&2
    exit 1
fi

cp "$source_file" "$target_file"
chown nginx:nginx "$target_file"
chmod 0400 "$target_file"
