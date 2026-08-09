#!/bin/sh
# Run the same changed-root-test gate locally and in CI.
#
# The full tests/*.test.ts population is too large for every commit, so this
# mirrors CI #3008: run only root test files added or modified by the branch.

set -u

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  echo "changed-root-tests: not inside a Git worktree." >&2
  exit 1
fi
cd "$repo_root" || exit 1

# #4002: "main" is upstream/main when `origin` is a FORK, else origin/main.
# In CI `origin` IS upstream, so this resolves to origin/main and behaviour is
# unchanged. In a fork checkout, diffing against the fork's stale main makes
# every commit upstream landed since the last sync look like this branch's own:
# measured 14 root test files selected instead of 1, each a cold vitest process,
# turning a ~20s gate into ~40min.
resolve_main_ref() {
  _origin="$(git remote get-url origin 2>/dev/null || true)"
  _upstream="$(git remote get-url upstream 2>/dev/null || true)"
  _norm() { printf '%s' "$1" | tr 'A-Z' 'a-z' | sed -e 's#^git@\([^:]*\):#https://\1/#' -e 's#^ssh://#https://#' -e 's#\.git$##' -e 's#/*$##'; }
  if [ -n "$_upstream" ] && [ "$(_norm "$_upstream")" != "$(_norm "$_origin")" ] &&
    git rev-parse --verify --quiet upstream/main >/dev/null 2>&1; then
    printf 'upstream/main'
  else
    printf 'origin/main'
  fi
}
base_ref="${CHANGED_ROOT_TESTS_BASE:-$(resolve_main_ref)}"
base="$(git merge-base "$base_ref" HEAD 2>/dev/null || true)"
if [ -z "$base" ]; then
  echo "changed-root-tests: cannot resolve a merge base with $base_ref." >&2
  echo "Fetch $base_ref or set CHANGED_ROOT_TESTS_BASE to a local base ref." >&2
  exit 1
fi

# Comparing the base to the working tree includes both the existing branch
# commits and the staged commit that pre-commit is about to create.
changed="$(
  git diff --name-only --diff-filter=AM "$base" -- tests/ |
    grep -E '^tests/[^/]+\.test\.ts$' |
    grep -vE '^tests/(linear-|c-abi\.|simd|test262-(chunk|vitest))' || true
)"

if [ -z "$changed" ]; then
  echo "changed-root-tests: no root test files changed."
  exit 0
fi

count="$(printf '%s\n' "$changed" | wc -l | tr -d ' ')"
if [ "$count" -gt 20 ]; then
  echo "changed-root-tests: $count root test files changed (>20); skipping the change-scoped gate."
  echo "The post-merge issue-tests detector covers mass edits."
  exit 0
fi

echo "changed-root-tests: running $count changed root test file(s):"
printf '%s\n' "$changed"

for test_file in $changed; do
  pnpm exec vitest run "$test_file" \
    --pool=forks \
    --poolOptions.forks.singleFork=true \
    --no-file-parallelism || exit 1
done
