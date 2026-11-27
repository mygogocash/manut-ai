#!/bin/bash
# Merges an item the classifier calls low-risk, once CI is green on its exact head, without the lead's review.
# Usage: LEAD_WORKTREE=<the lead's worktree> auto-merge.sh [--dry-run] [--no-push] <item worktree> <merge message file>
#
# Why: the owner agreed on 26 Nov 2026 that low-risk work (documentation, a refactor that changes nothing visible, minor
# and patch dependency bumps) merges on a green CI run, and the lead keeps reviewing features and security work. GitHub's
# own auto-merge and branch protection need repository settings the owner has not given, so this runs from the lead's Mac.
#
# It refuses, and says why, unless every one of these holds:
#   - both worktrees are clean, the lead's branch is in the item's branch, and the message has a Co-Authored-By line;
#   - .github/scripts/merge-risk.mjs, read from the LEAD's worktree (never the item's copy: a branch could carry a
#     loosened classifier), answers `low` for the lead's branch against the item's head, given the message file (it reads
#     the `Risk: refactor` trailer there);
#   - the item's head is on GitHub, and ci-wait.sh reports a green run of exactly that commit.
# Then finish-item.sh --ci merges that commit and removes the item's worktree, and the lead's branch is pushed to
# pilot/week-1 (a fast-forward, never forced). A `low` answer never skips CI: the green run is always required.
#
# --dry-run prints the classifier's decision and stops: no waiting for CI, no merge, no push.
# --no-push merges but leaves the lead's branch for the lead to mark the plan and handoff and push with them.
set -u
dry=0
push=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1; shift ;;
    --no-push) push=0; shift ;;
    --*) echo "unknown flag $1"; exit 2 ;;
    *) break ;;
  esac
done
wt=${1:?usage: auto-merge.sh [--dry-run] [--no-push] <item worktree> <merge message file>}
msg=${2:?merge message file}
here=$(cd "$(dirname "$0")" && pwd)
refuse() { echo "auto-merge refused: $*"; exit 1; }
# The lead's worktree, named each time (finish-item.sh says why), and handed on to finish-item.sh in the environment.
lead=${LEAD_WORKTREE:-}
[ -n "$lead" ] && [ -d "$lead" ] || refuse "set LEAD_WORKTREE to the lead's worktree, the one that pushes HEAD:pilot/week-1"

[ -d "$wt" ] || refuse "no worktree at $wt"
[ -f "$msg" ] || refuse "no merge message file at $msg"
branch=$(git -C "$wt" branch --show-current)
lead_branch=$(git -C "$lead" branch --show-current)
[ -n "$branch" ] || refuse "the item's worktree is not on a branch"
case "$branch" in main|pilot/*) refuse "$branch is not an item branch" ;; esac
[ -z "$(git -C "$wt" status --porcelain)" ] || refuse "the item's worktree has uncommitted files"
[ -z "$(git -C "$lead" status --porcelain)" ] || refuse "the lead's worktree has uncommitted files"
git -C "$wt" merge-base --is-ancestor "$lead_branch" HEAD || refuse "$lead_branch is not in $branch: merge it in, push, and ask again"
grep -q "^Co-Authored-By: " "$msg" || refuse "the merge message has no Co-Authored-By line"
head=$(git -C "$wt" rev-parse HEAD)

classifier="$lead/.github/scripts/merge-risk.mjs"
[ -f "$classifier" ] || refuse "the lead's worktree has no .github/scripts/merge-risk.mjs"
verdict=$(node "$classifier" "$lead_branch" "$head" --repo "$wt" --message "$msg"); code=$?
echo "$verdict"
[ "$code" -eq 0 ] && [ "$(printf '%s\n' "$verdict" | head -1)" = "low" ] || refuse "the classifier says review, not low: the lead reviews this one"
if [ $dry -eq 1 ]; then echo "dry run: low risk; CI was not waited for and nothing was merged"; exit 0; fi

# A low answer never skips CI.
"$here/ci-wait.sh" "$branch" "$head" || refuse "CI is not green on ${head:0:7}"
"$here/finish-item.sh" --ci "$wt" "$msg" || refuse "finish-item.sh did not merge"

if [ $push -eq 1 ]; then
  git -C "$lead" push origin HEAD:pilot/week-1 || { echo "the merge is done here, but the push to pilot/week-1 failed: push it yourself"; exit 1; }
  echo "pushed $lead_branch to pilot/week-1"
else
  echo "merged; not pushed (--no-push): mark the plan and handoff, then: git -C $lead push origin HEAD:pilot/week-1"
fi
