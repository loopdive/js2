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
# (#6783) A mass edit used to skip this gate outright (`exit 0`), so a PR that
# touched 21 root test files ran none of them. Run the first $max instead, and
# name every file that is not run so the log shows exactly what was skipped.
max=20
to_run="$changed"
if [ "$count" -gt "$max" ]; then
  to_run="$(printf '%s\n' "$changed" | sed -n "1,${max}p")"
  echo "changed-root-tests: WARNING — $count root test files changed (>$max); running the first $max."
  echo "changed-root-tests: NOT RUN ($((count - max)) file(s) beyond the first $max):"
  printf '%s\n' "$changed" | sed -n "$((max + 1)),\$p" | sed 's/^/  /'
fi

echo "changed-root-tests: running $(printf '%s\n' "$to_run" | wc -l | tr -d ' ') changed root test file(s):"
printf '%s\n' "$to_run"

# (#3505 follow-up) vitest.config.ts pins each fork worker's old-space via an
# explicit execArgv (default 512MB — which also overrides any NODE_OPTIONS),
# and that OOMs on test files that link the standalone runtime-eval provider
# in-process (issue-3496: "Ineffective mark-compacts near heap limit" killed
# the quality gate twice). Raise it through the config's own env knob unless
# the caller already chose a value. 4GB fits both the 7GB CI runners and dev
# boxes; single-fork keeps only one worker alive.
VITEST_FORK_MAX_OLD_SPACE_SIZE="${VITEST_FORK_MAX_OLD_SPACE_SIZE:-4096}"
export VITEST_FORK_MAX_OLD_SPACE_SIZE

# --dangerouslyIgnoreUnhandledErrors: a test file whose tests hold the worker's
# event loop in long synchronous compiles (30-40s standalone compileMulti calls
# back-to-back) starves birpc's fixed 60s timer, so vitest reports a spurious
# "[vitest-worker]: Timeout calling onTaskUpdate" unhandled error and exits 1
# with every test green. Test FAILURES still gate — only the unhandled-error
# channel is ignored, and only in this change-scoped runner.
#
# Stops at the first failing file; every changed file after it — the rest of
# the first $max and anything beyond them — is listed as not run.
index=0
for test_file in $to_run; do
  index=$((index + 1))
  if [ "$test_file" = "tests/issue-6915-linear-owned-ascii-append-copy-kernel.test.ts" ]; then
    node scripts/hooks/run-linear-append-provenance.mjs
    test_status=$?
  else
    pnpm exec vitest run "$test_file" \
    --pool=forks \
    --poolOptions.forks.singleFork=true \
    --dangerouslyIgnoreUnhandledErrors \
    --no-file-parallelism
    test_status=$?
  fi
  if [ "$test_status" -ne 0 ]; then
    echo "changed-root-tests: FAILED: $test_file — stopping at the first failure."
    if [ "$index" -lt "$count" ]; then
      echo "changed-root-tests: NOT RUN ($((count - index)) changed root test file(s) not reached):"
      printf '%s\n' "$changed" | sed -n "$((index + 1)),\$p" | sed 's/^/  /'
    fi
    exit 1
  fi
done
