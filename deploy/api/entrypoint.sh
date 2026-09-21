#!/bin/sh
set -eu

install -d -o archflow -g archflow /data /data/uploads /data/projects /data/cases
chown archflow:archflow /data

exec gosu archflow "$@"
