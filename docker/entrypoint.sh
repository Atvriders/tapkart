#!/bin/sh
# Generate <STATIC_ROOT>/.well-known/assetlinks.json before starting the server.
# `exec` keeps the server as PID 1 so container stop signals reach it directly.
set -e

node /app/tools/write-assetlinks.mjs

exec node /app/main.mjs
