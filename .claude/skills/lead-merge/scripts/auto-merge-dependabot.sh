#!/bin/bash
# Merges Dependabot's low-risk pull requests into pilot/week-1 once CI is green on their head; lists the others.
# Usage: LEAD_WORKTREE=<the lead's worktree> auto-merge-dependabot.sh [--yes] [--wait]
#
# Why: the owner agreed on 26 Nov 2026 that minor and patch dependency bumps merge on a green CI run. Dependabot's
# version updates target pilot/week-1 (item 127). For each open Dependabot pull request into pilot/week-1 it fetches the
# head, asks the classifier (.github/scripts/merge-risk.mjs, the LEAD's copy) for `low` or `review`, and reads CI's run
# of that exact commit. Only `low` with a green run is merged, with `gh pr merge --merge`, matched to the head it checked, or the asynchronous merge endpoint if that is refused.
# Everything else is listed with why, for the lead.
#
# Dry run by default: it prints what it would merge. --yes merges. By default it does not wait for a run that is still
# going (the pull request is listed as waiting; run it again); --wait waits for each, up to CI_WAIT_MINUTES.
# It never touches a pull request that is not Dependabot's, never closes or comments, and never forces.
set -u
yes=0
waitci=0
for arg in "$@"; do
  case "$arg" in
    --yes) yes=1 ;;
    --wait) waitci=1 ;;
    *) echo "usage: auto-merge-dependabot.sh [--yes] [--wait]"; exit 2 ;;
  esac
done
here=$(cd "$(dirname "$0")" && pwd)
repo=mygogocash/manut-ai
base=pilot/week-1
# The lead's worktree, named each time (finish-item.sh says why): only its copy of the classifier is trusted.
lead=${LEAD_WORKTREE:-}
[ -n "$lead" ] && [ -d "$lead" ] || { echo "set LEAD_WORKTREE to the lead's worktree, whose classifier is the one trusted"; exit 1; }
clone="$HOME/Developer/manut-ai"
classifier="$lead/.github/scripts/merge-risk.mjs"
if [ -z "${GH_TOKEN:-}" ]; then token=$(gh auth token --user KunanonJ 2>/dev/null) && [ -n "$token" ] && export GH_TOKEN="$token"; fi
[ -f "$classifier" ] || { echo "the lead's worktree has no .github/scripts/merge-risk.mjs"; exit 1; }

list=$(gh pr list --repo "$repo" --base "$base" --author "app/dependabot" --state open --limit 100 \
  --json number,title,headRefName,headRefOid --jq '.[] | [.number, .headRefOid, .headRefName, .title] | @tsv') || { echo "could not list the pull requests"; exit 1; }
[ -n "$list" ] || { echo "no open Dependabot pull requests into $base"; exit 0; }
git -C "$clone" fetch -q origin "+refs/heads/$base:refs/remotes/origin/$base" || { echo "could not fetch $base"; exit 1; }

# The asynchronous merge, for when gh pr merge is refused (GitHub refuses the synchronous endpoint for a stacked pull
# request, as it did for #1). PUT .../pulls/N/merge-async answers 202 {status: "pending", details: {uuid}} (200 if already
# merged, 409 with the pending request's uuid, 400 for a draft or closed pull request); GET .../merge-async/<uuid> is
# then polled until status is merged (details.sha is the merge commit) or failed (details.message says why). The sha
# makes it merge only the head that was checked.
merge_async() {
  local n=$1 sha=$2 reply status uuid
  reply=$(gh api -X PUT "repos/$repo/pulls/$n/merge-async" -f merge_method=merge -f merge_action=direct_merge -f sha="$sha" 2>&1) || {
    # A 409 means a request is already pending: its uuid is in the body, so wait on that one.
    printf '%s' "$reply" | grep -q '"uuid"' || return 1
  }
  status=$(printf '%s' "$reply" | jq -r '.status // empty' 2>/dev/null)
  uuid=$(printf '%s' "$reply" | jq -r '.details.uuid // empty' 2>/dev/null)
  [ "$status" = "merged" ] && return 0
  [ -n "$uuid" ] || return 1
  for _ in $(seq 1 "${AUTO_MERGE_POLL_TRIES:-40}"); do
    status=$(gh api "repos/$repo/pulls/$n/merge-async/$uuid" --jq '.status' 2>/dev/null) || return 1
    case "$status" in
      merged) return 0 ;;
      failed) return 1 ;;
    esac
    sleep "${AUTO_MERGE_POLL:-3}"
  done
  return 1
}

merged=0; left=0
while IFS=$'\t' read -r number sha branch title; do
  [ -n "$number" ] || continue
  tag="#$number $title"
  if ! git -C "$clone" fetch -q origin "+refs/pull/$number/head:refs/auto-merge/pr-$number" 2>/dev/null ||
     [ "$(git -C "$clone" rev-parse "refs/auto-merge/pr-$number")" != "$sha" ]; then
    echo "review   $tag: its head could not be fetched, or moved while listing"; left=$((left + 1)); continue
  fi
  out=$(node "$classifier" "origin/$base" "$sha" --repo "$clone"); code=$?
  if [ "$code" -ne 0 ] || [ "$(printf '%s\n' "$out" | head -1)" != "low" ]; then
    echo "review   $tag: the classifier says review"
    printf '%s\n' "$out" | sed -n '2,$p' | grep -v '^  ok' | head -4 | sed 's/^/           /'
    left=$((left + 1)); continue
  fi
  # Dependabot's branches are not ones CI runs on a push of, so the run to read is the pull request's own.
  if [ $waitci -eq 1 ]; then minutes=${CI_WAIT_MINUTES:-45}; else minutes=0; fi
  if [ $waitci -eq 1 ]; then quick=""; else quick="CI_WAIT_TRIES=1 CI_WAIT_POLL=2"; fi
  # shellcheck disable=SC2086 # $quick is two assignments
  env $quick CI_WAIT_EVENTS="pull_request push workflow_dispatch" CI_WAIT_MINUTES=$minutes CI_WAIT_REMOTE="${CI_WAIT_REMOTE:-$(git -C "$clone" remote get-url origin)}" "$here/ci-wait.sh" "$branch" "$sha" > /dev/null; ci=$?
  if [ "$ci" -ne 0 ]; then
    case "$ci" in
      1) echo "review   $tag: low risk, but CI is red on ${sha:0:7}" ;;
      *) echo "waiting  $tag: low risk, but CI has no finished run of ${sha:0:7} yet (run again, or use --wait)" ;;
    esac
    left=$((left + 1)); continue
  fi
  if [ $yes -eq 0 ]; then echo "would merge  $tag (low risk, CI green on ${sha:0:7})"; continue; fi
  if gh pr merge "$number" --repo "$repo" --merge --match-head-commit "$sha" >/dev/null 2>&1 || merge_async "$number" "$sha"; then
    echo "merged   $tag"; merged=$((merged + 1))
  else
    echo "review   $tag: low risk and green, but GitHub refused the merge (a conflict, a draft, or the head moved)"; left=$((left + 1))
  fi
done <<< "$list"
echo "done: $merged merged, $left left for the lead$([ $yes -eq 0 ] && echo " (dry run: nothing is merged without --yes)")"
