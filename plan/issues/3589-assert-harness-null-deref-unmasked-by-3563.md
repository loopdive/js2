---
id: 3589
title: "latent null-deref in the compiled test262 `assert` harness, unmasked (not caused) by #3563"
status: wont-fix
sprint: current
created: 2026-07-24
updated: 2026-07-24
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen, test262
goal: core-semantics
related: [3024, 3563, 3189, 3590, 3593]
origin: "PR-queue shepherd diagnosis of the #3563 auto-park, 2026-07-24. Reproduced both sides locally by swapping only src/codegen/index.ts."
---

# #3589 — latent null-deref in the compiled test262 `assert` harness

> **SUPERSEDED — duplicate of #3593, kept there for the stronger minimized repro.**
>
> #3593 documents the same defect (the `Iterator.zip` uncatchable trap) and
> proves pre-existence more directly: its minimized file traps **identically with
> and without** #3563's dispatcher change. The both-sides table below reaches the
> same conclusion by a weaker route — on `main` the full test262 file dies earlier
> with a different error (invalid Wasm), so it never reaches the trap at all.
> Work the issue in **#3593**; this file is retained only for the analysis it
> carries (the `assert` L76 localisation, the ruled-out padding evidence, and the
> `grep -a` tooling warning).

## Problem

`test/built-ins/Iterator/zip/iterables-iteration.js` traps with an **uncatchable
null dereference inside the compiled test262 `assert` harness**. The trap is
**pre-existing**; it was invisible only because the module never validated, so
execution never reached `assert`.

PR #3563 (`fix(#3024)`: pad missing method args in the iterator `next`/`return`
dispatcher) makes the module validate. The moment it does, the latent deref
becomes reachable and the test starts trapping — which trips the #3189
uncatchable-trap ratchet and auto-parked the PR.

**#3563 does not introduce this bug. It unmasks it.** Blocking #3563 on it would
block a net-positive change (+11 pass, 0 pass-regressions) on an unrelated
pre-existing defect.

## Evidence — both-sides reproduction

Run locally with `runTest262File()`, swapping **only** `src/codegen/index.ts`
between `origin/main` and the #3563 head (`432573a07`); everything else identical:

| tree                   | status | error                                                                                                                                                |
| ---------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `origin/main`          | `fail` | `CompileError: WebAssembly.instantiate(): Compiling function #2083:"__call_next" failed: not enough arguments on the stack for call (need 2, got 1)` |
| PR #3563 (`432573a07`) | `fail` | `RuntimeError: dereferencing a null pointer in __module_init() at source L76`                                                                        |

Key reading of that table:

- The test is `fail` on **both** sides — it has **never** passed. There is no
  pass-regression here; only the _flavour_ of the failure changed.
- The `main` error is exactly the invalid-Wasm bug #3563 exists to fix, which
  confirms #3563 does what it claims.
- The trap therefore sits **behind** a module that previously could not even be
  instantiated.

## Localisation

Dumping the assembled harness for this test (`assembleOriginalHarness`) shows
**source L76 is the `assert` harness function itself**:

```
  69 /*---
  70 description: |
  71     Collection of assertion functions used throughout test262
  72 defines: [assert]
  73 ---*/
  74
  75
  76 function assert(mustBeTrue, message) {
  77   if (mustBeTrue === true) {
  78     return;
  79   }
  80
  81   if (message === undefined) {
  82     message = 'Expected true but got ' + assert._toString(mustBeTrue);
  83   }
  84   throw new Test262Error(message);
  85 }
```

The failing path is the **non-trivial branch** of `assert` (`mustBeTrue !== true`),
i.e. the `message === undefined` / `assert._toString(mustBeTrue)` /
`throw new Test262Error(message)` sequence. The prime suspect is the
`assert._toString` **static-property access on the function object** and/or the
`Test262Error` construction — a null receiver being dereferenced rather than a
proper object.

**Ruled out — the #3563 argument padding is NOT the trap source.** The dispatcher
was instrumented to log every padded parameter for this test; the only padded
param is:

```
[pad] next __anon_7 [{"kind":"f64"}]
```

That is the numeric NaN missing-arg sentinel (`i64.const 0x7ff00000deadc0de` +
`f64.reinterpret_i64`), a value type — it cannot produce a null dereference. The
null comes from the now-reachable `assert` body, not from the pad.

## Why this is worth `priority: high`

`assert` is injected into **every** test262 assembly (it is the harness's core
assertion primitive). A null-deref reachable in its failure path is therefore
likely to be a **class** defect, not a single-test curiosity: any test whose
module currently fails to validate is hiding whatever `assert` would have done.
As other invalid-Wasm bugs get fixed (which is active work — #3024 has ~15
merged slices), more tests will start reaching this path and start trapping,
each one tripping the #3189 ratchet and parking an otherwise-good PR. Expect
this to recur until the root cause is fixed.

## Reproduction

```bash
# in a worktree at the #3563 head (or any tree where the module validates)
npx tsx -e "
import { runTest262File } from './tests/test262-runner.ts';
const r = await runTest262File(
  process.cwd() + '/test262/test/built-ins/Iterator/zip/iterables-iteration.js',
  'probe', 120000);
console.log(r.status, r.error);
"
# → fail  RuntimeError: dereferencing a null pointer in __module_init() at source L76
```

## Acceptance criteria

1. `test/built-ins/Iterator/zip/iterables-iteration.js` no longer traps; it fails
   (or passes) through a **catchable** path.
2. The failing construct inside `assert` is identified precisely (static property
   access on a function object vs `Test262Error` construction vs string concat)
   and covered by an equivalence test, not just fixed for this one file.
3. `null_deref` trap-category count does not grow.
4. Re-running #3563's `merge_group` regression job no longer reports
   `null_deref 159 → 160`.

## Notes

- Discovered while diagnosing the #3563 auto-park
  (`auto-park-bot:merge-group-failure`, `merge_group` run 30129091219, job
  `check for test262 regressions`). #3563's own numbers were otherwise strongly
  positive: net **+11 pass** (30918→30929), host stable-path fine-gate net **+33**
  (35 improvements − 2 regressions), compile_timeout **−12**, all other trap
  categories flat, baseline content-current (0 test262-relevant commits behind,
  so not drift).
- #3563 remains parked pending a **per-PR** valve for the #3189 ratchet that is
  usable by an ordinary same-oracle PR. The global `TRAP_RATCHET_TOLERANCE` repo
  variable was deliberately **not** used — it is queue-wide (it would blind the
  gate for every other PR in the queue while open), and the repo has a prior
  incident of it being left open, which is why
  `.github/workflows/trap-tolerance-staleness-alert.yml` exists.
- **State of the change-scoped valve (verified, not assumed).**
  `scripts/diff-test262.ts` **already** implements both the #3189 ratchet and the
  change-scoped allowance: `TRAP_GROWTH_ALLOW_KEY = "trap-growth-allow"` (line
  295), read via `readChangeScopedNumericAllowance` (line 1854), then
  `effectiveTrapTolerance = Math.max(trapTolerance, trapAllowance?.count ?? 0)`
  (line 1862). **But the read is wrapped in `if (rebaseMode)` (line 1853)** and is
  documented as inert for same-oracle changes — it was built for the #3370 oracle
  bump. #3563 is an ordinary same-oracle PR, so the allowance never fires for it
  and the global env var really is the only existing lever. The Lane A fix is
  therefore to **extend the existing rebase-gated allowance to a genuine
  non-rebase reclassification**, not to build a new mechanism — ideally
  machine-checked (the declaration names the tests, and the gate verifies those
  tests were not `pass` on the baseline) so it cannot degrade into a general
  trap-growth escape hatch.
- ⚠️ **Tooling trap when investigating this file: plain `grep` returns NOTHING on
  `scripts/diff-test262.ts`** — it silently treats the file as binary (even though
  `file` reports clean UTF-8), so `grep -n "trap" scripts/diff-test262.ts` exits 1
  and looks like a confident "not present". **Use `grep -a`** (or an AST/TS
  scanner). This produced a wrong conclusion about the valve's existence once
  already during this very diagnosis.
- See #3590 for a separate, currently-unexercised trap landmine found in the same
  #3563 code.
