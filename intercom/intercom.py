#!/usr/bin/env python3
"""Native intercom entrypoint: exact session names, scoped to the caller's hc space."""
from pathlib import Path
import sys

# Keep imports bound to the checkout when invoked via ~/.local/bin/intercom.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime import run

if __name__ == "__main__":
    run()
