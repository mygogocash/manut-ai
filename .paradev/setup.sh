#!/usr/bin/env bash
# Paradev runs this once when it creates a local workspace, after [install] has put the dependencies in
# (.paradev/config.toml). A new worktree has none of the main checkout's ignored env files, so this copies them over:
# apps/api/.dev.vars holds what `wrangler dev` reads as secrets (docs/model-gateway.md), and a .env or .env.* holds a
# Vite app's settings. A file the worktree already has is left as it is, so running this again never undoes a change
# made here. It prints file names only, never what is in them.
set -euo pipefail

cd "$(dirname "$0")/.."
here="$(pwd -P)"

if [[ -z "${SUPERSET_ROOT_PATH:-}" ]]; then
  echo "setup: no main checkout was named (SUPERSET_ROOT_PATH), so no env files were copied."
  exit 0
fi
if [[ ! -d "$SUPERSET_ROOT_PATH" ]]; then
  echo "setup: the main checkout $SUPERSET_ROOT_PATH is not there, so no env files were copied."
  exit 0
fi
root="$(cd "$SUPERSET_ROOT_PATH" && pwd -P)"
if [[ "$root" == "$here" ]]; then
  echo "setup: this is the main checkout itself, so there is nothing to copy."
  exit 0
fi

copied=0
# Depth 3 reaches apps/<app>/ and packages/<package>/, where the env files live. Git's folder and the dependency, build,
# Rust target and Wrangler state folders are skipped: they are large, and an env file inside one is not ours to copy.
while IFS= read -r -d '' file; do
  rel="${file#"$root"/}"
  if [[ -e "$rel" ]]; then
    echo "setup: left $rel as it is"
    continue
  fi
  mkdir -p "$(dirname "$rel")"
  cp -p "$file" "$rel"
  echo "setup: copied $rel from the main checkout"
  copied=$((copied + 1))
done < <(find "$root" -maxdepth 3 \
  \( -name node_modules -o -name .git -o -name target -o -name dist -o -name .wrangler \) -prune -o \
  -type f \( -name .env -o -name '.env.*' -o -name .dev.vars -o -name '.dev.vars.*' \) -print0)

echo "setup: copied $copied env file(s) from the main checkout."
