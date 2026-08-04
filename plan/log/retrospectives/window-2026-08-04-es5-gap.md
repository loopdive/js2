# Retrospective — ≤ES5 goal window (2026-08-03 → 2026-08-04)

Rolling budget window, not a numbered sprint. `freeze-sprint.mjs` correctly
declined to freeze (97 % spent, its trigger is ≥ 99 % or ≤ 1 h left) and was
**not** forced: forcing would re-tag several hundred open issues into a numbered
sprint prematurely, and the carry-over is already captured in
`plan/agent-context/handoff-2026-08-04-es5-gap-window.md` (PR #4108).

## What landed

Nine PRs merged, all verified by content on `upstream/main`:

| PR | Change | Measured |
| --- | --- | --- |
| #4090 | `typeof` on reified builtin constructors (#4120) | +16 standalone, 0 regressions |
| #4091 | #4010 **S3** own-property visibility + the −684 root cause | +4/−0, 729/729 stratum control |
| #4092 | #4119 re-scope (docs) | — |
| #4096 | #4061 §8.10.5 descriptor-argument validation | **16/17**, 0/182 regressions |
| #4098 | #4147 + #4148 filings (docs) | — |
| #4100 | #4098 **G1 stage 1** — real `delete` on class instances | 0/124 by design; 5 probe cells fixed, 12/12 controls |
| #4101 | #4151 filing (docs) | — |
| #4102 | pre-commit fast lane | process fix, below |
| #4104/#4105 | other lanes (landing-page graphs, capture-reachability specs) | — |

Goal scope at close: **6,644 / 8,650 = 76.8 %**, gap ≈ 1,608. #4109 (#4119
toString arm) open and CLEAN at the buzzer.

## What went well

- **Measurement discipline held under time pressure, and it paid.** Every
  numeric claim this window carried a denominator and a kill-switch receipt.
  Three separate agents reported *no number* rather than a number from an
  instrument they had not validated — and in each case that refusal was correct
  (see "instrument blindness" below).
- **The −684 was finally root-caused, and it was not where three prior attempts
  looked.** Not the query widening: `__extern_set` had no builtin-fn arm, so
  writes to a builtin's non-writable `name`/`length` landed invisibly in the
  closure bag; `propertyHelper.isWritable` writes *before* `isConfigurable`
  deletes, so every `configurable: true` assertion failed. Pre-existing on main;
  #4055 v1 only made it observable. Fixed at source (§10.1.9 no-op).
- **Two "small" issues turned out to hide silent wrong answers**, both found
  because someone probed the legal path rather than only the failing one:
  `Object.create` dropped *every* accessor descriptor (getter never compiled,
  read returns 0), and the reified-method carrier gap where even an implemented
  `slice` answers `typeof "undefined"`.
- **Scope was re-derived, not inherited.** #4061's filed "31 files" was re-split
  by spec step into 17 + 14 — two unrelated mechanisms that shared an error
  string. #4098's "three gaps" re-measured to five. Sizing off a shared error
  signature is what merged them in the first place.
- **Substrate prefix shipping worked.** G1 stage 1 landed at 0/124 flips *by
  design* and that was the right call — the verifier is all-or-nothing, so the
  alternative was a partial that reproduces the −684 on its own stratum.

## What hurt

- **`--no-verify` had become the default, and it silently disarmed the cheap
  gates.** The full pre-commit chain exceeds agent tool timeouts, so agents
  skipped *everything* — including the two-second prettier/biome gate. That is
  how #4100 shipped an unformatted file to a failing `quality` lane, costing a
  full CI cycle. Fixed in PR #4102 (`SKIP_SLOW_PRECOMMIT=1` keeps lint-staged
  unconditional; the checklist now bans `--no-verify` for commits).
- **Local standalone measurement is blind on the whole propertyHelper
  population** (#4147). `runTest262File` links no `js2wasm:runtime-eval`
  provider, so those files die at instantiate and report `fail` — indistinguishable
  from a miscompile. **Two lanes burned effort on it independently in one
  session**, each pinning it only via a positive control (0/11 and 0/36). It is
  now the next window's first pull, promoted from "filed" to *gating*.
- **Three separate silent-success traps bit in one window**: `prettier --check`
  on a `.tmp/` path checks zero files and prints success (`.tmp/` is
  prettierignored *and* the sanctioned scratch dir); `git push` printed
  "Everything up-to-date" while the server lacked the commit; and agent harness
  worktrees seed from the **fork tip**, a non-ancestor of `upstream/main`
  carrying ~16 unlanded files.
- **Agents did not survive a session restart, and their CI watchers died with
  them.** #4100's second failure (the per-function LOC ratchet) had no owner —
  the lead applied the frontmatter grant. This is #2786's stranding condition
  reappearing one level up: the *workflow* enqueues reliably, but nobody
  re-diagnoses a red check when the author is gone. A standing shepherd covers
  it; one was staffed only late.

## Action items

1. **#4147 first, before any #4098 successor stage.** Acceptance criterion that
   matters: an unlinkable provider must return `skip`/`error`, **never** `fail`.
   A detector that cannot see must say so.
2. **Staff the shepherd at window start, not at the end.** It used zero of its
   one-shot enqueue backstops — `auto-enqueue` needed no help — but it caught
   the #4100 diagnosis that no author was alive to make.
3. **Keep the "no number beats a blind number" norm explicit in dispatch
   briefs.** It worked three times this window and each instance would have been
   a confidently wrong measurement otherwise.
4. **Fix the harness worktree seed** (fork tip → `upstream/main`). Every spawned
   writer currently starts on a poisoned base and must detect it by hand.
