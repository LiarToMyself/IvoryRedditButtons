"""Compatibility stub importing and running check_source_hygiene.py."""
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from check_source_hygiene import main, scan_objects, PATTERNS, is_allowlisted

def scan_staged() -> int:
    return main(["--staged"])

if __name__ == "__main__":
    sys.exit(main())
