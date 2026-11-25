#!/bin/bash
# The lead's full gate on one worktree: install, every package's tests, type checks, and the whole Rust suite.
# Usage: gate.sh <worktree> [--no-rust]
# Prints one short line a step and exits non-zero when any step failed. The full logs go to a temporary folder it names.
#
# Why each step is here:
# - install: a branch merged in may have added a dependency, and without it every desktop test fails on a missing package.
# - cargo test, not cargo check: a helper once compiled its Rust tests without running them, and two were failing.
# - $HOME, never ~, in CARGO_TARGET_DIR: an unexpanded ~ once put a 3 GB build cache inside a worktree and a commit.
set -u
wt=${1:?usage: gate.sh <worktree> [--no-rust]}
rust=1; [ "${2:-}" = "--no-rust" ] && rust=0
logs=$(mktemp -d "${TMPDIR:-/tmp}/manut-gate.XXXXXX")
cd "$wt" || exit 2
fail=0

if [ -n "$(git status --porcelain)" ]; then echo "note: uncommitted files in $wt (the gate runs on what is on disk)"; fi

pnpm install --frozen-lockfile --prefer-offline > "$logs/install.log" 2>&1 || { echo "install: FAILED ($logs/install.log)"; exit 1; }

pnpm --config.verify-deps-before-run=false test > "$logs/test.log" 2>&1; code=$?
counts=$(grep -E "^apps/[a-z]+ test: +Tests " "$logs/test.log" | sed -E 's/^apps\/([a-z]+) test: +Tests +/\1 /' | tr '\n' ';')
scripts=$(grep -E "^ℹ (pass|fail)" "$logs/test.log" | tr '\n' ' ')
if [ $code -eq 0 ]; then echo "test: ok  $counts scripts: $scripts"; else
  fail=1; echo "test: FAILED  $counts"
  grep -E " FAIL | × |Cannot find package|Error: " "$logs/test.log" | cut -c1-200 | sort -u | head -15
fi

pnpm --config.verify-deps-before-run=false typecheck > "$logs/types.log" 2>&1; code=$?
if [ $code -eq 0 ]; then echo "typecheck: ok"; else fail=1; echo "typecheck: FAILED"; grep -E "error TS" "$logs/types.log" | cut -c1-220 | head -10; fi

if [ $rust -eq 1 ]; then
  while pgrep -x cargo > /dev/null; do sleep 5; done   # one cargo at a time on this Mac
  ( cd apps/desktop/src-tauri && CARGO_BUILD_JOBS=4 CARGO_TARGET_DIR="$HOME/Library/Caches/manut-ai-cargo-target" cargo test --locked ) > "$logs/rust.log" 2>&1; code=$?
  results=$(sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$logs/rust.log" | grep -E "^test result" | awk '{p+=$4; f+=$6} END {print p " passed, " f " failed"}')
  if [ $code -eq 0 ]; then echo "rust: ok  $results"; else
    fail=1; echo "rust: FAILED  $results"
    sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$logs/rust.log" | grep -E "^error|FAILED|panicked at" | cut -c1-200 | head -10
  fi
fi

echo "logs: $logs"
exit $fail
