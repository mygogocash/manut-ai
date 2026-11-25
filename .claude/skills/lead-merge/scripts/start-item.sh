#!/bin/bash
# Makes a helper's worktree and branch for one item, from the newest working branch on the remote, with dependencies in.
# Usage: start-item.sh <item number> <short name> <branch>      for example: start-item.sh 71 lane-diff feat/lane-diff
# Prints the worktree's path. The clone that holds the worktrees is ~/Developer/manut-ai; they live beside T3 Code's own.
set -eu
item=${1:?usage: start-item.sh <item number> <short name> <branch>}
name=${2:?short name}
branch=${3:?branch}
repo="$HOME/Developer/manut-ai"
wt="$HOME/.t3/worktrees/manut-ai/cc-item$item-$name"
cd "$repo"
git fetch -q origin
git worktree add -q "$wt" -b "$branch" origin/pilot/week-1
( cd "$wt" && pnpm install --frozen-lockfile --prefer-offline > /dev/null 2>&1 )
echo "$wt"
