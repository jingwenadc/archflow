#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file=${1:-"$repo_dir/.env.production"}

if [ ! -f "$env_file" ]; then
    echo "Environment file not found: $env_file" >&2
    exit 1
fi

set -a
. "$env_file"
set +a

: "${ARCHFLOW_DOMAIN:?Set ARCHFLOW_DOMAIN in the environment file}"
: "${LETSENCRYPT_EMAIL:?Set LETSENCRYPT_EMAIL in the environment file}"
webroot=${ACME_WEBROOT_DIR:-/data/letsencrypt/www}
config_dir=${LETSENCRYPT_CONFIG_DIR:-/data/letsencrypt/config}
staging_flag=
certificate_dir=$config_dir
if [ "${LETSENCRYPT_STAGING:-1}" = "1" ]; then
    staging_flag=--staging
    certificate_dir="$config_dir/staging"
fi

mkdir -p "$webroot" "$certificate_dir"
docker run --rm \
    -v "$webroot:/var/www/certbot" \
    -v "$certificate_dir:/etc/letsencrypt" \
    certbot/certbot:v4.0.0 certonly --webroot -w /var/www/certbot \
    --non-interactive --agree-tos --no-eff-email \
    --email "$LETSENCRYPT_EMAIL" -d "$ARCHFLOW_DOMAIN" $staging_flag

echo "Certificate created in $certificate_dir. Set LETSENCRYPT_STAGING=0 for the real certificate, then start with compose.https.yaml."
