---
id: 1660
title: "Replace placeholder cla-check with a real CLA signature/approval gate"
status: done
created: 2026-05-24
updated: 2026-05-24
completed: 2026-05-24
priority: high
feasibility: medium
task_type: infrastructure
area: ci/legal/governance
sprint: Backlog
related: [1530]
---
# Replace placeholder cla-check with a real CLA signature/approval gate

## Problem

`.github/workflows/cla-check.yml` is a no-op placeholder. It only echoes:

> "CLA enforcement placeholder. Replace this workflow with a real contributor
> signature or approval system."

and passes for everyone, recording nothing. So the green `cla-check` status is
meaningless: no contributor has *affirmatively* accepted the CLA, and there is
no audit trail of acceptance.

## Why it matters

`CLA.md` (Loopdive GmbH terms) grants an irrevocable, worldwide, perpetual,
sublicensable, **relicensing** license — the contribution can be used under the
Apache-2.0-with-LLVM-Exceptions community distribution *and* commercial /
proprietary partner licenses. But today that grant rests only on a constructive
"by contributing you agree" theory: there is no signature, no recorded
acceptance, and no evidence the contributor ever saw the terms. That is weak
ground for any future relicensing.

This was surfaced by guest271314's first external PR (#589): we cannot rely on
any recorded CLA acceptance from them, because the gate records nothing.

## Proposed

Implement a real gate. Either:

- **(a) CLA-assistant bot** — requires an explicit "I have read and agree to the
  CLA" comment from the PR author and records signatures in a tracked file
  (auditable signatures list), or
- **(b) DCO `Signed-off-by` enforcement** — a required check that every commit
  in a PR carries a `Signed-off-by:` trailer matching the author.

Make the chosen gate a **required** status check on `main` (branch protection;
see `scripts/enable-branch-protection.sh` / `docs/ci-policy.md`). Document the
contributor flow in `CONTRIBUTING.md`. Remove the placeholder workflow.

## Acceptance

- External PRs **cannot merge** without a recorded affirmative CLA acceptance
  (bot signature or DCO sign-off).
- Signatures / acceptances are **auditable** (tracked file or per-commit
  trailer, inspectable after the fact).
- `CONTRIBUTING.md` explains the contributor flow.
- The placeholder `cla-check.yml` workflow is removed (replaced by the real
  gate as a required check).

## Note (legal)

The relicensing question itself warrants legal review; this issue covers the
**technical / process gate** only.

## Related

- #1530 (WASI native-messaging host example) — guest271314's PR #589 is gated
  on this issue. See the **HOLD** note in #1530: do not merge PR #589 until
  guest has an affirmative CLA acceptance recorded.

## Implementation (done)

Chose option (a) — a **self-hosted CLA-assistant-style gate** with signatures
stored in-repo. No third-party service.

### Files
- `.github/cla/cla-gate.mjs` — dependency-free, unit-testable logic module
  (exemption resolution, phrase matching, signature append, CLA-version hash).
- `.github/cla/cla-gate.test.mjs` — `node --test` unit tests for the pure
  logic (9 tests; run `node --test .github/cla/cla-gate.test.mjs`).
- `.github/cla/signatures.json` — the audit trail. Array of
  `{login, name, pr, commit_sha, cla_version, signed_at}`. Starts empty.
- `.github/cla/allowlist.json` — explicit exemption fallback (logins + orgs).
- `.github/workflows/cla-check.yml` — the gate (job name kept as `cla-check`).
- `CONTRIBUTING.md`, `docs/ci-policy.md` — contributor flow + policy note.

### How it works
- Triggers: `pull_request_target` (opened/synchronize/reopened) and
  `issue_comment` (created, PR comments only).
- **Exemption (critical):** an author is exempt — and passes with NO signature
  — if they are a `*[bot]`, on the allowlist, or a live member of the
  `loopdive` org. Live membership is checked via
  `GET /orgs/{org}/members/{login}` (204 ⇒ member). If that API call is
  inconclusive (rate-limit/403) we fall back to the static allowlist rather
  than blocking. **Only external (non-member) humans must sign.**
- **Signing:** an `issue_comment` from the PR author whose body is exactly
  `I have read and agree to the CLA` (trim + case-insensitive) appends a
  signature, committed by `github-actions[bot]`, and flips the check green.
- **CLA_VERSION** = `sha256:<first-12-of-CLA.md-hash>` (`currentClaVersion()`).
  A signature is valid only for the version it was recorded against, so any
  edit to `CLA.md` bumps the version and forces re-acceptance.

### WHY these choices
- **`pull_request_target`, not `pull_request`:** fork PRs need a write token to
  record the signature and set the commit status. We mitigate the well-known
  RCE risk of this trigger by **never checking out or running PR head code** —
  we check out the BASE default branch, read only PR/comment *metadata* via the
  API, and the only write is the signature-store commit. Documented in the
  workflow header.
- **Version tied to CLA.md hash, not a manual constant:** removes the failure
  mode where someone edits the terms but forgets to bump the version, silently
  keeping stale acceptances valid.
- **Live org check + static allowlist (belt and suspenders):** the allowlist
  alone would require hand-maintaining every teammate; the live check alone
  could wrongly block on an API hiccup. Together, internal authors never get
  blocked.

### Verification (done in isolation — NOT fired at #589/#389)
- `node --test .github/cla/cla-gate.test.mjs` → 9/9 pass.
- Live exemption probe against the real GitHub API:
  - `ttraenkler` → exempt (`allowlist`; and `org:loopdive` when allowlist
    emptied — proves the live org path).
  - `github-actions[bot]` → exempt (`bot`).
  - `guest271314` (external) → NOT exempt → must sign. Correct.

### Follow-up for an admin — ✅ DONE (verified 2026-08-08)
**`cla-check` is now a REQUIRED check.** It is one of the six contexts in the
live `main` ruleset:

```sh
gh api repos/loopdive/js2/rules/branches/main \
  --jq '[.[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context]'
```

It is also in `REQUIRED_CHECKS` in `scripts/enable-branch-protection.sh` and in
the required table in `docs/ci-policy.md` §1/§7, and the workflow gained a
`merge_group` trigger (#1668) so the required context posts on the merge-group
commit instead of wedging the queue.

Everything below this line is the **state as of May 2026**, kept as the record
of why the promotion was deferred. It no longer describes enforcement — read the
ruleset, not this issue.

---

`cla-check` is currently **informational** (it is not in `REQUIRED_CHECKS`, and
branch protection on `main` is presently not even enabled). To make external
PRs hard-blocked:
1. Confirm a few internal/bot PRs pass the new gate in practice.
2. Add `"cla-check"` to `REQUIRED_CHECKS` in
   `scripts/enable-branch-protection.sh` and to `docs/ci-policy.md` §1.
3. Run `./scripts/enable-branch-protection.sh`.

This was deliberately deferred so an over-strict gate can't deadlock the
internal merge queue before the exemption is proven in the wild.

### Note: why THIS PR has no `cla-check` status (expected)
A `pull_request_target` workflow always runs the workflow definition from the
**base branch**, and the old `pull_request` placeholder runs from the **head**.
This PR removes the `pull_request` trigger (head) and adds `pull_request_target`
(only active once on `main`), so the new gate does **not** run against its own
introducing PR — standard GitHub behavior, and the usual way CLA gates are
landed. The gate goes live for the *next* PR. Because `cla-check` was not yet a
required check at the time (and branch protection was off), the absent status did
not block that merge; the required checks (`cheap gate`, `merge shard reports`,
`quality`) all passed. It is required now — see the resolved follow-up above.
