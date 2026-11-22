#!/usr/bin/env bash
# Unix shim; install.py does the work on every OS.
exec python3 "$(dirname -- "${BASH_SOURCE[0]}")/install.py" "$@"
