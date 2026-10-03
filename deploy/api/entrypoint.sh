#!/bin/sh
set -eu

install -d -o archflow -g archflow /data /data/uploads /data/projects /data/cases
install -d -m 0700 -o archflow -g archflow /data/tmp
chown archflow:archflow /data

exec gosu archflow "$@"
