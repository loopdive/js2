---
name: reference_commit_signing_in_this_container
description: "Commit signing IS configured in this container (SSH format, custom gpg.ssh.program). Never pass -c commit.gpgsign=false; %G? reporting N is a local-verification artifact, not a signing failure."
metadata:
  node_type: memory
  type: reference
  originSessionId: 003c07aa-a2eb-5278-b5b1-6c63a0be18a6
---

**Signing is already set up. Do not disable it, and do not read `%G? = N` as
"unsigned".**

## The configuration that exists

```
commit.gpgsign    = true
gpg.format        = ssh
user.signingkey   = /home/claude/.ssh/commit_signing_key.pub
gpg.ssh.program   = /tmp/code-sign          # custom signer shim
user.name         = Claude
user.email        = noreply@anthropic.com
```

A plain `git commit` signs correctly with no prompt and no extra flags.

## The two traps

**1. `-c commit.gpgsign=false` produces silently Unverified commits.**
Adding it "to avoid a signing prompt" is a reflex worth unlearning here — there
is no prompt to avoid. Measured 2026-08-04: four commits in one session went out
with that flag, three of them pushed (one already in the merge queue and
therefore unfixable, since rewriting published history to re-sign is forbidden —
see [[feedback_public_main_append_only]]). Only the unpushed tip could be
amended.

**2. `git log --format=%G?` returns `N` even for a correctly signed commit.**
Local verification needs `gpg.ssh.allowedSignersFile`, which is NOT configured
here, so git prints:

```
error: gpg.ssh.allowedSignersFile needs to be configured and exist for ssh signature verification
```

and falls back to `N`. That is a **local verification** gap, not a signing gap.
GitHub verifies against the account's registered key and shows **Verified**.

**Check for the signature itself, not the verification verdict:**

```bash
git cat-file commit HEAD | grep -c "BEGIN SSH SIGNATURE"   # 1 = signed
```

This is the [[reference_silent_empty_is_indistinguishable_from_real]] shape: a
verifier that cannot see answers "no", and "no" is indistinguishable from a real
failure. Ask what the tool does when it CANNOT SEE.

## Related trap in the same commit path: `--no-verify`

`plan/method/pre-commit-checklist.md` item 10 bans `git commit --no-verify`
outright — it skips EVERYTHING, which is how PR #4100 shipped an unformatted
file to a failing `quality` lane. When the full pre-commit chain exceeds the
tool timeout, the sanctioned escape is:

```bash
SKIP_SLOW_PRECOMMIT=1 git commit …
```

which keeps the seconds-cheap lint-staged gate (prettier + biome) and skips only
the slow ratchets that CI re-runs anyway.

Also required by the hook: the commit message must **end with a `✓`**, signing
off `plan/method/pre-commit-checklist.md`. A `--amend` is rejected when the
*existing* message lacks it, so amending an old commit means supplying a new
message with the checkmark.

## Correct amend recipe (unpushed commits only)

```bash
SKIP_SLOW_PRECOMMIT=1 git commit --amend --reset-author -F <msgfile>
git cat-file commit HEAD | grep -c "BEGIN SSH SIGNATURE"   # verify by effect
```

`--reset-author` is what the stop hook asks for; it re-stamps author AND
committer so both carry the configured identity.

## Note on the author identity

This container's local config uses `Claude <noreply@anthropic.com>`, which the
stop hook accepts. That differs from
[[feedback_commit_author_is_user_not_agent_role]], which requires the USER as
author with Claude as co-author. **The two rules disagree; the stop hook is what
actually gates this container.** If the user wants the repo convention instead,
they have to change the container's git identity — flag the conflict rather than
picking one silently.
