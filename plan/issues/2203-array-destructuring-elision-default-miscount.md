---
id: 2203
title: "Standalone closure-capturing native generator emits invalid funcidx (function index out of range) (~33 standalone CE)"
status: done
sprint: 64
created: 2026-06-19
updated: 2026-06-21
completed: 2026-06-21
assignee: ttraenkler/sendev-funcidx
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, generators, late-import-shift
language_feature: generators
goal: spec-completeness
related: [2039, 2043, 1809, 1461]
test262_bucket: dstr-elision-default
test262_count: 33
es_edition: es2015
origin: "2026-06-19 sprint-64 standalone failure mining (orig hypothesis: array-destructuring elision miscount). 2026-06-21 dev-anita measured ground truth DISPROVED the elision hypothesis (see ## History) and isolated the real root cause: a standalone funcidx desync in closure-capturing native generators."
---

# #2203 — Standalone closure-capturing native generator emits invalid funcidx

> **Re-scoped 2026-06-21.** The original "array-destructuring elision +
> default miscount" hypothesis was **disproved** by measurement (dev-anita).
> Pure elision already works in both host and standalone. The real bug
> hiding under this cluster is a standalone funcidx desync in
> closure-capturing native generators. Full disproof preserved in
> **## History** below. A second, distinct bug (eager generators → host
> wrong-values) is split out to the architect — see **## Split: lazy
> generators**.

## Problem

A nested `function*` that **(a)** captures an outer variable AND **(b)**
contains a `yield`, compiled with `--target standalone`, emits:

```
Binary emit error: Codegen error: function index out of range — undefined at function 'g'
```

Minimal repro (standalone only):

```ts
export function test(): number {
  let f = 0;
  function* g() { yield f; }   // captures f AND yields
  return f;
}
```

Drop **either** condition — remove the capture (`yield 0`) or remove the
`yield` — and it compiles cleanly. So the trigger is precisely the
*capture × yield* interaction in a native generator under standalone.

## Root cause (measured)

This is the late-import-shift / funcidx-desync class (cf. #2043, #1809,
#1461, and CLAUDE.md `addUnionImports` / type-index-shift notes):

- `ensureNativeGeneratorResumeFunction` reserves a function slot for the
  resume body.
- The resume body reads the **boxed-capture ref-cell** for the captured
  outer var, which triggers `addUnionImportsAsNativeFuncs` to append
  defined functions.
- That late append shifts function indices, but a call inside the resume
  body was already baked with `funcIdx = undefined` (the shift-repair —
  cf. `flushLateImportShifts` — misses native-func registrations, same as
  the #1461 `number_toString` desync).

This is **senior-dev / [CONFLICT] scope** — the late-import-shift
machinery, not a medium dev bugfix.

## Impact

~33 of the original 48-file `*ary-ptrn*elision*` standalone compile_error
cluster are generator-driven (the destructuring test fixtures use
`function* g()` as the default initializer). Fixing this funcidx desync
clears the bulk of the standalone CE in that cluster — the **biggest win**
in the original #2203 framing.

## Approach (sketch — senior-dev to confirm)

Audit the shift-repair path so native-generator resume-function
registrations (and the boxed-capture ref-cell import they pull in) are
included when funcidx are rebased after a late import/native-func append.
Compare against the #1461 fix (`flushLateImportShifts` missing native-func
regs) and #2043. Verify the minimal repro above compiles standalone, then
confirm the `*ary-ptrn*elision*` standalone shard CE count drops by ~33.

## Acceptance criteria

- [ ] Minimal repro (`let f; function* g(){ yield f; }`) compiles
      `--target standalone` with no `function index out of range`.
- [ ] The capture×yield native-generator path rebases funcidx correctly
      after late native-func appends (root-cause fix, not a guard).
- [ ] Standalone `*ary-ptrn*elision*` cluster: `>= 30` of the ~33 CE flip
      to pass/fail (no longer compile_error).
- [ ] No regression in non-capturing or non-yielding generators in host or
      standalone.
- [ ] A focused `tests/issue-2203-*.test.ts` covering capture×yield in a
      nested generator under standalone.

## Resolution (2026-06-21, sendev-funcidx)

**Root cause confirmed and fixed — but it was NOT a `flushLateImportShifts`
miss like #1461.** It was a *predicate disagreement* that left a real funcidx
`undefined`, not a stale-but-shifted index:

- The host-import predicate `sourceNeedsGeneratorHostImports`
  (`src/codegen/generators-native.ts`) decides whether to register the JS-host
  generator buffer imports (`__gen_create_buffer`, `__create_generator`, …) in
  standalone, via `isNativeGeneratorCandidate`.
- `isNativeGeneratorCandidate` did **not** consider captures, so a capturing
  `function* g(){ yield f; }` was deemed a *native candidate* ⇒ predicate
  returned "no host imports needed" ⇒ imports **skipped** in standalone.
- But the emission gate in `nested-declarations.ts:344` only takes the native
  path when `captures.length === 0`, so the capturing generator **fell through
  to the host buffer path**, which bakes
  `ctx.funcMap.get("__gen_create_buffer")!`. With the import never registered
  that `!` produced `undefined`, baked into a `call` ⇒
  `function index out of range — undefined at function 'g'`.
- Dropping the yield made `isNativeGeneratorCandidate` return false (no yield
  terminator) ⇒ predicate correctly asked for host imports ⇒ compiled. Dropping
  the capture took the native path ⇒ no host imports needed ⇒ compiled. Exactly
  the observed capture×yield trigger.

**Fix (one root-cause change):** `isNativeGeneratorCandidate` is now
capture-aware via a new `generatorCapturesEnclosingScope` helper (TS-checker
based; counts only **enclosing-function** bindings, so a top-level generator
reading a module global stays native). A capturing generator is now non-native
*everywhere*, so the import predicate and the emission gate agree and the
host-fallback imports are registered. No cast/guard papering over a stale index.

Verified standalone:
- minimal repro compiles (no funcidx error);
- `.next()`-driven capturing generators return correct captured values
  (incl. post-construction mutation through the boxed ref-cell);
- no-capture native generators still emit **zero** host imports (#2172 invariant
  intact);
- host-mode generators unaffected.

Tests: `tests/issue-2203-funcidx-gen-capture.test.ts` (6 cases). tsc + prettier
clean. Pre-existing failures `tests/issue-1169f-7{a,b}.test.ts` (IR/legacy
yield-sequence equivalence) and the broken `tests/generator-nested.test.ts`
import confirmed failing identically on `origin/main` — not regressions.

## Follow-up (escalate → separate issue): host-buffer generator iteration in standalone

`for-of` and **array-destructuring** over a *host-buffer* generator in
standalone do NOT yet work — they trap (`dereferencing a null pointer`) or
return `NaN`. This is a **pre-existing, capture-independent** gap: it fails the
same way for a *no-capture native* generator too (`const [a,b] = g()` → NaN on
`origin/main`). Cause: the standalone iterator runtime
(`ensureNativeIteratorRuntime` / `__array_from_iter_n` in `loops.ts:3938-3960`)
only drives the canonical `$Vec`; a host JS `Generator` externref hits the
`$Vec` `ref.cast` and traps. The for-of path (loops.ts:3938) only special-cases
*native state-struct* generators, so host-buffer generators fall through.

⇒ The `~33 *ary-ptrn-elision*` cluster (array-destructuring of generators) will
flip CE → **fail** (no longer compile_error) rather than CE → pass until this
iteration gap is closed. That requires teaching the standalone for-of /
destructuring drivers to recognize a host-generator externref and drive it via
the already-registered `__gen_next` / `__gen_result_value*` / `__gen_result_done`
imports — a distinct, larger change. **Routed to architect** alongside the lazy
-generator split below.

## Split: lazy generators (→ architect)

Repro `var [[,] = g()] = []` produces host wrong-values
(`first=1, second=1` instead of `1, 0`). Cause is **eager** generators:
`__create_generator` builds the full yield buffer at `g()` call time,
running the entire body (both `first+=1` and `second+=1`) eagerly.
Destructuring correctly bounds to one step via
`__array_from_iter_n(gen, 1)`; the laziness violation is upstream in the
generator strategy. This is an **architectural** generator-strategy issue
(lazy/suspendable generators), not a destructuring or funcidx fix — route
to architect as a separate issue.

## History — original elision hypothesis (DISPROVED 2026-06-21)

dev-anita split the 48-file elision cluster by whether the test uses
`function* g()`:

- **No-generator elision tests (6):** host 6/6 pass; standalone 4 pass / 2
  fail. `[, , x]`, `[, ...rest]`, leading/nested holes all bind correctly
  in both modes. **There is no elision miscount to fix** — pure elision
  already works (original repros B `x === 30` and C `rest === [2,3]` pass).
- **With-generator elision tests (42):** host 19 fail, standalone 18
  compile_error + 14 fail. Every standalone compile_error and nearly all
  host fails are **generator-driven**, not elision-driven.

⇒ No destructuring code change is warranted. The cluster's failures
decompose into the two generator bugs above. No code was pushed.
