#!/usr/bin/env bash
# Test against the installed Pi without adding dependencies to the extension.
set -euo pipefail
here=$(cd -- "$(dirname -- "$0")" && pwd)
modules=${PI_NODE_MODULES:-${BUN_INSTALL:-$HOME/.bun}/install/global/node_modules}
if [[ ! -d "$modules/@earendil-works/pi-tui" ]]; then
  echo "Set PI_NODE_MODULES to the node_modules directory containing Pi and pi-tui." >&2
  exit 1
fi
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
cp "$here"/*.ts "$tmp/"
ln -s "$modules" "$tmp/node_modules"
bun test "$tmp/rail.test.ts"
cli="$modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
python3 "$here/cli-smoke.py" "$cli" "$here/index.ts"
python3 "$here/cli-smoke.py" "$cli" "$here/index.ts" --compacted --latest
python3 "$here/cli-smoke.py" "$cli" "$here/index.ts" --compacted --history
if [[ -f "$modules/typescript/bin/tsc" ]]; then
  node "$modules/typescript/bin/tsc" --noEmit --strict --target es2022 --module preserve --moduleResolution bundler --typeRoots "$modules/@types" --types node --skipLibCheck "$tmp/index.ts" "$tmp/model.ts" "$tmp/navigation.ts"
fi
