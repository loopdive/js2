#!/bin/bash
# Block `git commit --no-verify`. Exit 0 = allow, exit 2 = block.
#
# WHY THIS EXISTS
# ---------------
# `.husky/pre-commit` says it in its own comments: "Never use `--no-verify`; use
# this" — pointing at SKIP_SLOW_PRECOMMIT=1. The husky hook deliberately splits
# into an UNCONDITIONAL fast lane (prettier/biome via lint-staged, plus the LOC
# and function budget ratchets, ~4.5s total) and a slow lane that can exceed an
# agent's tool timeout. `--no-verify` skips BOTH lanes; SKIP_SLOW_PRECOMMIT=1
# skips only the slow one, and CI runs everything regardless.
#
# The failure this prevents is not hypothetical. On 2026-08-12 an agent used
# `git commit --no-verify` for an entire session; every commit silently bypassed
# the func-budget ratchet, and a +119-line function growth surfaced only when
# the habit was dropped. PR #4252 burned two CI cycles the same way. The whole
# point of the ratchets is that seconds at commit time beat minutes at CI time,
# and `--no-verify` converts one into the other.
#
# NOT BLOCKED: `git push --no-verify`. That one is sanctioned by CLAUDE.md — the
# pre-push integrity gate chokes on the fork/upstream divergence, and CI runs the
# real gate. This hook is about commits only.
#
# Escape hatch and the full rationale: plan/method/no-verify-protocol.md

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$CMD" ] && exit 0

# FIRST LINE ONLY. A commit message body routinely quotes `--no-verify` — this
# very repo's history does, in commits explaining the ban. Scanning the whole
# command string treats that prose as an invocation and blocks honest commits.
# (Same trap fixed in pre-merge.sh on 2026-08-12; do not "simplify" this away.)
CMD_HEAD=$(printf '%s' "$CMD" | head -1)

# Split into shell segments so `git commit -m x && git push --no-verify` is not
# read as a no-verify COMMIT. The flag must sit in the same segment as the
# commit for this to fire.
OFFENDING=""
while IFS= read -r seg; do
  echo "$seg" | grep -qE '(^|[[:space:]])git[[:space:]]+commit([[:space:]]|$)' || continue
  echo "$seg" | grep -q -- '--no-verify' || continue
  OFFENDING="$seg"
  break
done <<EOF
$(printf '%s' "$CMD_HEAD" | sed 's/&&/\n/g; s/;/\n/g; s/||/\n/g')
EOF

[ -z "$OFFENDING" ] && exit 0

# Documented override — see the protocol file. Accepted either as an inherited
# environment variable or inline on the command itself.
if [ -n "$JS2WASM_ALLOW_NO_VERIFY" ] || echo "$CMD_HEAD" | grep -q 'JS2WASM_ALLOW_NO_VERIFY='; then
  if [ -f "${CLAUDE_PROJECT_DIR:-/workspace}/.claude/hooks/event-log.sh" ]; then
    # shellcheck source=/dev/null
    . "${CLAUDE_PROJECT_DIR:-/workspace}/.claude/hooks/event-log.sh"
    log_event "no_verify_override_used" 2>/dev/null || true
  fi
  exit 0
fi

cat >&2 <<'MSG'
BLOCKED: `git commit --no-verify` skips gates this project makes unconditional.

`.husky/pre-commit` runs two lanes. The FAST lane — lint-staged (prettier/biome)
plus `check:loc-budget` and `check:func-budget` — takes ~4.5s and is meant to
run on every commit. `--no-verify` skips it along with everything else.

USE THIS INSTEAD:

    SKIP_SLOW_PRECOMMIT=1 git commit -m "..."

That keeps the format and budget gates and skips only the slow chain
(`test:changed-root`, `check:oracle-ratchet`), which can exceed an agent tool
timeout. CI runs all of them regardless.

If the fast gate itself fails, FIX IT rather than bypassing:
  - `check:func-budget` failing  -> split the function, or grant an allowance
    under `func-budget-allow:` in the frontmatter of THIS change's issue file.
  - `check:loc-budget` failing   -> same, via `loc-budget-allow:`.
  - prettier/biome failing       -> `npx prettier --write <files>`.

`git push --no-verify` is NOT blocked — that one is sanctioned (the pre-push
integrity gate chokes on fork/upstream divergence; CI runs the real gate).

Genuine emergency override, and why it is a last resort:
    JS2WASM_ALLOW_NO_VERIFY=1 git commit --no-verify -m "..."

Full protocol, including when the override is legitimate:
    plan/method/no-verify-protocol.md
MSG
exit 2
