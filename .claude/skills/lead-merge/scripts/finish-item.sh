#!/bin/bash
# Merges a gated item branch into the lead's worktree and clears the item's worktree and branches away.
# Usage: finish-item.sh <item worktree> <merge message file>
#
# Run it only after gate.sh passed on the item's worktree WITH the lead's branch merged into it: this script checks that
# the lead's branch is already in the item's branch, so the merged tree is exactly the tree the gate ran on, and refuses
# otherwise. It does not push the lead's branch: mark the plan and the handoff first, then push both commits together
# (git push origin HEAD:pilot/week-1 from the lead's worktree), so CI runs once.
#
# It never merges to main, never forces, and removes only this item's own worktree and branch, which the merge now holds.
set -eu
wt=${1:?usage: finish-item.sh <item worktree> <merge message file>}
msg=${2:?merge message file}
lead="$HOME/.t3/worktrees/manut-ai/t3-0c461873-e8dd6bc2489b4766"
repo="$HOME/Developer/manut-ai"
branch=$(git -C "$wt" branch --show-current)
lead_branch=$(git -C "$lead" branch --show-current)

[ -z "$(git -C "$wt" status --porcelain)" ] || { echo "the item's worktree has uncommitted files"; exit 1; }
[ -z "$(git -C "$lead" status --porcelain)" ] || { echo "the lead's worktree has uncommitted files"; exit 1; }
git -C "$wt" merge-base --is-ancestor "$lead_branch" HEAD || { echo "merge $lead_branch into $branch and run the gate again first"; exit 1; }
grep -q "^Co-Authored-By: " "$msg" || { echo "the merge message has no Co-Authored-By line"; exit 1; }

git -C "$wt" push -q -u origin "$branch"
git -C "$lead" merge -q --no-ff "$branch" -F "$msg"
[ -z "$(git -C "$lead" diff --stat HEAD "$branch")" ] || { echo "the merged tree is not the gated tree"; exit 1; }
echo "merged $branch into $lead_branch at $(git -C "$lead" rev-parse --short HEAD)"

git -C "$repo" worktree remove "$wt"
git -C "$repo" branch -q -D "$branch"
git -C "$repo" push -q origin --delete "$branch"
echo "removed the worktree and the branch $branch (local and remote); its commits are in the merge"
echo "next: mark the plan and the handoff, commit, then: git -C $lead push origin HEAD:pilot/week-1"
