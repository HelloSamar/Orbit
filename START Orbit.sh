#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
[ -d node_modules ] || npm install --omit=dev
npm start

