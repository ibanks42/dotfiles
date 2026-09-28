#!/usr/bin/env bash
# Flatten root-union tool schemas in pi-claude-bridge. See README.md.
# Usage: apply.sh [status|apply|revert]
set -euo pipefail

here="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
root="${PI_CLAUDE_BRIDGE_ROOT:-$here/../../npm/node_modules/pi-claude-bridge}"
patch_args=(--quiet --fuzz=0 --no-backup-if-mismatch --reject-file=- -p1 -d "$root" -i "$here/mcp-server.patch")

is_applied() {
	grep -q 'flattenRootUnion' "$root/src/mcp-server.ts" && cmp -s "$here/schema-flatten.ts" "$root/src/schema-flatten.ts"
}

upstream_fixed() {
	PI_CLAUDE_BRIDGE_ROOT="$root" node --test "$here/regression.test.mjs" >/dev/null 2>&1
}

cmd="${1:-status}"
version="$(node -p "require('$root/package.json').version")"

case "$cmd" in
status)
	if is_applied; then
		echo "pi-claude-bridge $version: patched"
	elif upstream_fixed; then
		echo "pi-claude-bridge $version: not patched, but the regression test passes. Upstream may have fixed it; retire this patch."
	elif patch --forward --dry-run "${patch_args[@]}" >/dev/null 2>&1; then
		echo "pi-claude-bridge $version: not patched (run: $0 apply)"
		exit 2
	else
		echo "pi-claude-bridge $version: not patched and mcp-server.patch no longer applies. Refresh it against the new upstream." >&2
		exit 1
	fi
	;;
apply)
	if is_applied; then
		echo "pi-claude-bridge $version: already patched"
		exit 0
	fi
	if upstream_fixed; then
		echo "pi-claude-bridge $version: regression test passes without the patch. Skipping; retire this patch."
		exit 0
	fi
	if ! patch --forward --dry-run "${patch_args[@]}" >/dev/null; then
		echo "pi-claude-bridge $version: mcp-server.patch no longer applies. Refresh it against the new upstream." >&2
		exit 1
	fi
	cp "$here/schema-flatten.ts" "$root/src/schema-flatten.ts"
	patch --forward "${patch_args[@]}"
	PI_CLAUDE_BRIDGE_ROOT="$root" node --test "$here/regression.test.mjs" >/dev/null
	echo "pi-claude-bridge $version: patched. Restart Pi to load it."
	;;
revert)
	if ! grep -q 'flattenRootUnion' "$root/src/mcp-server.ts"; then
		echo "pi-claude-bridge $version: not patched"
		exit 0
	fi
	patch --reverse "${patch_args[@]}"
	rm -f "$root/src/schema-flatten.ts"
	echo "pi-claude-bridge $version: reverted. Restart Pi to load it."
	;;
*)
	echo "usage: $0 [status|apply|revert]" >&2
	exit 64
	;;
esac
