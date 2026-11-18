"""Repository source hygiene verification: mode detection, hygiene checks, and in-memory secret scanning."""
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GIT = ["git", "-c", f"safe.directory={ROOT.as_posix()}", "-C", str(ROOT)]

ALLOWLIST_DIRS = ("tests/", "artifacts/")
ALLOWLIST_FILES = {".gitleaks.toml"}

PATTERNS = {
    "GitHub PAT / tokens": re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{40,})\b"),
    "Telegram bot token": re.compile(rb"\b[0-9]{6,12}:[A-Za-z0-9_-]{30,}\b"),
    "Private key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "OpenAI API key": re.compile(rb"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}"),
    "AWS access ID": re.compile(rb"\bAKIA[A-Z0-9]{16}\b"),
    "Google API key": re.compile(rb"\bAIza[0-9A-Za-z_-]{35}\b"),
    "Google OAuth tokens": re.compile(rb"\b(?:ya29\.[0-9A-Za-z_-]{40,}|1//[0-9A-Za-z_-]{40,})\b"),
    "Bearer token": re.compile(rb"(?i)bearer\s+[A-Za-z0-9_\-\.]{25,}"),
}

def is_allowlisted(path: str) -> bool:
    norm = path.replace("\\", "/").strip()
    norm = norm.removeprefix("./").lstrip("/")
    if norm in ALLOWLIST_FILES or norm.endswith("/.gitleaks.toml"):
        return True
    for prefix in ALLOWLIST_DIRS:
        if norm.startswith(prefix) or f"/{prefix}" in norm:
            return True
    return False

def check_hygiene() -> list[str]:
    issues = []
    # 1. Tracked ignored files
    try:
        raw_ignored = subprocess.check_output(GIT + ["ls-files", "-ci", "--exclude-standard", "-z"])
        for raw in raw_ignored.split(b"\0"):
            if raw:
                issues.append(f"Tracked ignored file: {raw.decode('utf-8', 'replace')}")
    except subprocess.CalledProcessError as e:
        issues.append(f"Failed to check tracked ignored files: {e}")

    # 2. Index conflict stages
    try:
        raw_conflicts = subprocess.check_output(GIT + ["ls-files", "-u", "-z"])
        for raw in raw_conflicts.split(b"\0"):
            if raw:
                parts = raw.split(b"\t", 1)
                name = parts[1].decode("utf-8", "replace") if len(parts) > 1 else raw.decode("utf-8", "replace")
                info = parts[0].split()
                stage = info[2].decode("ascii", "replace") if len(info) >= 3 else "unknown"
                issues.append(f"Conflict stage ({stage}) in index: {name}")
    except subprocess.CalledProcessError as e:
        issues.append(f"Failed to check conflict stages: {e}")

    return issues

def get_staged_entries() -> list[tuple[str, str]]:
    """Parse git diff --cached --raw --diff-filter=d -z to extract (oid, path)."""
    try:
        raw = subprocess.check_output(GIT + ["diff", "--cached", "--raw", "--diff-filter=d", "-z"])
    except subprocess.CalledProcessError:
        return []

    tokens = raw.split(b"\0")
    entries = []
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if not token:
            i += 1
            continue
        parts = token.lstrip(b":").split()
        if len(parts) >= 5:
            dst_mode = parts[1]
            dst_sha = parts[3]
            status = parts[4]
            if status.startswith(b"R") or status.startswith(b"C"):
                if i + 2 < len(tokens):
                    path = tokens[i + 2].decode("utf-8", "replace")
                    entries.append((dst_mode.decode("ascii", "replace"), dst_sha.decode("ascii", "replace"), path))
                i += 3
            else:
                if i + 1 < len(tokens):
                    path = tokens[i + 1].decode("utf-8", "replace")
                    entries.append((dst_mode.decode("ascii", "replace"), dst_sha.decode("ascii", "replace"), path))
                i += 2
        else:
            i += 1

    filtered = []
    for mode, oid, path in entries:
        if mode == "160000":
            continue
        if is_allowlisted(path):
            continue
        if not oid or oid.strip("0") == "":
            continue
        filtered.append((oid, path))
    return filtered

def get_index_entries(issues: list[str]) -> list[tuple[str, str]]:
    """Parse git ls-files -s -z to extract (oid, path) and verify stage == 0."""
    try:
        raw = subprocess.check_output(GIT + ["ls-files", "-s", "-z"])
    except subprocess.CalledProcessError as e:
        issues.append(f"Failed to inspect git index: {e}")
        return []

    entries = []
    for item in raw.split(b"\0"):
        if not item:
            continue
        parts = item.split(b"\t", 1)
        if len(parts) < 2:
            continue
        info, name_bytes = parts[0], parts[1]
        tokens = info.split()
        if len(tokens) < 3:
            continue
        mode, oid, stage = tokens[0], tokens[1], tokens[2]
        name = name_bytes.decode("utf-8", "replace")

        if stage != b"0":
            issues.append(f"Conflict stage ({stage.decode('ascii', 'replace')}) in index: {name}")
            continue
        if mode == b"160000":
            continue
        if is_allowlisted(name):
            continue
        oid_str = oid.decode("ascii", "replace")
        if not oid_str or oid_str.strip("0") == "":
            continue
        entries.append((oid_str, name))
    return entries

def scan_objects(entries: list[tuple[str, str]], issues: list[str]) -> None:
    if not entries:
        return

    queries = "".join(oid + "\n" for oid, _ in entries).encode("ascii")
    try:
        proc = subprocess.run(
            GIT + ["cat-file", "--batch"],
            input=queries,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True
        )
    except subprocess.CalledProcessError as e:
        issues.append(f"Failed to query git cat-file --batch: {e}")
        return

    offset = 0
    seen = set()
    for _, name in entries:
        if offset >= len(proc.stdout):
            break
        end = proc.stdout.find(b"\n", offset)
        if end == -1:
            break
        header_line = proc.stdout[offset:end]
        header = header_line.split()
        if len(header) < 2:
            break
        if header[1] == b"missing":
            offset = end + 1
            continue
        if len(header) < 3:
            offset = end + 1
            continue
        try:
            size = int(header[2])
        except ValueError:
            break
        offset = end + 1
        data = proc.stdout[offset:offset + size]
        offset += size + 1  # Trailing newline

        # Skip binary files (null byte in first 8000 bytes)
        if b"\0" in data[:8000]:
            continue

        for pattern_name, pattern in PATTERNS.items():
            for match in pattern.finditer(data):
                line_no = data[:match.start()].count(b"\n") + 1
                key = (name, line_no, pattern_name)
                if key not in seen:
                    seen.add(key)
                    issues.append(f"{name}:{line_no}: detected {pattern_name}; value hidden")

def has_staged_changes() -> bool:
    try:
        raw = subprocess.check_output(GIT + ["diff", "--cached", "--raw", "--diff-filter=d", "-z"])
        return bool(raw.strip(b"\0"))
    except subprocess.CalledProcessError:
        return False

def main(args: list[str] | None = None) -> int:
    if args is None:
        args = sys.argv[1:]

    # 1. Mode detection:
    # - If argument `--staged` is passed, or if run during pre-commit where staged files exist: inspect staged files.
    # - If in CI (GITHUB_ACTIONS env set), or if called without `--staged` and no staged files exist: scan all tracked files in the index.
    if "--staged" in args:
        mode = "staged"
    elif os.environ.get("GITHUB_ACTIONS"):
        mode = "index"
    else:
        mode = "staged" if has_staged_changes() else "index"

    issues: list[str] = []

    # 2. Hygiene checks
    hygiene_issues = check_hygiene()
    issues.extend(hygiene_issues)

    # 3. File entries and secret scanning
    if mode == "staged":
        entries = get_staged_entries()
    else:
        entries = get_index_entries(issues)

    # Deduplicate issues from hygiene / index parsing
    issues = list(dict.fromkeys(issues))

    scan_objects(entries, issues)

    if issues:
        print("\n".join(issues), file=sys.stderr)
        return 1

    mode_label = "staged files" if mode == "staged" else "tracked files in index"
    print(f"PASS: {len(entries)} {mode_label} checked; zero secrets or hygiene issues found.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
