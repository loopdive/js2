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

## Author identity — RESOLVED by the user, 2026-08-06

**Commits are authored by the USER, with Claude as co-author.** The user stated
this directly, which settles the conflict the section below had left open.

**A commit has TWO identities and they must differ here.** Setting
`user.email` to the user's address sets author *and* committer, and the stop
hook then flags every commit — GitHub verifies a signature against the
**committer**, so a committer of `github.com@loopdive.com` renders as
**Unverified** no matter that the commit is correctly signed. Attribution is
the **author** field. So:

| field | value | why |
| --- | --- | --- |
| author | `Thomas Tränkler <github.com@loopdive.com>` | the attribution the user asked for |
| committer | `Claude <noreply@anthropic.com>` | the identity the signing key is registered to; what GitHub verifies |
| trailer | `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` | not automatic — write it into the message |

This is ordinary git, not a workaround: `main`'s one human commit is
`A: Thomas Tränkler / C: GitHub <noreply@github.com>` (a web-UI commit), so
author≠committer is already the norm in this repo.

Keep the config as the COMMITTER identity and pass the author explicitly:

```
user.name   = Claude
user.email  = noreply@anthropic.com
```

```bash
git commit --author="Thomas Tränkler <github.com@loopdive.com>" -m "… ✓"
# fixing earlier commits (note: NOT --reset-author, which would overwrite the
# author with the committer — the exact mistake this section exists to prevent):
git rebase --exec 'git commit --amend --no-edit --author="Thomas Tränkler <github.com@loopdive.com>"' <base>
```

Verify with `git log -3 --format='%h A:%ae C:%ce'` — you want two DIFFERENT
addresses.

plus a trailer in every commit message (it is **not** automatic — the config
sets the author, not the trailer):

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

Now set in the repo's **local** git config, which lives in the common `.git`
dir and is therefore **shared by every worktree** — so agents spawned with
`isolation: worktree` inherit it without being told. They still have to add the
trailer themselves.

Confirm before pushing: `git log -3 --format='%an <%ae>'`.

Historical note worth keeping: 26 of the last 60 commits on `main` are authored
`Claude <noreply@anthropic.com>`, so the wrong identity has been the de-facto
default here for a long time. Do not read existing history as evidence of the
convention — read this file.

## (superseded) The conflict this used to describe

This container's local config used `Claude <noreply@anthropic.com>`, which the
stop hook accepts. That differs from
[[feedback_commit_author_is_user_not_agent_role]], which requires the USER as
author with Claude as co-author. The two rules disagreed, and this file said to
flag the conflict rather than pick one silently.

**Outcome: flagging it was right, but I did not do it early enough.** The
conflict sat unresolved while commits kept going out under the wrong identity;
the user had to raise it. The lesson is not about this particular setting — it
is that a known, written-down conflict is a thing to surface **at the first
commit**, not to carry indefinitely as a footnote.
`[[feedback_commit_author_is_user_not_agent_role]]` won.
