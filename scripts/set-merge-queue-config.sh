#!/usr/bin/env bash
#
# set-merge-queue-config.sh — read and apply the canonical MERGE QUEUE
# parameters of the `main` ruleset (#3914 Step 1).
#
# WHY THIS EXISTS
#   The merge-queue settings are the one part of this repo's CI policy that
#   lived nowhere in the repo. `scripts/enable-branch-protection.sh` manages
#   the required-check list and deliberately *preserves* the merge-queue
#   parameters it finds live; nothing wrote them, and nothing could read them
#   either. #3914 hit exactly that wall: it could not determine from the repo
#   whether group formation was capped at 1 by `max_entries_to_merge` or by
#   `min_entries_to_merge`, and `docs/ci-policy.md`'s record of the live values
#   was stale by six weeks (it still said `max_entries_to_build: 5` long after
#   the 2026-06-20 wedge reverted it to 1).
#
#   So this script does two things: `--show` makes the live config READABLE
#   without a trip to the Settings UI, and the apply path makes the config a
#   reviewed, versioned artifact instead of a click.
#
# Usage:
#   ./scripts/set-merge-queue-config.sh --show     # print live params, exit
#   ./scripts/set-merge-queue-config.sh --check    # dry-run: live vs desired
#   ./scripts/set-merge-queue-config.sh            # apply
#
# Requirements:
#   - `gh` CLI authenticated with repo-admin rights (Administration:write), or
#     `GH_TOKEN` set to a fine-grained PAT with the same.
#   - `jq`.
#
# Idempotent: re-running re-applies the same state. The ruleset PUT is
# replace-style, so this reads the live ruleset and rewrites ONLY the
# `merge_queue` rule's parameters — required checks, conditions, enforcement
# and bypass actors are carried through untouched. It is therefore safe to
# interleave with `enable-branch-protection.sh`, which does the mirror image.
#
set -euo pipefail

REPO_OWNER="${REPO_OWNER:-loopdive}"
REPO_NAME="${REPO_NAME:-js2wasm}"
RULESET_ID="${RULESET_ID:-16700772}"

# -----------------------------------------------------------------------------
# CANONICAL VALUES — keep in sync with `docs/ci-policy.md` §3 and #3914.
# -----------------------------------------------------------------------------
#
# MAX_ENTRIES_TO_MERGE — the merge-grouping cap: how many consecutive GREEN
#   queue entries GitHub may fast-forward into `main` in one operation.
#
#   ⚠ #3914's original premise for this knob — "one group, one run, N PRs" —
#   is NOT what GitHub's product does. Merge limits do NOT combine
#   `merge_group` builds: every queued PR always gets its own temporary
#   branch and its own full CI run, and min/max_entries_to_merge only group
#   the final fast-forward of entries that have EACH already passed their own
#   run (GitHub community discussion #58523; measured here 2026-08-15, see
#   "Step 1+2 result" in the issue file). Native GitHub merge queue has no
#   fewer-runs-than-PRs mode. The cap is therefore harmless but buys no CI
#   throughput; 5 is kept because a bigger mergeable prefix is free on the
#   rare occasion it can form.
MAX_ENTRIES_TO_MERGE="${MAX_ENTRIES_TO_MERGE:-5}"
#
# MIN_ENTRIES_TO_MERGE — the quorum FLOOR. Back to 1: #3914 Step 2 was tried
#   (floor 2, 5-min timer, live 2026-08-14T18:16Z) and MEASURED A NO-OP on
#   2026-08-15: 29/29 successful merge groups still carried exactly one PR,
#   including a window where entries for three PRs (#4557/#4558/#4559) sat
#   stacked in the queue simultaneously and still consumed three full runs,
#   merging one at a time ~15 min apart. Two reasons, both structural:
#   1. The wait timer counts from queue entry, and GitHub "merges with fewer
#      than the minimum" once it expires. Under load the head's queue wait
#      (>= one ~15-min run) always exceeds any sane timer, so the floor is
#      permanently waived by the time a merge decision is made.
#   2. Even if it bound, merging >=2 entries together needs >=2 entries green
#      at once, which max_entries_to_build=1 makes impossible — the next
#      entry's run is only dispatched after the head merges (observed: +2 s).
#   So a floor > 1 can never batch on this queue; its only observable effect
#   is up to timer-minutes of added latency on quiet-queue fast merges
#   (docs-only runs go green in ~2-3 min, inside the timer). Keep 1.
#   This default MUST track the live ruleset. Apply is this script's DEFAULT
#   mode, so a stale value here silently rewrites the floor on the next bare run.
MIN_ENTRIES_TO_MERGE="${MIN_ENTRIES_TO_MERGE:-1}"
#
# MAX_ENTRIES_TO_BUILD — SPECULATION DEPTH. Stays 1. This is NOT the batching
#   knob and raising it is the thing that must not happen a third time.
#
#   Speculation builds N *separate* groups (main+A, main+A+B, …), each with its
#   own full run: 5 × ~102 shard jobs against a ~120-runner pool. Its entire
#   theoretical win is amortising the ~170 s fixed per-run overhead out of a
#   ~800 s run — a ceiling of ~1.25× — and it pays for that by having discarded
#   descendant groups compete with the one group that can actually merge.
#
#   It is also the ONLY setting here that causes queue EJECTION CASCADES: any
#   change to queue membership invalidates every descendant speculative group
#   and cancels their in-flight runs. At depth 1 there are no descendants, so a
#   trailing append can never eject or cancel anything.
#
#   Guarded below: a value > 1 is refused unless --allow-speculative-build is
#   passed AND the shard matrix has been shrunk first (see #3914 Part 1 and
#   scripts/gen-test262-mg-matrix.mjs).
MAX_ENTRIES_TO_BUILD="${MAX_ENTRIES_TO_BUILD:-1}"

# Parameters we do NOT own here — preserved from the live ruleset when present
# (merge_method, grouping_strategy, check_response_timeout_minutes,
# min_entries_to_merge_wait_minutes). Override via env if you must.

MODE=apply
ALLOW_SPECULATIVE_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --show) MODE=show ;;
    --check|--dry-run) MODE=check ;;
    --allow-speculative-build) ALLOW_SPECULATIVE_BUILD=1 ;;
    -h|--help)
      sed -n '2,33p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

API_PATH="/repos/${REPO_OWNER}/${REPO_NAME}/rulesets/${RULESET_ID}"

# -----------------------------------------------------------------------------
# Guard: never let this script be the thing that re-enables speculation.
# -----------------------------------------------------------------------------
if [ "${MAX_ENTRIES_TO_BUILD}" -gt 1 ] && [ "$ALLOW_SPECULATIVE_BUILD" -eq 0 ]; then
  cat >&2 <<'MSG'
REFUSED: max_entries_to_build > 1 re-enables SPECULATIVE queue batching.

That is not the batching that helps this repo, and it has already been tried
and reverted once (enabled by #1956, reverted during the 2026-06-20 wedge,
#2519/#2522). Its arithmetic ceiling is ~1.25x; the live cost is 5 x ~102
shard jobs on a ~120-runner pool, which starves the one group that can merge
in order to precompute results that are usually discarded. It is also the only
setting that makes queue changes EJECT other PRs' in-flight runs.

Note there is NO ruleset setting that batches N PRs into one CI run:
MAX_ENTRIES_TO_MERGE / MIN_ENTRIES_TO_MERGE only group the final fast-forward
of entries that each already passed their own run (measured 2026-08-15; GitHub
community discussion #58523). Every queued PR always costs one full run.

Full post-mortem + arithmetic: plan/issues/3914-ci-throughput-merge-queue-batching.md
Prerequisite if you really mean it: shrink the merge_group shard matrix first
(scripts/gen-test262-mg-matrix.mjs assigns 102 of 120 runners to ONE group).

Override: --allow-speculative-build
MSG
  exit 2
fi

if [ "${MIN_ENTRIES_TO_MERGE}" -gt "${MAX_ENTRIES_TO_MERGE}" ]; then
  echo "REFUSED: min_entries_to_merge (${MIN_ENTRIES_TO_MERGE}) > max_entries_to_merge (${MAX_ENTRIES_TO_MERGE})." >&2
  exit 2
fi

# -----------------------------------------------------------------------------
# Read live ruleset.
# -----------------------------------------------------------------------------
CURRENT="$(gh api "${API_PATH}")"

if ! jq -e '.rules[]? | select(.type == "merge_queue")' >/dev/null <<<"${CURRENT}"; then
  echo "Ruleset ${RULESET_ID} has no merge_queue rule; refusing to add one blindly." >&2
  echo "The merge queue must be enabled on the branch first (Settings -> Rules)." >&2
  exit 1
fi

live_params() { jq '.rules[] | select(.type == "merge_queue") | .parameters' <<<"${CURRENT}"; }

echo "Merge-queue ruleset target:"
echo "  repo:    ${REPO_OWNER}/${REPO_NAME}"
echo "  ruleset: ${RULESET_ID}"
echo "  API:     ${API_PATH}"
echo ""
echo "LIVE merge_queue parameters:"
live_params | jq -S .
echo ""

if [ "$MODE" = "show" ]; then
  exit 0
fi

# -----------------------------------------------------------------------------
# Build the payload: rewrite ONLY merge_queue parameters we own.
# -----------------------------------------------------------------------------
build_payload() {
  jq \
    --argjson maxMerge "${MAX_ENTRIES_TO_MERGE}" \
    --argjson minMerge "${MIN_ENTRIES_TO_MERGE}" \
    --argjson maxBuild "${MAX_ENTRIES_TO_BUILD}" \
    '
      .rules |= map(
        if .type == "merge_queue" then
          .parameters.max_entries_to_merge = $maxMerge
          | .parameters.min_entries_to_merge = $minMerge
          | .parameters.max_entries_to_build = $maxBuild
        else
          .
        end
      )
      | {name, target, enforcement, conditions, rules, bypass_actors}
    ' <<<"${CURRENT}"
}

PAYLOAD="$(build_payload)"

echo "DESIRED merge_queue parameters:"
jq -S '.rules[] | select(.type == "merge_queue") | .parameters' <<<"${PAYLOAD}"
echo ""

if diff -q <(live_params | jq -S .) \
          <(jq -S '.rules[] | select(.type == "merge_queue") | .parameters' <<<"${PAYLOAD}") >/dev/null; then
  echo "No change — live config already matches canonical values."
  exit 0
fi

echo "Diff (live -> desired):"
diff -u <(live_params | jq -S .) \
        <(jq -S '.rules[] | select(.type == "merge_queue") | .parameters' <<<"${PAYLOAD}") || true
echo ""

if [ "$MODE" = "check" ]; then
  echo "--- DRY RUN (--check given) — no changes applied. ---"
  exit 0
fi

echo "Applying via gh api..."
echo "${PAYLOAD}" | gh api -X PUT "${API_PATH}" \
  -H "Accept: application/vnd.github+json" \
  --input - >/dev/null

echo ""
echo "Applied. Verify with:"
echo "  ./scripts/set-merge-queue-config.sh --show"
echo ""
echo "Then watch one backed-up window and count PRs per group (#3914):"
echo "  a group's members are the 'Merge pull request #N' commits in base..head"
echo "  of its gh-readonly-queue/main/pr-<N>-<baseSha> ref."
