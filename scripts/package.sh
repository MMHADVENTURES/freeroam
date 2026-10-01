#!/usr/bin/env bash
# Builds dist/freeroam-<version>.zip containing only what the extension needs.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
mkdir -p dist
out="dist/freeroam-${version}.zip"
rm -f "$out"
zip -qr "$out" manifest.json background.js content.js pageScript.js sidebar.css icons fonts LICENSE PRIVACY.md -x '*.DS_Store'
echo "Built $out ($(du -h "$out" | cut -f1))"
