#!/usr/bin/env bash
# test262-paths-match.sh — decide whether a set of changed paths touches any
# test262-relevant path.
#
# Reads NUL- or newline-separated changed paths on stdin (one per line).
# Prints "true" to stdout if ANY changed path matches the test262-relevant
# path set, "false" otherwise. Always exits 0 (the caller reads stdout).
#
# This is the single source of truth for "does this change affect test262
# conformance?". It MUST stay in sync with the `&test262-paths` allowlist in
# .github/workflows/test262-sharded.yml (the pull_request/push paths filter).
# If you add a path there, add the matching pattern here.
#
# Used by the `changes` job in test262-sharded.yml to gate the merge_group
# shard matrix: GitHub's merge_group event has no native `paths:` filter, so
# we diff base_sha..head_sha ourselves and pipe the file list through here.
#
# Fail-safe: this script only decides false vs true on the path patterns. The
# CALLER is responsible for the conservative default (emit "true" when the
# diff itself failed or base_sha is empty). This script, given an EMPTY input
# (no changed paths detected), prints "false" — so the caller must guarantee
# it only reaches here with a real, non-empty, trustworthy diff.

set -euo pipefail

# Glob patterns (bash extglob / `case`) mirroring &test262-paths. `**` is
# emulated by matching the prefix; `case` globbing is non-recursive so we
# match `src/*` as "anything under src/" via the `src/*` pattern (a path like
# `src/a/b.ts` matches `src/*` in bash `case` because `*` spans slashes).
matches_test262_path() {
  local p="$1"
  case "$p" in
    .github/workflows/test262-sharded.yml) return 0 ;;
    package.json) return 0 ;;
    pnpm-lock.yaml) return 0 ;;
    tsconfig.json) return 0 ;;
    scripts/tsconfig.json) return 0 ;;
    vitest.config.ts) return 0 ;;
    src/*) return 0 ;;
    scripts/build-test262-report.mjs) return 0 ;;
    scripts/compiler-fork-worker.mjs) return 0 ;;
    scripts/compiler-pool.ts) return 0 ;;
    scripts/diff-test262.ts) return 0 ;;
    scripts/generate-editions.ts) return 0 ;;
    scripts/test262-worker.mjs) return 0 ;;
    tests/test262-chunk*.test.ts) return 0 ;;
    tests/test262-runner.ts) return 0 ;;
    tests/test262-scope-classification.test.ts) return 0 ;;
    tests/test262-shared.ts) return 0 ;;
    # Weight maps change shard assignment — full validation on refresh (#1953).
    tests/test262-slow-tests*.json) return 0 ;;
    # The path matcher itself affects gating logic — treat as relevant so a
    # change to the matcher always re-runs the full suite (fail-safe).
    scripts/test262-paths-match.sh) return 0 ;;
    *) return 1 ;;
  esac
}

result="false"
while IFS= read -r line || [ -n "$line" ]; do
  # Tolerate trailing CR and skip blank lines.
  line="${line%$'\r'}"
  [ -z "$line" ] && continue
  if matches_test262_path "$line"; then
    result="true"
    break
  fi
done

printf '%s\n' "$result"
