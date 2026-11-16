#!/usr/bin/env bash
# Fails if anything in the tracked files looks like a credential, or like one person's own settings.
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
    *wrangler.local.jsonc) echo "Tracked personal settings file: $file"; found=1 ;;
  esac
done

# This repository is public and meant for anyone to deploy, so nobody's own settings belong in it.
# A real Google client ID anywhere in tracked files:
if git grep -nIE -e '[0-9]{8,}-[0-9a-z]{20,}\.apps\.googleusercontent\.com' -- . ':!**/package-lock.json'; then
  echo "A real-looking Google client ID is committed."; found=1
fi
# The committed Worker configuration must still be the template: every personal value a placeholder.
template="$(git ls-files '*youtube-mcp/wrangler.jsonc' 'wrangler.jsonc' | head -n 1)"
if [ -n "$template" ]; then
  expect() { grep -qF -- "$1" "$template" || { echo "$template: expected the template value $1 (personal settings go in wrangler.local.jsonc)"; found=1; }; }
  expect '"PUBLIC_URL": "https://yt-mcp.example.com"'
  expect '"GOOGLE_CLIENT_ID": "REPLACE.apps.googleusercontent.com"'
  expect '"ALLOWED_GOOGLE_ACCOUNTS": "you@example.com"'
  expect '"ALLOWED_CHANNEL_IDS": ""'
  expect '"id": "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"'
  if grep -qE '"GOOGLE_CLIENT_SECRET"' "$template"; then echo "$template: the client secret must never be in a file"; found=1; fi
fi
if [ "$found" -ne 0 ]; then echo "Possible secret or personal setting found. Remove it; if it was a credential, rotate it."; exit 1; fi
echo "Secret scan: clean"
