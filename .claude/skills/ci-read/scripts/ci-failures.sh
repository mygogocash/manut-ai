#!/bin/bash
# The newest CI run of the working branch: what it ran, what failed, and the failing tests' own lines.
# Usage: ci-failures.sh [<commit prefix>]      (no argument: the newest push run on pilot/week-1)
# It reads job logs through the API, which works while the run is still going; `gh run view --log` does not.
# CI's Playwright shards may fail without failing the run, so a green run can still hold failed specs: they show here.
set -u
repo=mygogocash/manut-ai
export GH_TOKEN="$(gh auth token --user KunanonJ)"
want=${1:-}
id=$(gh run list --repo $repo --workflow CI --event push --branch pilot/week-1 --limit 15 --json databaseId,headSha \
  --jq "[.[] | select(.headSha | startswith(\"$want\"))][0].databaseId")
[ -n "$id" ] && [ "$id" != "null" ] || { echo "no CI push run found for '$want'"; exit 1; }
gh run view "$id" --repo $repo --json headSha,status,conclusion,jobs \
  --jq '"\(.headSha[0:7]): \(.status) \(.conclusion // "-")", (.jobs[] | select(.conclusion != "success") | "  \(.name): \(.status) \(.conclusion // "-")")'
for job in $(gh run view "$id" --repo $repo --json jobs --jq '.jobs[] | select(.conclusion == "failure") | .databaseId'); do
  name=$(gh run view "$id" --repo $repo --json jobs --jq ".jobs[] | select(.databaseId == $job) | .name")
  echo "--- $name"
  curl -sL --max-time 90 -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$repo/actions/jobs/$job/logs" | sed 's/\x1b\[[0-9;]*m//g' |
    grep -E " ✘ | × | FAIL |Error: |^.{28} +[0-9]+ (failed|flaky)|test result: FAILED|panicked at|error(\[|:)" | cut -c30-260 | sort -u | head -20
done
