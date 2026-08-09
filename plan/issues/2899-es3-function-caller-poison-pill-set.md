---
id: 2899
title: "≤ES3: Function `.caller` poison-pill must throw TypeError on set (`bound.caller = {}`)"
status: done
completed: 2026-07-25
priority: high
sprint: 77
created: 2026-06-30
feasibility: medium
task_type: bug
area: runtime
es_edition: 3
language_feature: function-caller
goal: spec-completeness
related: [2897]
assignee: ttraenkler/opus-es3
---

# #2899 — bound-function `.caller` poison-pill does not throw on assignment

One of the **8 tests blocking 100% ≤ES3 conformance**.

## Failing test

`test/language/statements/function/13.2-30-s.js`

→ **`returned 5 — assert #4 at L22: assert.throws(TypeError, function() { bound.caller = {}; })`** — assigning to `.caller` should throw `TypeError`, but doesn't.

## What it checks

`Function.prototype.caller` / `Function.prototype.arguments` are "poison-pill" accessor properties: their `[[Get]]`/`[[Set]]` throw a `TypeError` (especially on a bound/strict function). `bound.caller = {}` must throw. We currently allow the assignment (the property isn't a throwing accessor).

## Root-cause direction

The function-object property model needs `caller`/`arguments` realized as poison-pill accessors (throwing getter+setter) on the relevant functions (bound functions, strict functions). Look at how function objects expose `caller`/`arguments` and the assignment path for those keys. (Technically an ES5-strict semantic that the edition heuristic buckets as ≤ES3.)

## Acceptance

- `bound.caller = {}` (and `.arguments` set/get) throw `TypeError`; the test passes.
- No regression in normal function-property tests.

## Resolution (2026-06-30)

Already fixed on `main` when re-verified against the live tree — the filed
baseline was stale. `test/language/statements/function/13.2-30-s.js` returns
`status: pass` via `runTest262File` (and the runner was sanity-checked to
report `fail` on a deliberately-broken `assert.throws` variant, so the pass is
real, not a false positive).

Root cause of the prior fix: **#2745**. `target.bind(self)` yields a real JS
bound-function exotic (host `Function.prototype.bind`, runtime.ts §`__bind_function`),
which inherits `caller`/`arguments` from `%FunctionPrototype%` as `%ThrowTypeError%`
poison-pill accessors. Member-assignment (`bound.caller = {}`) routes through
`__extern_set_strict` → `_safeSet(strict=true)`, whose `strictAccessorWrite`
path (runtime.ts:4699-4738) walks the prototype chain, finds the inherited
poison-pill setter, runs the write, and **re-throws** the setter's TypeError so
the user's `try/catch` sees it. The get arms throw via the host `__extern_get`
invoking the inherited poison-pill getter.

This PR adds a regression guard (`tests/issue-2899.test.ts`): the four
get/set arms each throw `TypeError`, bound functions have no own
`caller`/`arguments`, ordinary object/function-custom property set/get is
unaffected, plus an end-to-end `runTest262File` check (skipped when the
test262 submodule isn't present). No compiler-source change was required.

Note (out of scope for #2899): a _narrow, separate_ quirk surfaced while
probing — reading `bound.caller` inside a nested `(fn: any)` callback that
captures a **module-level** `bound` returns `null` instead of throwing
(the production test262 wrapper declares `bound` _local_ to `test()` with a
`() => void` callback, so it is unaffected and the conformance test passes).
Flagged to the lead as a possible follow-up; does not block this issue.

## REOPENED 2026-07-25 — still failing on current main

Marked `done` on 2026-06-30, but the target test **still fails today**. Reopened
(`status: ready`, `sprint: current`); the `completed:` date is left in place as
history rather than deleted.

Measured against a **force-fetched** baseline (`fetch-baseline-jsonl.mjs --force`
— the bare command is a silent no-op, see #3629):

```
test/language/statements/function/13.2-30-s.js
  status : fail
  category: other
  error  : Expected a TypeError to be thrown but no exception was thrown at all
```

**Contributes to #3628 (close the ≤ES3 edition).** This is 1 of only 3 issues
standing between the host lane and a fully-closed ≤ES3 edition — currently
230/273 (84.2 %), with 41 of the 43 failures owned by #3486.

### What to determine first

The failure is _"no exception was thrown at all"_, so before re-implementing:
establish whether the original fix **regressed**, was **never effective for this
test**, or the test fails for a **different reason** than the one this issue
describes. A `done` issue whose test still fails is a false-done until proven
otherwise, and the three cases have different remedies.

Check the CI path (`assembleOriginalHarness` → `CompilerPool(n,"unified")` →
`scripts/test262-worker.mjs`) rather than `runTest262File` — the latter's error
**category and location are both unreliable** (only pass/fail is trustworthy).

---

## Resolution 2026-07-25 — case (2): the 2026-06-30 fix was **never effective for this test**

Diagnosed before implementing, per the three-case rule above. Not a regression,
and not a different-cause masking: the poison-pill path existed and worked, but
only on the **strict** arm — which is not the arm the conformance test runs.

### Diagnosis

Reproduced through the CI recipe (`assembleOriginalHarness` → both variants →
`compile(..., { allowJs, fileName: "test.js", deferTopLevelInit: true })`, the
worker's own options), then bisected the test's six assertions:

| assertion                                                      | primary (script goal, **sloppy**) | strict rerun |
| -------------------------------------------------------------- | --------------------------------- | ------------ |
| `bound.hasOwnProperty('caller') === false`                     | pass                              | pass         |
| `bound.hasOwnProperty('arguments') === false`                  | pass                              | pass         |
| `assert.throws(TypeError, () => bound.caller)`                 | pass                              | pass         |
| **`assert.throws(TypeError, () => { bound.caller = {} })`**    | **FAIL**                          | pass         |
| `assert.throws(TypeError, () => bound.arguments)`              | pass                              | pass         |
| **`assert.throws(TypeError, () => { bound.arguments = {} })`** | **FAIL**                          | pass         |

Exactly the two SET arms, exactly in sloppy mode — precisely this issue's title.

**Why the 2026-06-30 close looked green.** Two independent false signals:

1. Every unit case in the old `tests/issue-2899.test.ts` compiled a source
   containing `export`, which makes it **module** code — always strict — so the
   write lowered to `__extern_set_strict` and hit the strict-only accessor
   pre-check. The sloppy lowering (`__extern_set`) was never exercised.
2. The end-to-end guard used `runTest262File`, which assembles via `wrapTest`,
   not the harness assembly CI scores. Its verdict is not the conformance
   verdict.

The old resolution note even states the mechanism — "member-assignment routes
through `__extern_set_strict`" — which is the tell: the conformance test's
primary variant is script goal, so it routes through `__extern_set`.

### Root cause

`src/runtime.ts` `_safeSet`. The accessor-with-setter resolution
(`strictAccessorWrite`, added by #2745 d) was gated on `strict`:

- sloppy call ⇒ the descriptor walk is skipped entirely;
- `obj[key] = val` runs and the inherited %ThrowTypeError% poison-pill setter
  throws (the runtime module is itself strict, so the throw is real);
- the `catch` sees `strictAccessorWrite === false`, `_rethrowIfProxyOrRevoked`
  doesn't match, `strict` is false ⇒ the exception is **swallowed** and the
  write is diverted to the sidecar.

Per §10.1.9.2 OrdinarySetWithOwnDescriptor step 3, an accessor's setter is
**called**, and an abrupt completion from that call propagates out of the
assignment **regardless of the Reference's strictness**. Sloppy-mode silence
covers only the case where [[Set]] _returns false_ — a non-writable data
property, or an accessor with no setter. A throwing setter is not that case.

### Fix

`src/runtime.ts`:

- extracted the proxy-safe prototype walk into `_lookupDescriptorNoProxy()`
  (unchanged semantics; the strict pre-check now calls it);
- in the sloppy `catch` arm, resolve the descriptor **lazily** and re-raise when
  the write landed on an accessor that **has a setter**.

Lazy placement matters: the walk runs only on the already-exceptional path, so
ordinary sloppy writes pay nothing. Getter-only accessors and non-writable data
properties (`Math.E = 1`, `Number.NaN = 1`, S8.5_A9 / S8.12.4_A1 / S8.6.1_A1)
have no setter, so they keep the silent fallback — the change is
setter-present-only.

### Verification

- `tests/issue-2899.test.ts` rewritten. The old cases are kept (relabelled
  MODULE goal, since that is what they actually tested) and the missing coverage
  added: a SLOPPY case that **asserts its own premise** (the compile must import
  `__extern_set`, not `__extern_set_strict` — that assertion is what makes a
  future silent re-strictification impossible to miss), two sloppy silence
  controls, a throwing-user-setter case, and an end-to-end guard that runs the
  real test262 file through `assembleOriginalHarness` (both variants) instead of
  `runTest262File`.
- Verified load-bearing: with the fix disabled, 3 of the 8 cases fail
  (`score=7` vs `score=18`; `caught=none` vs `caught=boom`; the end-to-end guard
  throws). With it, 8/8 pass.
