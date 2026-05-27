---
id: 1592
title: "Array pattern elision holes and rest-array in destructuring consume wrong iterator step (~305 fails)"
status: blocked
created: 2026-05-24
updated: 2026-05-27
blocked_on: 1555
duplicate_of: 1555
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: destructuring, array-pattern, for-of, for-await-of, classes
goal: spec-completeness
sprint: 56
test262_fail: 305
test262_category: language/statements/class/dstr, language/statements/for-await-of, language/statements/for-of, language/expressions/class/dstr
---
# #1592 — Array pattern elision holes and rest-array in destructuring

## Problem

**305 test262 failures** across class destructuring, for-of, for-await-of, and function-parameter contexts where:

1. **Elision holes** in an array binding pattern (`[, x]`, `[a, , b]`, `[...rest, ,]`) — the iterator step for the elided slot is not consumed, so subsequent bindings read the wrong value
2. **Rest-of-array** patterns with elision (`[...ary]` where the source has holes) — similar miscount

### Error patterns observed

```
test/language/statements/class/dstr/meth-dflt-ary-ptrn-rest-ary-elision.js
  L8:5 Cannot destructure 'null' or 'undefined' [in C_method() ← test]

test/language/statements/class/dstr/private-gen-meth-static-dflt-ary-ptrn-elision.js
  L8:5 Cannot destructure 'null' or 'undefined' [in C___priv_method() ← test]

test/language/statements/for-await-of/async-func-dstr-const-async-ary-ptrn-rest-ary-elision.js
  returned 2 — assert #1 at L86: assert.sameValue(first, 1);

test/language/statements/for-await-of/async-func-dstr-const-ary-ptrn-rest-ary-empty.js
  returned 2 — assert #1 at L67: assert.sameValue(iterations, 1);
```

### Category breakdown (2026-05-24 run, excluding illegal_cast)

| Category | ~Count |
|----------|--------|
| `language/statements/class` (dstr) | ~72 |
| `language/expressions/class` (dstr) | ~72 |
| `language/statements/for-await-of` | ~42 |
| `language/expressions/object` (dstr) | ~34 |
| `language/expressions/async-generator` (dstr) | ~14 |
| `language/statements/for` | ~12 |
| `language/statements/for-of` | ~9 |
| `language/statements/function` | ~9 |
| other | ~41 |

### Root cause hypothesis

`destructureParamArray` (or the equivalent `decl-mode` path after #1553a–d) consumes iterator steps for each binding element in turn. For elision positions, the spec (§13.3.3.8 IteratorDestructuringAssignmentEvaluation step 2: "If BindingElementList contains an elision, call IteratorStep") requires calling `IteratorStep(iterator)` and discarding the result. Our implementation likely skips the `IteratorStep` call for elision positions entirely, meaning subsequent bindings read one-ahead values, and rest/empty patterns receive a null or undefined instead of the remaining iterator.

The `Cannot destructure 'null' or 'undefined'` error on the first binding of a class method (L8) suggests the iterator itself is being passed null where the caller expects an iterable — possibly the method-default parameter elision path doesn't thread the iterator through correctly.

## Acceptance criteria

- `[a,,b] = iter` leaves a one-step gap (spec §13.3.3.8 step 2b)
- `[...rest] = iter_with_elision_source` collects all remaining values correctly
- All ~305 listed test262 files pass
- No regressions in equivalence or existing dstr tests

## Notes

- Spec reference: ECMA-262 §13.3.3.8 ArrayBindingPattern evaluation, steps for BindingElisionElement

## Investigation 2026-05-27 (dev) — DUPLICATE OF #1555, root cause confirmed

Reproduced both failure shapes against the real test262 harness (worktree
`issue-1592-elision-rest`, branch from main 5932eef61):

1. `class C { method([,]) {} }; new C().method(g())` → assertion fails
   (`second` becomes 1, expected 0). The single-elision pattern `[,]` must call
   `IteratorStep` exactly ONCE (spec §12.14.5.3 Elision step). We instead
   **materialise the whole generator** via `__array_from_iter`, draining it to
   completion (`first=1, second=1`).
2. `class C { method([...[,]] = g()) {} }; new C().method()` → runtime
   `Cannot destructure 'null' or 'undefined'`. Generator-default path only;
   the same `[...[,]]` pattern with a **plain-array** arg or **plain-array**
   default (`= [9,8,7]`) both PASS. So the null leak is in the
   `__array_from_iter` materialisation of the generator default, not the rest
   logic itself.

Both failures share ONE root cause: `destructureParamArray`
(`src/codegen/destructuring-params.ts`) materialises the entire iterator into a
vec via `__array_from_iter` before binding. This over-consumes iterators with
observable side effects (generators with statements between yields). The
`isPatternEmptyOnly` guard only short-circuits length-0 `[]`, so elision-only
patterns (`[,]`) still materialise fully.

**This is exactly the repro and root cause already tracked by #1555**
(`refactor: destructureParamArray — streaming IteratorStep-per-element instead
of __array_from_iter materialisation`, `feasibility: hard`,
`reasoning_effort: max`, Backlog). #1592 is the test262-failure-count view of
the same defect. It is NOT fixable with a localised codegen patch — a partial
fix would fight the #1555 streaming rewrite and risk regressing the tuned
#1432/#1450/#1550 empty/elision/default handling.

**Recommendation**: fold #1592 into #1555 (or mark #1592 blocked-on #1555).
The streaming-iterator refactor is the correct, single fix for the whole
~305-test bucket. Escalation tag on the task was correct — this needs the
architect's #1555 streaming design, not a dev hotfix.

## Implementation Plan (architect, 2026-05-27)

### Relationship to #1555 — why a bounded helper, not the full streaming rewrite

The dev rec above proposes folding into #1555 (a full
`destructureParamArray` → streaming-IteratorStep-per-element rewrite,
`feasibility: hard`). That rewrite is the *eventual* correct shape, but it is a
large, regression-prone refactor that fights the carefully-tuned
#1432/#1450/#1550 empty/elision/default paths.

This plan is the **incremental, low-blast-radius fix**: it does **not** rewrite
the per-element binding loop and does **not** make iteration truly streaming.
It changes only **how many iterator steps the materialization consumes**, by
adding a bounded variant of `__array_from_iter`. The per-element loop, elision
`continue`, rest slice, defaults, and IteratorClose tuning all stay exactly as
they are. This recovers spec-correct step counts for the fixed-prefix (no-rest)
patterns that dominate the ~305 bucket, at a fraction of #1555's risk.

The one semantic gap vs. full streaming: an iterator whose side effects occur
*between* a binding element and its default-evaluation (`[a = sideEffect()]`)
is still materialized in one shot, so default-evaluation interleaving is not
made lazy. That sub-case stays with #1555. **Recommend: keep #1592 as the
bounded-helper fix targeting the step-count bucket; leave #1555 open for the
residual lazy-default interleaving.** If the team prefers a single fix, this
plan can be the Phase 1 of #1555.

### Root cause (refined)

The per-element loop already skips elisions correctly
(`if (ts.isOmittedExpression(element)) continue;` —
`destructuring-params.ts:1196/1339`, `assignment.ts:1377`). The bug is one
level up: **materialization is eager**. Every array-destructuring path that
sees an `externref` source calls `__array_from_iter(obj)`
(`src/runtime.ts:3820`), which drains the **entire** iterator —
`Array.from(obj)` for plain iterables, or the manual `while (true)` walk
(runtime.ts:3924–3956, capped at `MAX_ITER = 1<<16`) for wasm-closure
iterators. For a lazy generator, the spec requires exactly **N IteratorStep
calls** for an N-slot pattern (elisions and a trailing rest each count toward
N — §8.5.3 IteratorBindingInitialization), **not** a full drain.

The `Cannot destructure 'null' or 'undefined'` L8:5 class-method fails are a
**secondary symptom**: when the eager drain over-runs a generator default and
it returns/throws early, the materialized array comes back short (or stale
null) and a later binding element reads `undefined`, tripping the destructure
guard.

### Fix: bounded materialization helper `__array_from_iter_n`

Add a host import that materializes **at most `n`** iterator steps.

**Signature (JS host):** `(obj: externref, n: f64) -> externref`
- `n >= 0`: consume **exactly** `n` iterator steps (call `.next()` up to `n`
  times); stop early if the iterator reports `done` first. Returned array has
  `length <= n`.
- `n < 0` (sentinel `-1`): unbounded — behaves **identically** to today's
  `__array_from_iter` (full drain). Used when the pattern ends in a rest
  element, so it shares the exact existing drain + IteratorClose code.

Wasm import type:
`[{kind:"externref"},{kind:"f64"}] -> [{kind:"externref"}]`. f64 (not i32) for
the count matches the project's host-import numeric convention
(`__extern_get_idx`, `__extern_length`).

**Why exactly-N suffices:** a pattern with a rest element always wants the full
remainder → `n = -1`. A pattern WITHOUT a rest performs `IteratorStep` for
every slot including trailing elisions → `n = elements.length` is exact, and
the returned (possibly short) array drives the unchanged per-element loop,
whose elision `continue` and out-of-range reads already yield correct
`undefined` bindings.

#### Runtime change — `src/runtime.ts`

Refactor to reuse the existing body:

1. Extract the current `__array_from_iter` closure body (runtime.ts:3827–3984)
   into a private helper `const _arrayFromIter = (obj: any, limit: number) => …`
   (`limit` defaults to `Infinity`):
   - `Array.isArray(obj)` fast path: when `limit` is finite and `< obj.length`,
     return `obj.slice(0, limit)` — but only AFTER the existing
     overridden-`@@iterator` check; if the array has a non-default
     `@@iterator`, go through the protocol so a custom iterator is stepped at
     most `limit` times (do not whole-materialize-then-slice a custom iterator).
   - Plain-iterable `Array.from(obj)` branches: replace with a manual loop —
     `const it = obj[Symbol.iterator](); ` then call `it.next()` up to `limit`
     times, pushing `value` while `!done`. `Array.from` can't be bounded.
     Preserve throw propagation from a throwing `@@iterator`/`.next()`/`.value`.
   - Wasm-closure manual walk (runtime.ts:3924): add
     `if (out.length >= limit) break;` at the **top** of the `while (true)`
     loop, **before** the `iterCount++ >= MAX_ITER` check, and ensure this
     bounded break does **NOT** set `cappedOut`.

2. Keep `__array_from_iter` as a thin wrapper and register the new name:
   ```ts
   if (name === "__array_from_iter")
     return (obj: any) => _arrayFromIter(obj, Infinity);
   if (name === "__array_from_iter_n")
     return (obj: any, n: number) =>
       _arrayFromIter(obj, n < 0 ? Infinity : (n >>> 0));
   ```
   `n = -1` is byte-for-byte the old behavior → rest path + IteratorClose tuning
   unchanged.

3. If host imports are gated, add `"__array_from_iter_n"` next to
   `__array_from_iter` in `src/codegen/host-import-allowlist.ts`.

#### Codegen wiring

Add a step-count helper near `isPatternEmptyOnly`
(`destructuring-params.ts:63`):
```ts
/**
 * Iterator steps an array binding/assignment pattern consumes (§8.5.3).
 * Each element — INCLUDING elision holes (OmittedExpression) — costs one
 * IteratorStep. A rest element drains the remainder → unbounded → -1.
 * Binding patterns use BindingElement.dotDotDotToken; assignment patterns
 * use SpreadElement.
 */
function patternIteratorStepCount(
  elements: readonly (ts.ArrayBindingElement | ts.Expression)[],
): number {
  for (const el of elements) {
    if (el && (ts.isSpreadElement(el) ||
        (ts.isBindingElement(el) && !!el.dotDotDotToken))) return -1;
  }
  return elements.length;
}
```

**Site 1 — `src/codegen/destructuring-params.ts:944`** (param/decl externref
fallback materialization):
- Swap `ensureLateImport(ctx, "__array_from_iter", [externref], [externref])`
  → `ensureLateImport(ctx, "__array_from_iter_n", [externref, f64], [externref])`.
  Keep the surrounding `flushLateImportShifts` ordering.
- At the IR call site (lines 1041–1044), compute
  `const n = patternIteratorStepCount(pattern.elements)` at codegen time and
  emit, after `local.get paramIdx`:
  `{ op: "f64.const", value: n }` then `call __array_from_iter_n`.
- Leave the `isPatternEmptyOnly` short-circuit (line 806) untouched.

**Site 2 — `src/codegen/expressions/assignment.ts:1342`** (`[a,,b] = expr`):
- Same import swap; push `f64.const patternIteratorStepCount(target.elements)`
  before the call (lines 1345–1346).

**Do NOT touch** the `type-coercion.ts` uses (lines 206/356/362) — spread /
tuple-coercion paths (`[...iter]`) that genuinely want the full drain.
`class-bodies.ts:1331` and `statements/exceptions.ts:80` are comments only.

The WasmGC-native vec loop (destructuring-params.ts:949) and tuple-struct fast
path (line 834) read a concrete struct/array of known static length and never
step an iterator — elision/rest already correct there; no change.

### Standalone / WASI equivalent

`__array_from_iter` is **JS-host-only**; there is no WasmGC-native iterator
drain in `src/codegen-linear/` (confirmed: no `array_from_iter` reference under
that dir). Destructuring an arbitrary externref *iterable* in pure-standalone
mode is already unsupported and this fix does not regress it. The WasmGC vec /
tuple paths use static-length indexed reads (elisions honored, no iterator) so
standalone mode is already correct for those. **No new standalone host import
is required by this issue.** If a future issue adds a Wasm-native
generator-drain for standalone mode, it should accept the same `n` bound — note
here, do not build it now.

### IteratorClose handling (MUST preserve verbatim)

`__array_from_iter` calls `iterator.return()` ONLY on the `cappedOut`
(`MAX_ITER` defensive cap) path (runtime.ts:3963–3972), and deliberately does
**not** close on natural `done`, `result == null`, or missing `.next`
(tuned against `dstr/*-ary-init-iter-no-close.js`, #1219).
`__array_from_iter_n` inherits this because it shares `_arrayFromIter`:
- `n = -1` → `limit = Infinity` → identical control flow → identical close.
- `n >= 0` reaching the bound → **NormalCompletion**, do **NOT** call
  `return()`; the bounded break must not set `cappedOut`. Closing here would
  regress `dstr/*-ary-init-iter-no-close.js`.
- Keep `MAX_ITER` + its `cappedOut → return()` exactly as-is for the unbounded
  (rest) case.

### Edge cases

- **Rest** `[a, ...rest]` → `patternIteratorStepCount` = -1 → unbounded →
  byte-identical to today; downstream `__extern_slice` (assignment.ts:1379) /
  vec slice unchanged.
- **Elision counts**: `[, x]`→n=2, `[a,,b]`→n=3, `[a,,]`→n=2 (trailing elision
  still steps). TS keeps `OmittedExpression` nodes in `elements`, so
  `elements.length` is automatically right.
- **`[...rest,]`** (rest + trailing comma) → has rest → n=-1.
- **Nested** `[[a],,b]` → each top-level slot = one step; n = top-level
  `elements.length`; nested destructure runs on the materialized element.
- **Empty `[]`** → handled earlier by `isPatternEmptyOnly`; never reaches the
  helper.
- **Short source** `[a,b,c] = [1]` (n=3, yields 1) → helper returns `[1]`;
  out-of-range reads → `undefined` bindings (matches eager behavior, fewer
  `.next()` calls).
- **n=0 reaching helper** → `limit=0` → no `.next()`, returns `[]`. Safe.

### Test files to verify

```
test/language/statements/class/dstr/meth-dflt-ary-ptrn-rest-ary-elision.js
test/language/statements/class/dstr/private-gen-meth-static-dflt-ary-ptrn-elision.js
test/language/statements/for-await-of/async-func-dstr-const-async-ary-ptrn-rest-ary-elision.js
test/language/statements/for-await-of/async-func-dstr-const-ary-ptrn-rest-ary-empty.js
test/language/statements/for-of/*-ary-ptrn-elision*.js
test/language/expressions/assignment/dstr/array-elision-*.js
```

### Regression risks & categories to run

- **Highest risk: IteratorClose.** Route the rest case through unchanged
  `limit=Infinity`; never `return()` on the new bounded break.
- **`Array.from` → manual loop swap** must preserve throw propagation
  (#1150, #1454): run `dstr/*-iter-get-err*`, `*-iter-step-err*`,
  `*-iter-val-err*`.
- **Late-import shifts**: `__array_from_iter_n` has 2 args; preserve the
  `ensureLateImport` + `flushLateImportShifts` ordering at the two sites so
  funcIdx shifts propagate (`body: []` / savedBodies pattern — see CLAUDE.md
  addUnionImports note).
- **Run:** `language/statements/class` + `language/expressions/class` (dstr);
  `for-of`, `for-await-of`; `language/expressions/assignment/dstr`;
  `language/statements/function`; `language/expressions/async-generator`;
  full `tests/equivalence.test.ts`; any `issue-1158`/`issue-1159`/`iter-close`
  equivalence tests to confirm no IteratorClose regression.
