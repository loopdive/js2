---
id: 4545
title: "Agent commits are permanently Unverified: the commit-author rule and the harness verification rule are mutually unsatisfiable, and the signing key is unprovisioned"
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
---

# #4545 — Agent commits cannot be Verified: two rules, no overlap

## Problem

Every commit an agent makes in the Claude-Code-on-the-web container is shown by
GitHub as **Unverified**, and the situation is currently unresolvable from
inside the container. Three constraints intersect:

1. **The repo requires the author to be the human user.** `.husky/commit-msg`
   rejects any commit whose author matches `claude|anthropic`; Claude belongs
   only in a `Co-Authored-By:` trailer (project-lead order 2026-08-09,
   `feedback_commit_author_is_user_not_agent_role`). A `PreToolUse` hook
   (`.claude/hooks/check-commit-author.sh`) now enforces the same rule earlier.
2. **The harness stop-hook requires the opposite.** It flags every commit whose
   committer email is not `noreply@anthropic.com` and is unsigned, and
   instructs the agent to run
   `git config user.email noreply@anthropic.com && git commit --amend --reset-author`.
3. **Signing — the one option that would satisfy both — is configured but not
   provisioned.** `/root/.gitconfig` sets `commit.gpgsign=true` and
   `gpg.format=ssh`, with `user.signingkey` pointing at
   `/home/claude/.ssh/commit_signing_key.pub`, which is a **0-byte file**, with
   no private key beside it. Commits therefore come out `sig=N`.

So the stop-hook's prescribed remedy is blocked by the repo's own hook —
verified directly on 2026-08-17, when a commit run under the container's
default identity was rejected with:

```
commit-msg: BLOCKED — commit author is 'Claude <noreply@anthropic.com>'.
  The author must be the human user; Claude belongs ONLY in a
  'Co-Authored-By:' trailer (project convention, CLAUDE.md).
```

## Why it is worth fixing rather than tolerating

- **The nag is unbounded.** The stop hook fires on every turn with an unpushed
  or unverified commit. An agent either burns a turn re-explaining the conflict
  or — worse — complies, hits the husky gate, and loses a commit cycle. Both
  happened repeatedly in one session.
- **It trains the wrong reflex.** The stop hook's remedy is a `--reset-author`
  and, in the multi-commit form, a `git rebase --exec` across the branch.
  Rebasing published history is forbidden here (public `main` is append-only),
  so an agent that follows the instruction on a pushed branch does real damage.
- **Unverified is not cosmetic if the repo ever gates on it.** It does not
  today, which is why this is `medium` and not higher.

## Options (pick one; they are mutually exclusive in effect)

1. **Provision the signing key** — put a real SSH signing key for
   `git@thomas.traenkler.com` in the container and register its public half on
   the GitHub account as a *signing* key. Commits stay authored by the user,
   satisfy the repo rule, and show Verified. **Recommended**: it is the only
   option where both rules hold simultaneously and nothing is relaxed.
2. **Silence the stop hook for this repo** — teach
   `~/.claude/stop-hook-git-check.sh` that a repo enforcing its own author
   convention is exempt. Cheapest, but leaves commits Unverified.
3. **Relax the repo author rule** — allow a Claude-authored commit. Not
   recommended: the rule is recent, deliberate, and now doubly enforced; its
   purpose (attribution to the human, agent as co-author) is unrelated to
   signature verification.

Options 1 and 2 are independent and could both be taken; 3 conflicts with 1.

## Acceptance criteria

- [ ] An agent commit made in the web container ends the turn with **no**
      stop-hook complaint and **no** husky rejection.
- [ ] Whichever option is taken is recorded where an agent will actually read
      it — `CLAUDE.md` and/or the memory entry — so the next session does not
      re-derive this conflict from scratch.
- [ ] If option 1: the key is provisioned such that `git log --format=%G?`
      reports a good signature, and the setup is documented for future
      containers (an ephemeral container loses it otherwise).
- [ ] If option 2: the exemption is scoped to repos that enforce an author
      convention, not a blanket disable.

## Notes

- The container's git identity defaults to `Claude <noreply@anthropic.com>`, so
  every commit needs explicit `-c user.name`/`-c user.email` overrides. Folding
  the correct identity into the container image would remove a recurring
  failure step independently of which option above is chosen.
- `.claude/hooks/check-cwd.sh` has an adjacent environment mismatch worth
  noting while someone is in this code: it resolves the shared-checkout root
  from `CLAUDE_PROJECT_DIR`, which in the web container equals the agent's own
  clone, so it treats ordinary solo work as a forbidden commit into the shared
  `/workspace` tree. Its `cd`-elsewhere escape makes this survivable, but the
  guard is not doing what it was written to do in this environment.
