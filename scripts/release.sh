#!/usr/bin/env bash
# Publishes GitHub release v<version> (ui/package.json) from the pushed tag and uploads the
# installer, its .blockmap and latest.yml from release/. Run from WSL after `npm run dist`,
# the commits and `git.exe push origin main v<version>`. Notes: release/release-notes-<version>.md.
# Token: a fine-grained PAT (this repo, Contents: read and write) in %USERPROFILE%\.gh-token,
# or GH_TOKEN_FILE. It never reaches argv or the log: curl reads the header from a 0600 file.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
REL=$ROOT/release
V=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/ui/package.json")
TOKEN_FILE=${GH_TOKEN_FILE:-$(wslpath "$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')")/.gh-token}
TITLE=${TITLE:-$V}
REPO=Crying-Soul/ai-suflyor
HDR=$(mktemp); trap 'rm -f "$HDR"' EXIT; chmod 600 "$HDR"
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n ' < "$TOKEN_FILE")" > "$HDR"
api=(-sS -H @"$HDR" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")

# The installer's SHA-256 goes into the notes and a SHA256SUMS.txt asset: the unsigned exe can be
# checked against it with `Get-FileHash`.
EXE="Suflyor-Setup-$V.exe"
SHA=$(sha256sum "$REL/$EXE" | cut -d' ' -f1)
printf '%s  %s\n' "$SHA" "$EXE" > "$REL/SHA256SUMS.txt"
body=$(python3 -c 'import json,sys; notes=open(sys.argv[1],encoding="utf-8").read().rstrip()+"\n\n**SHA-256** `"+sys.argv[5]+"`: "+sys.argv[4]+"\n\nПроверка в PowerShell: `Get-FileHash .\\"+sys.argv[5]+"`"; print(json.dumps({"tag_name":"v"+sys.argv[2],"name":sys.argv[3],"body":notes,"draft":False,"prerelease":False}))' "$REL/release-notes-$V.md" "$V" "$TITLE" "$SHA" "$EXE")
resp=$(curl "${api[@]}" -X POST "https://api.github.com/repos/$REPO/releases" -d "$body")
id=$(printf '%s' "$resp" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("id") or ""); sys.stderr.write(d.get("message","")+"\n")')
[ -n "$id" ] || { echo "release not created"; exit 1; }
echo "release id $id"
for f in "$EXE" "$EXE.blockmap" latest.yml SHA256SUMS.txt; do
  curl "${api[@]}" -X POST -H "Content-Type: application/octet-stream" --data-binary @"$REL/$f" \
    "https://uploads.github.com/repos/$REPO/releases/$id/assets?name=$f" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("name"), d.get("size"), d.get("state") or d.get("message"))'
done
curl "${api[@]}" "https://api.github.com/repos/$REPO/releases/$id" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["html_url"])'
