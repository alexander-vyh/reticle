#!/usr/bin/env python3
"""
Pre-commit hook to detect PII and company-specific data.

Adapted from cake/scripts/check_pii_patterns.py for reticle (JavaScript/Swift).

Should FAIL on: real emails, real Atlassian URLs, real Jira keys, real names,
                internal Slack channels, personal file paths.
Should PASS on: example.com, company.atlassian.net, placeholder names.
"""

import re
import sys
from pathlib import Path
from typing import List, Optional

# Company-specific and personal patterns to BLOCK
PII_PATTERNS = [
    # Real company domains
    (r"simpli\.fi", "Real company domain (use example.com)"),
    (r"simplifi\.atlassian\.net", "Real Atlassian URL (use company.atlassian.net)"),
    # Real Jira project keys (with digit suffix = real ticket, not placeholder)
    (r"DWDEV-\d+", "Real Jira issue key (use ENG-xxx)"),
    (r"\bDWS-\d+", "Real Jira issue key (use ENGSUP-xxx)"),
    # Real company emails
    (r"[a-z.]+@simpli\.fi", "Real company email (use user@example.com)"),
    # Personal identifiers
    (r"alexandervyhmeister", "Personal identifier (use a placeholder)"),
    # Personal file paths
    (r"/Users/alexandervyhmeister", "Personal file path (use /Users/USERNAME)"),
    # Real internal Slack channels
    (r"\biops-dw\b", "Real internal Slack channel (use eng-platform)"),
    (r"cox_simplifi", "Real customer-specific Slack channel"),
]

# Lines matching these patterns are exempt even if they also match a PII pattern
ALLOWED_PATTERNS = [
    r"@example\.com",
    r"company\.atlassian\.net",
    r"yourcompany\.atlassian\.net",
    r"/Users/USERNAME",
    r"/Users/username",
    # GitHub username in CODEOWNERS is acceptable
    r"@alexandervyhmeister.*CODEOWNERS",
    # Detection rules in gitleaks config are acceptable
    r'keyword\s*=\s*\[.*simpli',
    r'description\s*=.*simpli',
]

# File extensions to check
CHECKED_EXTENSIONS = {
    ".js", ".mjs", ".cjs",
    ".swift",
    ".md",
    ".json",
    ".sh",
    ".yml", ".yaml",
    ".py",
    ".toml",
    ".plist",
}

# Paths to skip entirely
EXCLUDE_PATHS = [
    ".git/",
    "node_modules/",
    ".beads/",
    "recorder/.build/",
    "recorder/scripts/.venv/",
    "reticle/.build/",
    "reticle/DerivedData/",
    # This script itself contains patterns for detection — don't self-flag
    "scripts/check_pii_patterns.py",
    # Gitleaks config intentionally contains detection patterns
    ".gitleaks.toml",
]


def should_check_file(file_path: Path) -> bool:
    path_str = str(file_path)
    if any(excl in path_str for excl in EXCLUDE_PATHS):
        return False
    if file_path.suffix not in CHECKED_EXTENSIONS:
        return False
    return True


def is_allowed(line: str) -> bool:
    return any(re.search(p, line, re.IGNORECASE) for p in ALLOWED_PATTERNS)


def check_file(file_path: Path) -> List[dict]:
    if not should_check_file(file_path):
        return []

    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()
    except Exception as e:
        print(f"Warning: could not read {file_path}: {e}", file=sys.stderr)
        return []

    violations = []
    for line_num, line in enumerate(lines, 1):
        if is_allowed(line):
            continue
        for pattern, description in PII_PATTERNS:
            for match in re.finditer(pattern, line, re.IGNORECASE):
                violations.append({
                    "file": str(file_path),
                    "line": line_num,
                    "description": description,
                    "match": match.group(0),
                })
    return violations


def main():
    if len(sys.argv) < 2:
        print("Usage: check_pii_patterns.py <file1> [file2] ...", file=sys.stderr)
        sys.exit(0)  # No files = nothing to check

    all_violations = []
    for arg in sys.argv[1:]:
        path = Path(arg)
        if path.exists() and path.is_file():
            all_violations.extend(check_file(path))

    if all_violations:
        print("\n❌ PII/company-specific data detected — commit blocked\n")
        for v in all_violations:
            print(f"  {v['file']}:{v['line']}")
            print(f"    Found:  {v['match']!r}")
            print(f"    Reason: {v['description']}\n")
        print("Fix violations above, then re-stage and commit.")
        sys.exit(1)

    sys.exit(0)


if __name__ == "__main__":
    main()
