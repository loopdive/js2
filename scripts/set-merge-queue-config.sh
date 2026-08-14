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
REPO_NAME="${REPO_NAME:-js2}"
RULESET_ID="${RULESET_ID:-16700772}"

# -----------------------------------------------------------------------------
# CANONICAL VALUES — keep in sync with `docs/ci-policy.md` §3 and #3914.
# -----------------------------------------------------------------------------
#
# MAX_ENTRIES_TO_MERGE — the BATCH CAP: how many queued PRs a single merge
#   group may swallow, validated by ONE shard-matrix run. This is the knob that
#   actually buys throughput here. Because the queue is serial, PRs pile up
#   while a group is in flight *for free*, so batching them costs those PRs no
#   latency — they were waiting for that run either way.
#
#   5 is the project-lead's chosen cap. #3914's expected-runtime-per-merged-PR
#   model puts the optimum at 4–5 for the observed merge_group failure rate
#   (e ≈ 0.05–0.10): at e=0.05 N=5 is the best value in the table (0.426W vs
#   0.435W for N=4); at e=0.10 N=4 edges it (0.594W vs 0.610W). The two are
#   within noise of each other and both are ~1.85× better than serial. What
#   matters is that the curve is a BOWL that turns back up — by N=12 you are
#   back near the N=2 result — so this is a cap to hold, not a floor to raise.
MAX_ENTRIES_TO_MERGE="${MAX_ENTRIES_TO_MERGE:-5}"
#
# MIN_ENTRIES_TO_MERGE — the quorum FLOOR. Stays 1, deliberately. A floor > 1
#   makes a group wait for peers, so a genuinely solo PR pays the wait timer as
#   pure added latency (~1/3 of dispatches on the measured day had no peer
#   waiting). Raising the cap is free; raising the floor is not. #3914 Step 2
#   raises this to 2 with a 2-minute timer ONLY if Step 1 leaves groups at
#   size 1 — i.e. only if GitHub's formation turns out to be
#   eager-with-minimum rather than min(available, cap).
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

Want more PRs per run? Raise MAX_ENTRIES_TO_MERGE (the batch cap) instead —
one group, one run, N PRs, no extra runner pressure.

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
