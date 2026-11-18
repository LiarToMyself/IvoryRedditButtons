"""Fast agent command gate: instantly allows non-commit tools, checks source hygiene on git commit/push."""
import json
import subprocess
import sys
from pathlib import Path

def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        print(json.dumps({"decision": "allow"}))
        return 0

    tool_name = payload.get("tool_name", "")
    args = payload.get("arguments", {})

    if tool_name != "run_command":
        print(json.dumps({"decision": "allow"}))
        return 0

    command_line = args.get("CommandLine", "") or args.get("command_line", "")
    command_lower = command_line.lower()

    if "commit" not in command_lower and "push" not in command_lower:
        print(json.dumps({"decision": "allow"}))
        return 0

    script_dir = Path(__file__).resolve().parent
    checker = script_dir / "check_source_hygiene.py"
    if not checker.exists():
        checker = script_dir / "check_secrets.py"
    if checker.exists():
        res = subprocess.run([sys.executable, str(checker)], capture_output=True, text=True)
        if res.returncode != 0:
            error_msg = res.stderr.strip() or res.stdout.strip() or "Source hygiene check failed."
            print(json.dumps({
                "decision": "deny",
                "explanation": f"Commit blocked by check_source_hygiene.py:\n{error_msg}"
            }))
            return 0

    print(json.dumps({"decision": "allow"}))
    return 0

if __name__ == "__main__":
    main()
