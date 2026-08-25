---
id: 4545
title: "The stop-hook's Unverified check is unsound: it flags correctly-signed commits, and its prescribed remedy is rejected by our own commit-author hook (and rewrites history)"
status: ready
sprint: Backlog
created: 2026-08-17
updated: 2026-08-17
priority: medium
horizon: s
feasibility: medium
task_type: infrastructure
area: tooling
goal: ci-hardening
related: [4538]
# id 4545 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 (gh CLI offline in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: ZERO open PRs, so the
# id space was clear.
#
# 2026-08-17 REWRITTEN. The first draft diagnosed this as "signing is
# configured but unprovisioned, so commits are unsigned", based on
# `git log --format=%G?` returning N. That was WRONG, and wrong in exactly the
# way `.claude/memory/reference_commit_signing_in_this_container.md` already
# warns: %G? = N is a LOCAL-verification artifact of an unset
# gpg.ssh.allowedSignersFile, not an unsigned commit. Verified by effect —
# `git cat-file commit <sha> | grep -c 'BEGIN SSH SIGNATURE'` returns 1 for
# every commit on this branch. The diagnosis below is the corrected one.
---

# #4545 — The Unverified check flags signed commits, and its fix is forbidden here

## What is actually true (verified by effect, 2026-08-17)

- Every agent commit on `claude/linear-memory-quickjs-backend-gkhszu` **is
  SSH-signed**: `git cat-file commit <sha> | grep -c 'BEGIN SSH SIGNATURE'`
  returns `1` for all four.
- `git log --format=%G?` reports `N` for those same commits, because
  `gpg.ssh.allowedSignersFile` is unset, so git cannot verify locally. **`%G?`
  answers "can I verify this?", not "is this signed?"** — the distinction this
  issue exists to stop people re-learning.
- GitHub attributes author and committer to the real account (`ttraenkler`).
- The container's default git identity is nonetheless
  `Claude <noreply@anthropic.com>`, so every commit needs explicit
  `-c user.name` / `-c user.email` overrides to satisfy the repo's author rule.

## The actual defects

**1. The stop-hook's check cannot distinguish "signed by a non-Anthropic
identity" from "unsigned".** Its message — *"missing signature, or committer
email is not noreply@anthropic.com"* — collapses two independent conditions
into one verdict, so a correctly-signed commit authored by the human user (i.e.
exactly what this repo's convention mandates) is reported as a problem on every
turn. A detector that reports the same thing whether or not it can see the
signature is unsound; cf. the "A DETECTOR MUST BE ABLE TO SAY I DON'T KNOW"
rule in `.claude/memory/MEMORY.md`.

**2. Its prescribed remedy is rejected by our own gate.** The hook instructs:

```
git config user.email noreply@anthropic.com && git config user.name Claude
git commit --amend --no-edit --reset-author
```

`.husky/commit-msg` rejects exactly that author (project-lead order
2026-08-09, `feedback_commit_author_is_user_not_agent_role`), and a `PreToolUse`
hook now blocks it earlier. Verified in session:

```
commit-msg: BLOCKED — commit author is 'Claude <noreply@anthropic.com>'.
  The author must be the human user; Claude belongs ONLY in a
  'Co-Authored-By:' trailer (project convention, CLAUDE.md).
```

So an agent that follows the instruction loses a commit cycle; one that does
not gets nagged every turn. Both happened repeatedly in one session.

**3. The multi-commit form of the remedy rewrites history.** It prescribes

```
git rebase --exec "git commit --amend --no-edit --reset-author" <sha>^
```

On a branch that is already pushed — as this one is, under PR #4640 — that is a
history rewrite, which this project forbids (`main` is append-only, and
force-pushing a PR branch under review is its own hazard). The instruction is
not merely useless here; it is actively dangerous later in a branch's life.

## What still needs establishing

Whether GitHub renders these commits **Verified** depends on the signing public
key being registered as a *signing* key on the account. That was not readable
from inside the container (the commit API response surfaced no `verification`
field via the MCP tool). Check PR #4640's commit list; if they show Verified,
defect 1 is the whole story and nothing about signing needs changing.

## Options

1. **Fix the stop-hook check** — report the two conditions separately, and
   treat "signed, author is the repo's required identity" as success.
   Recommended: it is the only option that addresses the unsound detector
   rather than working around it.
2. **Scope an exemption** for repos that enforce their own author convention.
   Cheaper, but leaves the conflated message in place for everyone else.
3. **Register the signing key on the account** (if PR #4640 shows Unverified) —
   independent of 1 and 2, and worth doing regardless.

Not an option: relaxing the repo's author rule. It is recent, deliberate,
doubly enforced, and unrelated to signature verification.

## Acceptance criteria

- [ ] An agent commit made in the web container ends the turn with **no**
      stop-hook complaint and **no** husky rejection.
- [ ] The stop-hook's message distinguishes "unsigned" from "signed by an
      identity I did not expect", and never prescribes `--reset-author` for a
      repo whose gate rejects that author.
- [ ] No remedy it prescribes rewrites already-pushed history.
- [ ] The `%G?`-is-not-signedness trap is cross-referenced from wherever the
      next agent will hit it, so this is not re-diagnosed a third time.

## Notes

- Folding the correct git identity into the container image would remove a
  recurring failure step independently of the above.
- Adjacent, worth fixing while someone is in this code:
  `.claude/hooks/check-cwd.sh` resolves the shared-checkout root from
  `CLAUDE_PROJECT_DIR`, which in the web container equals the agent's own
  clone — so it treats ordinary solo work as a forbidden commit into the shared
  `/workspace` tree. Its `cd`-elsewhere escape makes this survivable, but the
  guard is not doing what it was written to do in this environment.
