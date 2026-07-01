#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root
mkdir -p dist
scripts=(atomic-write edit-literal read-special install-safe hostkey devpath)
fail=0
for s in "${scripts[@]}"; do
  node_modules/.bin/esbuild "scripts/verify/$s.ts" --bundle --platform=node --format=esm --packages=external --outfile=dist/_verify.mjs >/dev/null
  if node dist/_verify.mjs; then :; else echo "FAILED: $s"; fail=1; fi
done
rm -f dist/_verify.mjs
exit $fail
