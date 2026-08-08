#!/bin/bash
# Pre-merge hook: enforce merge protocol
# Key insight: hooks run from /workspace, not from agent's cwd.
# We detect intent from the command string, not from git state.
# Exit 0 = allow, Exit 2 = block

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [ -z "$CMD" ]; then
  exit 0
fi

# Match only the FIRST LINE of the command. A commit message, heredoc or script
# body can quote a git command verbatim without being one — e.g. a `-m "$(cat
# <<EOF ... EOF)"` whose text mentions the merge flags. Scanning the whole
# command string treats that prose as an invocation: the branch extractor below
# then grabs a fragment of English as a ref name, and since the proof gate now
# fails CLOSED on an uncomputable diff, an ordinary commit gets blocked. Real
# invocations, including `cd <dir> && git merge …`, are single-line.
CMD_HEAD=$(printf '%s' "$CMD" | head -1)

if ! echo "$CMD_HEAD" | grep -q 'git merge'; then
  exit 0
fi

source "${CLAUDE_PROJECT_DIR:-/workspace}"/.claude/hooks/event-log.sh

# Detect: is this merging TO main (ff-only) or merging main INTO a branch?
if echo "$CMD_HEAD" | grep -q '\-\-ff-only'; then
  # LEGACY PATH. CLAUDE.md's merge protocol is PRs + CI, and direct merges to
  # main are never used by dev agents — so under the documented workflow this
  # branch should not be reached at all. It is kept as a BLOCKING guard (it
  # refuses without a fresh passing proof) rather than deleted, because
  # check-cwd.sh still allows `git merge --ff-only` in /workspace for the
  # authenticated tech lead, and removing the proof requirement from that path
  # would loosen a gate rather than tighten one. Do not read reaching this code
  # as licence to merge directly; if you are a dev agent here, you are on the
  # wrong path — open a PR instead.
  #
  # Merging TO main — require test proof (unless UI-only branch)
  BRANCH=$(echo "$CMD_HEAD" | sed 's/.*--ff-only[[:space:]]*//' | awk '{print $1}')
  # No ref after the flag — not an invocation this gate can reason about, and
  # blocking here would refuse commands that merely mention the flag.
  if [ -z "$BRANCH" ]; then
    exit 0
  fi

  # Skip proof for UI-only branches (no src/ changes).
  #
  # FAIL CLOSED if the diff cannot be computed. The old form piped git straight
  # into grep, so git's exit status was discarded (the same trap CLAUDE.md warns
  # about) and ANY failure — an unresolvable ref, a missing `main`, a git error —
  # produced empty output, which read as "no src/ changes" and skipped the proof
  # requirement entirely. That is the gate failing open exactly when it knows
  # least. Capture the status first, then filter.
  # The base is the LOCAL `main` ref ON PURPOSE — do not "fix" it to a remote.
  #
  # This gate runs on `git merge --ff-only <branch>` performed WHILE ON main, so
  # the merge fast-forwards local main to the branch and main gains every commit
  # in between. `git diff main...<branch>` therefore measures exactly what THIS
  # merge introduces, which is the question the proof requirement is asking.
  #
  # A stale local main is not a false positive: if main is behind, the merge
  # really does carry those extra commits in, so requiring a proof that covers
  # them is correct. Switching to `origin/main` would narrow the range to just
  # the branch's own commits and stop covering what the merge actually lands —
  # and in checkouts where `origin` is the fork (CLAUDE.md warns about this) it
  # would compare against the wrong history entirely.
  DIFF_OUT=$(git diff main..."$BRANCH" --name-only 2>/dev/null)
  DIFF_RC=$?
  if [ "$DIFF_RC" -ne 0 ]; then
    log_event "merge_blocked" "reason=diff_failed" "branch=$BRANCH" "rc=$DIFF_RC"
    echo "BLOCKED: cannot compute 'git diff main...$BRANCH' (exit $DIFF_RC), so it is not knowable whether this branch touches src/." >&2
    echo "Resolve the ref (or fetch main) and retry. A proof is required whenever this check cannot answer." >&2
    exit 2
  fi
  SRC_CHANGES=$(echo "$DIFF_OUT" | grep '^src/' | head -1)
  if [ -z "$SRC_CHANGES" ]; then
    log_event "merge_to_main_ui_only" "branch=$BRANCH"
    jq -n '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: "UI-only branch (no src/ changes) — proof skipped. POST-MERGE: move issue to done/, update dep graph."}}'
    exit 0
  fi

  # Check multiple locations for the proof file (in priority order)
  PROOF=""
  for candidate in \
    "/tmp/merge-proof.json" \
    "${CLAUDE_PROJECT_DIR:-/workspace}/.claude/worktrees/$BRANCH/.claude/nonces/merge-proof.json" \
    "${CLAUDE_PROJECT_DIR:-/workspace}/.claude/nonces/merge-proof.json"; do
    if [ -f "$candidate" ]; then
      PROOF="$candidate"
      break
    fi
  done
  if [ -z "$PROOF" ]; then
    log_event "merge_blocked" "reason=no_proof"
    cat >&2 <<'MSG'
BLOCKED: No test proof found. Before merging to main:

1. On your dev branch: git merge main
2. On your dev branch: run equiv tests
3. Create proof: see .claude/skills/test-and-merge/SKILL.md step 7

Tests must pass ON THE INTEGRATED BRANCH before merging to main.
MSG
    exit 2
  fi

  # Validate proof is recent (< 15 min)
  TS=$(jq -r '.timestamp // empty' "$PROOF" 2>/dev/null)
  if [ -n "$TS" ]; then
    TS_EPOCH=$(date -d "$TS" +%s 2>/dev/null || echo 0)
    NOW_EPOCH=$(date +%s)
    AGE=$(( NOW_EPOCH - TS_EPOCH ))
    if [ "$AGE" -gt 900 ]; then
      log_event "merge_blocked" "reason=proof_expired" "age=$AGE"
      echo "BLOCKED: Test proof is ${AGE}s old (max 900s). Re-run tests." >&2
      rm -f "$PROOF"
      exit 2
    fi
  fi

  EQUIV=$(jq -r '.equiv_passed // false' "$PROOF" 2>/dev/null)
  if [ "$EQUIV" != "true" ]; then
    log_event "merge_blocked" "reason=equiv_failed"
    echo "BLOCKED: Equivalence tests did not pass." >&2
    rm -f "$PROOF"
    exit 2
  fi

  BRANCH=$(jq -r '.branch // "unknown"' "$PROOF" 2>/dev/null)
  log_event "merge_to_main" "branch=$BRANCH"

  # Valid — consume proof
  rm -f "$PROOF"
  jq -n '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: "Test proof validated. POST-MERGE: verify no deletions, move issue to done/, update dep graph."}}'
  exit 0
fi

# No --ff-only = merging main into a branch (always allowed)
# This includes: "git merge main", "cd <worktree> && git merge main", etc.
#
# The advisory below used to end "...then ff-only to main". That was left over
# from the pre-PR era and directly contradicted CLAUDE.md's merge protocol
# ("Never use `git merge` on main directly. All merges go through PRs + CI").
# On 2026-08-07 it fired on every merge across three agents and the lead; all
# correctly refused, and two escalated it independently. An instruction to
# bypass CI that arrives with system authority only has to be believed once.
log_event "merge_into_branch"
jq -n '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: "Merging main into your branch. After merge: push the branch and open a PR against main — all merges go through PRs + CI (docs/ci-policy.md). Do NOT merge to main directly, and do NOT enqueue: the server-side auto-enqueue.yml workflow is the single enqueuer."}}'
exit 0
