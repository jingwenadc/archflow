#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file=${1:-"$repo_dir/.env.production"}

set -a
. "$env_file"
set +a

webroot=${ACME_WEBROOT_DIR:-/data/letsencrypt/www}
config_dir=${LETSENCRYPT_CONFIG_DIR:-/data/letsencrypt/config}

docker run --rm \
    -v "$webroot:/var/www/certbot" \
    -v "$config_dir:/etc/letsencrypt" \
    certbot/certbot:v4.0.0 renew --webroot -w /var/www/certbot --quiet

docker compose --env-file "$env_file" -f "$repo_dir/compose.yaml" -f "$repo_dir/compose.https.yaml" exec -T nginx nginx -s reload
echo "Certificate renewal check completed and Nginx reloaded."
