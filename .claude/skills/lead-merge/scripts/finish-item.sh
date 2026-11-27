#!/bin/bash
# Merges a checked item branch into the lead's worktree and clears the item's worktree and branches away.
# Usage: finish-item.sh [--ci] <item worktree> <merge message file>
#
# With --ci (the usual way since item 126, 26 Nov 2026): the helper has merged the lead's branch into the item's and
# pushed it, and CI on GitHub checked that commit. This script requires the item's head here to be the branch's head on
# GitHub, waits for CI's run of exactly that commit (ci-wait.sh), and merges only when every job that ran passed. A
# commit added after the run, or a push while it waits, refuses the merge: what merges is what CI checked.
#
# Without --ci: run it only after gate.sh passed on the item's worktree, for when CI is down. It then pushes the branch
# itself.
#
# Either way the lead's branch must already be in the item's branch, so the merged tree is exactly the tree that was
# checked, and the script refuses otherwise. It does not push the lead's branch: mark the plan and the handoff first,
# then push both commits together (git push origin HEAD:pilot/week-1 from the lead's worktree), so CI runs once.
#
# It never merges to main, never forces, and removes only this item's own worktree and branch, which the merge now holds.
set -eu
ci=0
if [ "${1:-}" = "--ci" ]; then ci=1; shift; fi
wt=${1:?usage: finish-item.sh [--ci] <item worktree> <merge message file>}
msg=${2:?merge message file}
here=$(cd "$(dirname "$0")" && pwd)
lead="$HOME/.t3/worktrees/manut-ai/t3-0c461873-e8dd6bc2489b4766"
repo="$HOME/Developer/manut-ai"
branch=$(git -C "$wt" branch --show-current)
lead_branch=$(git -C "$lead" branch --show-current)

[ -z "$(git -C "$wt" status --porcelain)" ] || { echo "the item's worktree has uncommitted files"; exit 1; }
[ -z "$(git -C "$lead" status --porcelain)" ] || { echo "the lead's worktree has uncommitted files"; exit 1; }
git -C "$wt" merge-base --is-ancestor "$lead_branch" HEAD || { echo "merge $lead_branch into $branch, push, and let CI (or the gate) check it again first"; exit 1; }
grep -q "^Co-Authored-By: " "$msg" || { echo "the merge message has no Co-Authored-By line"; exit 1; }
head=$(git -C "$wt" rev-parse HEAD)

if [ $ci -eq 1 ]; then
  remote=$(git -C "$wt" ls-remote origin "refs/heads/$branch" | cut -f1)
  [ "$remote" = "$head" ] || { echo "GitHub has $branch at ${remote:-nothing}, the worktree at $head: push it, so CI checks the commit that merges"; exit 1; }
  "$here/ci-wait.sh" "$branch" "$head" || { echo "CI is not green on ${head:0:7}: nothing merged"; exit 1; }
  # Nothing may have moved while it waited.
  [ "$(git -C "$wt" rev-parse HEAD)" = "$head" ] || { echo "$branch moved here while CI ran: nothing merged"; exit 1; }
  [ "$(git -C "$wt" ls-remote origin "refs/heads/$branch" | cut -f1)" = "$head" ] || { echo "$branch moved on GitHub while CI ran: nothing merged"; exit 1; }
  git -C "$lead" merge-base --is-ancestor "$lead_branch" "$head" || { echo "$lead_branch moved while CI ran: merge it into $branch again"; exit 1; }
else
  git -C "$wt" push -q -u origin "$branch"
fi

# The commit itself, not the branch's name, so the merge is of the commit that was checked.
git -C "$lead" merge -q --no-ff "$head" -F "$msg"
[ -z "$(git -C "$lead" diff --stat HEAD "$head")" ] || { echo "the merged tree is not the checked tree"; exit 1; }
echo "merged $branch (${head:0:7}) into $lead_branch at $(git -C "$lead" rev-parse --short HEAD)"

git -C "$repo" worktree remove "$wt"
git -C "$repo" branch -q -D "$branch"
git -C "$repo" push -q origin --delete "$branch"
echo "removed the worktree and the branch $branch (local and remote); its commits are in the merge"
echo "next: mark the plan and the handoff, commit, then: git -C $lead push origin HEAD:pilot/week-1"
