#!/usr/bin/env bash
# test262-paths-match.sh — decide whether a set of changed paths touches any
# test262-relevant path, optionally for ONE test262 target lane.
#
# Reads NUL- or newline-separated changed paths on stdin (one per line).
# Prints "true" to stdout if ANY changed path matches the test262-relevant
# path set, "false" otherwise. Always exits 0 (the caller reads stdout).
#
#   test262-paths-match.sh                       # any lane (default, unchanged)
#   test262-paths-match.sh --target host         # the JS-host (gc) lane only
#   test262-paths-match.sh --target standalone   # the standalone lane only
#
# This is the single source of truth for "does this change affect test262
# conformance?". It MUST stay in sync with the `&test262-paths` allowlist in
# .github/workflows/test262-sharded.yml (the pull_request/push paths filter).
# If you add a path there, add the matching pattern here.
#
# Used by the `changes` job in test262-sharded.yml to gate the merge_group
# shard matrix: GitHub's merge_group event has no native `paths:` filter, so
# we diff base_sha..head_sha ourselves and pipe the file list through here.
# The `--target` mode additionally lets that job drop ONE lane from the matrix
# when the queued change provably cannot move that lane's results — e.g. a
# refresh of tests/test262-slow-tests-standalone.json re-shards standalone and
# leaves js-host byte-identical, so the 66 js-host shards are pure waste.
#
# ── Per-target classification ────────────────────────────────────────
# Every relevant path is classified `both`, `host`, or `standalone`. The
# DEFAULT IS `both`: a path is only ever narrowed to one lane when the runner
# provably does not read it on the other lane. This is deliberate — the
# fail-safe direction is running a lane we did not need (costs CI time), never
# skipping a lane we did need (lets a real regression through).
#
# In particular ALL of `src/**` is `both`. The standalone regime is a flag
# threaded through the SAME compiler (`compile(src, { target: "standalone" })`
# — see src/index.ts CompileOptions.target), not a separate source tree, so
# there is no sound src-level split. The audited lane-exclusive paths are the
# per-target shard-weight maps and the standalone-only QuickJS provider/build
# inputs; see `classify_test262_path` below for the full table.
#
# Fail-safe: this script only decides false vs true on the path patterns. The
# CALLER is responsible for the conservative default (emit "true" when the
# diff itself failed or base_sha is empty). This script, given an EMPTY input
# (no changed paths detected), prints "false" — so the caller must guarantee
# it only reaches here with a real, non-empty, trustworthy diff.

set -euo pipefail

target="any"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      target="${2:-}"
      shift 2
      ;;
    --target=*)
      target="${1#--target=}"
      shift
      ;;
    *)
      echo "usage: $0 [--target host|standalone|any]" >&2
      exit 2
      ;;
  esac
done

case "$target" in
  any | host | standalone) ;;
  *)
    echo "$0: unknown --target '$target' (expected host, standalone, or any)" >&2
    exit 2
    ;;
esac

# Classify one changed path. Echoes the LANE SCOPE it affects:
#   both       — relevant to the js-host AND standalone lanes
#   host       — relevant to the js-host (gc) lane only
#   standalone — relevant to the standalone lane only
#   (empty)    — not test262-relevant at all
#
# Glob patterns (bash `case`) mirror &test262-paths. `**` is emulated by
# matching the prefix; `case` globbing is non-recursive so we match `src/*` as
# "anything under src/" (a path like `src/a/b.ts` matches `src/*` in bash
# `case` because `*` spans slashes).
classify_test262_path() {
  local p="$1"
  case "$p" in
    # ── Lane-EXCLUSIVE paths ─────────────────────────────────────────
    # The shard-weight maps feed assignBalancedChunk (tests/test262-shared.ts
    # slowTestPathCandidates): the standalone lane reads
    # test262-slow-tests-standalone.json and the js-host lane reads
    # test262-slow-tests.json. A refresh of one cannot change the other lane's
    # shard assignment, let alone its results, so #1953's "validate a weight
    # refresh with the full matrix" is satisfied by running only that lane.
    #
    # Ordering note: the standalone pattern MUST precede the host one — the
    # host map is also the standalone lane's FALLBACK candidate, but only when
    # the standalone map is absent/unparseable, which is itself a change to the
    # standalone map and therefore already in the diff.
    tests/test262-slow-tests-standalone.json) echo standalone ;;
    tests/test262-slow-tests.json) echo host ;;

    # ── Shared paths (`both`) ────────────────────────────────────────
    .github/actions/setup-node-pnpm/action.yml) echo both ;;
    .github/workflows/test262-sharded.yml) echo both ;;
    package.json) echo both ;;
    pnpm-lock.yaml) echo both ;;
    tsconfig.json) echo both ;;
    scripts/tsconfig.json) echo both ;;
    vitest.config.ts) echo both ;;
    # The whole compiler. `target: "standalone"` is a flag through this same
    # code, so every src change is assumed to affect BOTH lanes. Do not split.
    src/*) echo both ;;
    scripts/build-test262-report.mjs) echo both ;;
    scripts/compiler-fork-worker.mjs) echo both ;;
    scripts/compiler-pool.ts) echo both ;;
    scripts/diff-test262.ts) echo both ;;
    # QuickJS is a standalone-only eval engine. These files are never loaded by
    # the JS-host runner, but they are part of the sharded workflow allowlist so
    # a merge-group change cannot be misclassified as test262-irrelevant.
    scripts/build-quickjs-eval-provider.mjs) echo standalone ;;
    scripts/quickjs-eval-provider.mjs) echo standalone ;;
    scripts/runtime-eval-provider.mjs) echo standalone ;;
    scripts/quickjs-artifact/*) echo standalone ;;
    scripts/generate-editions.ts) echo both ;;
    scripts/test262-worker.mjs) echo both ;;
    tests/test262-chunk*.test.ts) echo both ;;
    tests/test262-runner.ts) echo both ;;
    tests/test262-scope-classification.test.ts) echo both ;;
    tests/test262-shared.ts) echo both ;;
    # Any FUTURE weight-map variant we have not classified above stays `both`
    # (#1953) rather than silently falling through to "irrelevant".
    tests/test262-slow-tests*.json) echo both ;;
    # The path matcher itself affects gating logic — treat as relevant to both
    # lanes so a change to the matcher always re-runs the full suite
    # (fail-safe: a matcher edit must be validated by what it might skip).
    scripts/test262-paths-match.sh) echo both ;;
    # Same reasoning: this filter decides which version-only manifest changes
    # are removed from the diff BEFORE this matcher ever sees them, so it is
    # part of the same gating decision.
    scripts/manifest-version-only.mjs) echo both ;;
    *) echo "" ;;
  esac
}

# Does `scope` count as relevant for the requested `target`?
scope_matches_target() {
  local scope="$1"
  [ -z "$scope" ] && return 1
  [ "$target" = "any" ] && return 0
  [ "$scope" = "both" ] && return 0
  [ "$scope" = "$target" ] && return 0
  return 1
}

result="false"
while IFS= read -r line || [ -n "$line" ]; do
  # Tolerate trailing CR and skip blank lines.
  line="${line%$'\r'}"
  [ -z "$line" ] && continue
  if scope_matches_target "$(classify_test262_path "$line")"; then
    result="true"
    break
  fi
done

printf '%s\n' "$result"
