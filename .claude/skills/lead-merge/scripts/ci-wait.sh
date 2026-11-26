#!/bin/bash
# Waits for CI's run of a branch's head commit on GitHub, then prints each job's result.
# Usage: ci-wait.sh <branch> [<commit>]
#   <commit> is the full SHA the run must be of; without it, the branch's head on GitHub now.
# Exits 0 when the run finished and no job that ran failed (a skipped job counts as passed, as CI's own summary says),
# 1 when a job failed or the run was cancelled, and 2 when no run of that commit appeared or it did not finish in time.
#
# Why: the lead merges an item when CI is green on the exact commit it merges (finish-item.sh --ci), instead of a
# gate.sh on the lead's 8 GB Mac, one item at a time behind a lock (item 126, 26 Nov 2026). CI runs on every push of a
# helper's branch (feat/, fix/, refactor/, test/, docs/, ci/, chore/), so the helper merges the lead's branch in and
# pushes, and this reads the answer.
#
# Only a run started by a push or by hand counts: a pull request's run of a branch that CI runs on its pushes skips
# every job and is green without checking anything (.github/scripts/changed-areas.mjs). It only reads GitHub.
set -u
repo=mygogocash/manut-ai
branch=${1:?usage: ci-wait.sh <branch> [<commit>]}
want=${2:-}
limit=${CI_WAIT_MINUTES:-45}   # a full run takes about ten minutes, and a second one at once waits for places
# Where the branch's head is read, and how often GitHub is asked: the tests (.github/scripts/lead-merge.test.mjs) point
# these at a local repository and a stand-in gh, and do not wait.
remote=${CI_WAIT_REMOTE:-https://github.com/$repo.git}
poll=${CI_WAIT_POLL:-30}
tries=${CI_WAIT_TRIES:-20}
# The account that sees the organisation, as the ci-read skill's script uses; without it, gh's own login.
if [ -z "${GH_TOKEN:-}" ]; then token=$(gh auth token --user KunanonJ 2>/dev/null) && [ -n "$token" ] && export GH_TOKEN="$token"; fi

head=$(git ls-remote "$remote" "refs/heads/$branch" | cut -f1)
[ -n "$head" ] || { echo "$branch is not on GitHub: push it first"; exit 2; }
if [ -n "$want" ] && [ "$head" != "$want" ]; then
  echo "$branch on GitHub is at ${head:0:7}, not ${want:0:7}: push the commit you mean to merge, then wait for its run"
  exit 2
fi
echo "CI for $branch at ${head:0:7}"

# The newest run of this commit that a push or a person started. A run takes a few seconds to appear after a push.
find_run() {
  gh run list --repo "$repo" --workflow ci.yml --branch "$branch" --commit "$head" --limit 10 \
    --json databaseId,event --jq '[.[] | select(.event == "push" or .event == "workflow_dispatch")][0].databaseId // empty'
}
id=""
for _ in $(seq 1 "$tries"); do
  id=$(find_run) && [ -n "$id" ] && break
  sleep $((poll / 2))
done
if [ -z "$id" ]; then
  echo "no CI run of ${head:0:7} on $branch yet. CI runs on pushes to main, pilot/, cloud/, feat/, fix/,"
  echo "refactor/, test/, docs/, ci/ and chore/ branches; for another branch start one: gh workflow run ci.yml --ref $branch"
  exit 2
fi
echo "run $id: https://github.com/$repo/actions/runs/$id"

# Waits, saying every five minutes how far the run has got.
start=$(date +%s)
last=0
while :; do
  status=$(gh run view "$id" --repo "$repo" --json status --jq .status 2>/dev/null || echo unknown)
  [ "$status" = "completed" ] && break
  now=$(date +%s)
  if [ $((now - start)) -ge $((limit * 60)) ]; then echo "the run did not finish in $limit minutes (CI_WAIT_MINUTES); it is still $status"; exit 2; fi
  if [ $((now - last)) -ge 300 ]; then
    gh run view "$id" --repo "$repo" --json jobs \
      --jq '"  still running: \([.jobs[] | select(.status == "completed")] | length) of \(.jobs | length) jobs done"' 2>/dev/null || true
    last=$now
  fi
  sleep "$poll"
done

# One line a job, then the verdict. Success, skipped and neutral pass; anything else (failure, cancelled, timed out,
# a startup failure) does not.
gh run view "$id" --repo "$repo" --json conclusion,jobs --jq '
  .jobs[] | "  \(.conclusion // .status)\t\(.name)\(if .startedAt and .completedAt and .conclusion != "skipped" then
    "\t\(((.completedAt | fromdateiso8601) - (.startedAt | fromdateiso8601)) / 60 | floor)m \(((.completedAt | fromdateiso8601) - (.startedAt | fromdateiso8601)) % 60)s" else "" end)"'
# shellcheck disable=SC2016 # $c is jq's variable, not the shell's
verdict=$(gh run view "$id" --repo "$repo" --json conclusion,jobs --jq '
  if .conclusion != "success" then "the run ended as \(.conclusion)"
  elif ([.jobs[] | select((.conclusion // "") as $c | ["success", "skipped", "neutral"] | index($c) | not)] | length) > 0
  then "a job did not pass" else "green" end')
if [ "$verdict" = "green" ]; then echo "green: every job that ran passed on ${head:0:7}"; exit 0; fi
echo "not green on ${head:0:7}: $verdict. Read why: gh run view $id --repo $repo --log-failed"
exit 1
