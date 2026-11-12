#!/usr/bin/env bash
# Fails if anything in the tracked files looks like a credential.
# Deliberately simple and dependency-free; it complements, not replaces, care.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
patterns=(
  'AIza[0-9A-Za-z_-]{35}'                 # Google API key
  'GOCSPX-[0-9A-Za-z_-]{20,}'             # Google OAuth client secret
  'ya29\.[0-9A-Za-z_-]{20,}'              # Google access token
  '1//0[0-9A-Za-z_-]{20,}'                # Google refresh token
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'    # private keys
  'sk-ant-[0-9A-Za-z_-]{20,}'             # Anthropic key
  'gh[pousr]_[0-9A-Za-z]{30,}'            # GitHub tokens
  'xox[abprs]-[0-9A-Za-z-]{10,}'          # Slack tokens
)
found=0
for pattern in "${patterns[@]}"; do
  if git grep -nIE -e "$pattern" -- . ':!**/package-lock.json' ':!**/scripts/secret-scan.sh'; then found=1; fi
done
for file in $(git ls-files); do
  case "$file" in
    *.dev.vars|*/.dev.vars|.env|*/.env|*.pem|*.key) echo "Tracked secret-like file: $file"; found=1 ;;
  esac
done
if [ "$found" -ne 0 ]; then echo "Possible secret found. Remove it and rotate the credential."; exit 1; fi
echo "Secret scan: clean"
