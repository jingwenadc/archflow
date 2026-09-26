#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output=${HTPASSWD_FILE:-"$repo_dir/deploy/nginx/.htpasswd"}
username=${BASIC_AUTH_USERNAME:-archflow}
temporary=
tty_hidden=0

cleanup() {
    if [ "$tty_hidden" -eq 1 ]; then stty echo 2>/dev/null || true; fi
    if [ -n "$temporary" ]; then rm -f "$temporary"; fi
}
trap cleanup EXIT HUP INT TERM

if [ -z "${BASIC_AUTH_PASSWORD:-}" ]; then
    printf "Shared username [%s]: " "$username"
    read -r entered_username
    if [ -n "$entered_username" ]; then username=$entered_username; fi
    printf "Shared password: "
    stty -echo
    tty_hidden=1
    read -r password
    stty echo
    tty_hidden=0
    printf "\nConfirm password: "
    stty -echo
    tty_hidden=1
    read -r confirmation
    stty echo
    tty_hidden=0
    printf "\n"
else
    password=$BASIC_AUTH_PASSWORD
    confirmation=$BASIC_AUTH_PASSWORD
fi

if [ -z "$username" ] || [ -z "$password" ]; then
    echo "Username and password must not be empty." >&2
    exit 1
fi
if [ "${#password}" -lt 16 ]; then
    echo "Shared password must contain at least 16 characters." >&2
    exit 1
fi
if [ "$password" != "$confirmation" ]; then
    echo "Passwords do not match." >&2
    exit 1
fi

umask 077
mkdir -p "$(dirname -- "$output")"
temporary="$output.tmp"

if command -v htpasswd >/dev/null 2>&1; then
    printf '%s\n' "$password" | htpasswd -Bni "$username" > "$temporary"
elif command -v docker >/dev/null 2>&1; then
    printf '%s\n' "$password" | docker run --rm -i --entrypoint htpasswd httpd:2.4-alpine -Bni "$username" > "$temporary"
else
    echo "Install apache2-utils/httpd or Docker to generate the password file." >&2
    exit 1
fi

mv "$temporary" "$output"
temporary=
chmod 0600 "$output"
unset password confirmation BASIC_AUTH_PASSWORD
echo "Basic Auth file written to $output"
