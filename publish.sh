#!/usr/bin/env bash
# Build the encrypted site and push it to GitHub Pages.
# First time: create the GitHub repo, then run ./publish.sh <repo-url>
# After that:  ./publish.sh
set -euo pipefail
cd "$(dirname "$0")"

command -v node >/dev/null || { echo "✗ Node.js 18 or newer is required. Install it (e.g. 'brew install node') and run this again."; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || { echo "✗ Node.js 18 or newer is required (you have $(node -v))."; exit 1; }

if [ ! -d .git ]; then
  git init -q -b main
  echo "✓ Created a git repository here."
fi

if [ "${1:-}" != "" ]; then
  if git remote get-url origin >/dev/null 2>&1; then git remote set-url origin "$1"; else git remote add origin "$1"; fi
  echo "✓ GitHub remote set to $1"
fi

# Safety: the plaintext must be ignored before anything is staged.
if ! git check-ignore -q content/dossier.md; then
  echo "✗ content/ is not git-ignored. Restore .gitignore before publishing."; exit 1
fi

node build.mjs

# Safety: the built page must contain ciphertext only.
if ! grep -q '"mode":"enc"' docs/index.html; then
  echo "✗ docs/index.html is not encrypted. Nothing was committed."; exit 1
fi

git add .gitignore README.md build.mjs publish.sh dossier.salt app vendor test docs
if git diff --cached --quiet; then
  echo "✓ Nothing changed since the last publish."
else
  git commit -q -m "Publish dossier $(date +%Y-%m-%d)"
  echo "✓ Committed."
fi

if git remote get-url origin >/dev/null 2>&1; then
  git push -u origin main
  echo
  echo "✓ Pushed. GitHub Pages refreshes within a minute or two."
else
  echo
  echo "Next: create the repo on GitHub, then run ./publish.sh https://github.com/<you>/<repo>.git"
fi
