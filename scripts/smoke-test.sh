#!/bin/sh
set -eu

base_url=${ARCHFLOW_BASE_URL:-http://127.0.0.1:8080}
username=${BASIC_AUTH_USERNAME:-archflow}

if [ -z "${BASIC_AUTH_PASSWORD:-}" ]; then
    printf "Shared password for %s: " "$username"
    stty -echo
    read -r password
    stty echo
    printf "\n"
else
    password=$BASIC_AUTH_PASSWORD
fi

umask 077
curl_config=$(mktemp)
trap 'rm -f "$curl_config"' EXIT HUP INT TERM
printf 'user = "%s:%s"\n' "$username" "$password" > "$curl_config"

health=$(curl -fsS "$base_url/healthz")
if [ "$health" != "ok" ]; then
    echo "Nginx health check failed." >&2
    exit 1
fi

unauthorized=$(curl -sS -o /dev/null -w '%{http_code}' "$base_url/")
if [ "$unauthorized" != "401" ]; then
    echo "Expected an unauthenticated 401, got $unauthorized." >&2
    exit 1
fi

curl -fsS --config "$curl_config" "$base_url/" >/dev/null
curl -fsS --config "$curl_config" "$base_url/api/v1/capabilities" >/dev/null
unset password BASIC_AUTH_PASSWORD
echo "Smoke test passed: health is public; all application routes require valid Basic Auth."
