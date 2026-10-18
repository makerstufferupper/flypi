#!/bin/sh
# macOS + Linux wrapper (docs/architecture.md Phase 7). It exists only to check for Node: every real
# step is in scripts/start.mjs, so the three OSes behave identically.
command -v node >/dev/null 2>&1 || {
	echo "flypi: Node 22.19+ is required and was not found on PATH — get it from https://nodejs.org" >&2
	exit 1
}
exec node "$(dirname "$0")/scripts/start.mjs" "$@"
