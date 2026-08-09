---
id: 3558
title: Two guard tests red on main for 10–19 days — import-shape assertions went stale after intended compiler changes (#2968 wasi exn printer, #3132 PR-2 drivable carrier)
status: done
created: 2026-07-23
completed: 2026-07-23
updated: 2026-07-24
priority: high
task_type: bug
feasibility: hard
horizon: s
goal: standalone
sprint: 76
assignee: ttraenkler/senior-dev
---

# Two guard tests red on unmodified main — bisected, both culprits are INTENDED changes; tests reconciled + promoted to the guard suite

## Symptom (verified on main `b9b89b8` and again on `4d076a4`, 2026-07-23)

`npx vitest run tests/issue-2906-gap3-tryfinally.test.ts tests/issue-2980-carrier-fallback.test.ts`
→ **5 failed / 5 passed (10 total)**, two distinct signatures:

1. **issue-2906-gap3-tryfinally — 3 of 6 fail** (SYNCHRONOUS-THROW,
   SYNCHRONOUS-THROW-BEFORE-AWAIT, PENDING-then-REJECTED):
   `WebAssembly.instantiate(): Import #0 "wasi_snapshot_preview1": module is not
an object or function`. The wasi binary really imports
   `wasi_snapshot_preview1.fd_write` + `proc_exit`; the test instantiates with
   bare `{}`.
2. **issue-2980-carrier-fallback — 2 of 4 fail**:
   `expected [] to include 'Promise_reject'` / `'Promise_resolve'` — the
   async-gen standalone module compiles with ZERO imports where the test
   expected the host-Promise fallback imports.

(The dispatch note said 2906=2 / 2980=3; measured split is 2906=**3/6**,
2980=**2/4** — total 5 either way, verified at HEAD, at the culprits, and at
07-10.)

## Bisect (first-parent, `git bisect run` with binary-import probes; validated by full vitest runs on both sides of each culprit)

Two **separate** culprits, in **disjoint windows** — NOT one shared cause, and
NOT yesterday's commits:

| Signature                    | GOOD                                       | BAD                        | First-bad (first-parent)                     | Inner commit                                                                             |
| ---------------------------- | ------------------------------------------ | -------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1 (2906, wasi import "leak") | `a4702ed` 07-01 (PR #2416 merge, 6/6 pass) | `1aedd65` 07-10 (3/6 fail) | **`7012743` — Merge PR #2533** (07-04 00:19) | `d4d19d0` `fix(#2968): wasi _start uncaught-exception printer`                           |
| 2 (2980, fallback gone)      | `1aedd65` 07-10 (4/4 pass)                 | `8914a4c` 07-23 (2/4 fail) | **`d7d0db8` — Merge PR #3013** (07-13 14:20) | `90ba2a8` `feat(#3132 PR-2): native $Promise carrier for all-drivable async-gen modules` |

Both dispatch-suspects **refuted by the bisect**: `9d123cd` (#3538 async-gen
abrupt completion, 07-23) and `3c9a01d` (callable boundary ABI, 07-21) are
both _later_ than either culprit window.

Note: the local repo was **shallow** (graft at 07-05) — every file "appears
added" at the boundary merge, which initially mis-attributed the 2906 test's
add date. `git fetch origin main --shallow-since=2026-06-28` deepened it;
the real GOOD anchor is PR #2416's merge (07-01).

## Mechanism

### Signature 1 — #2968 (PR #2533), by design

`registerWasiImports` registers `fd_write` + `proc_exit` **whenever the wasi
module's source contains a `throw`** (anywhere — including inside a `.then`
callback), for the `_start` uncaught-exception printer ("uncaught exception
renders to stderr + `proc_exit(1)` instead of silent exit 0"). Non-throwing
modules stay byte-identical — which is exactly the 3-pass/3-fail split in the
2906 file (the 3 failing cases contain `throw` in source; the 3 passing don't).

Two test-side latencies made this invisible:

- `r.imports` **omits wasi system imports entirely** (it listed only `env.*`),
  so the test's `expect(r.imports).toEqual([])` was vacuous for wasi modules —
  it never guarded anything; only the bare-`{}` instantiate caught the change.
- Semantics were NEVER broken: with a `wasi_snapshot_preview1` stub the
  throw-path cases run and produce the exact expected values (probe: 101).

### Signature 2 — #3132 PR-2 (PR #3013), by design

The #2980 blanket fallback (`moduleHasAsyncGen` ⇒ both carrier gates OFF ⇒
whole Promise lane host) was deliberately refined to
`moduleHasNonDrivableAsyncGen` (`widenAsyncGenFallback`,
src/codegen/async-scheduler.ts): an **all-drivable** async-gen module keeps the
native `$Promise` carrier and loses ALL `env.*` imports — the host-free floor
this was measured for (07-10/07-13 A/Bs). The 2980 test's gens are simple
top-level drivable shapes ⇒ native ⇒ imports `[]`.

Additionally the `JS2WASM_ASYNC_CARRIER_WIDEN` env toggle the test set was
**retired** on 2026-07-10 (widen flipped to production, PR #2867) — the test's
whole measure-lane framing was stale.

## Verdict + fix (this PR)

**No compiler change.** Both culprit changes are intended, documented, and
measured; the guard tests asserted superseded properties. Reconciled test-side:

- `tests/issue-2906-gap3-tryfinally.test.ts` — assert host-free from the
  **binary** import section (`env.*` forbidden; `wasi_snapshot_preview1`
  allowed per #2968) and instantiate with a minimal wasi stub whose
  `proc_exit` throws (loud). All 6 semantics assertions unchanged → 6/6.
- `tests/issue-2980-carrier-fallback.test.ts` — rewritten to the CURRENT
  intended lane split: all-drivable async-gen module ⇒ imports `[]`;
  **new** non-drivable case (object-literal stem collision `o1.g`/`o2.g`) ⇒
  legacy host lane fires (`env.__gen_next` + `env.__get_caught_exception`
  present — the still-live #2980 no-mixing lane); non-async-gen ⇒ native;
  compile spot-check kept; retired env-toggle plumbing removed → 5/5.
- Probed non-drivable shapes for the new case: rest-param and loop-body gens
  **CE** in standalone (#680 legacy numeric-only), unused/DCE'd method gens
  emit nothing; the stem-collision (and `arguments`-method) shapes are the
  ones that reach the legacy host buffer and stay compilable — 2/6 probed
  shapes usable.

## Visibility gap (#3552) — closed for this class

Both files added to `tests/guard-suite.json` (required `quality` gate,
#3514): they meet all three entry criteria (invariant-guard with a proven
silent break; ~4–5s each locally, no test262/harness inputs; green on this
PR's tree). Suite grows 3 → 5 files, ~+10s against the ~2-min budget.

This is the third and fourth instance of the untouched-guard-test class
(#3503→#3471 ~2 days; #3483→#1539 ~2 days; here 19 and 10 days — the
longest yet), reinforcing #3552's premise: per-PR CI runs only PR-touched
test files, so a semantics/import-shape change breaks untouched guards
silently.

## Possible follow-ups (not in this PR)

- `r.imports` omits wasi system imports — any consumer using it to prove
  "import-free" for wasi modules gets a vacuous `[]`. Consider including
  them (or a `systemImports` field).
- #2968's printer gate is "source contains `throw` anywhere", coarser than
  "module-init can throw" — harmless for real WASI hosts (they always
  provide fd_write/proc_exit), but it makes every throwing wasi module
  carry the printer. A reachability-based gate would shrink binaries.

## Repro / validation commands

```bash
# regression (pre-fix, on 4d076a4): 5 failed / 5 passed
npx vitest run tests/issue-2906-gap3-tryfinally.test.ts tests/issue-2980-carrier-fallback.test.ts
# bisect predicates: compile probe + WebAssembly.Module.imports() shape check
# post-fix: 11/11 pass, ~8s
```
