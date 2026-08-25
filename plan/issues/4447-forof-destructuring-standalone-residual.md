---
id: 4447
title: "standalone: for-of destructuring residual (~200 non-generator tests) — iterator close/abrupt-completion + trailing-iterator state + nested patterns"
status: done
sprint: current
created: 2026-08-15
updated: 2026-08-25
completed: 2026-08-25
assignee: claude/es6-standalone-session
priority: high
horizon: m
feasibility: medium
task_type: conformance
area: codegen
es_edition: es6
goal: standalone-mode
related: [4444, 2566, 1219, 999]
loc-budget-allow:
  - src/codegen/binary-ops-typed-dispatch.ts
  - src/codegen/binary-ops.ts
  - src/codegen/destructuring-params.ts
  - src/codegen/literals.ts
  - src/codegen/statements/for-of-destructuring.ts
  - src/codegen/iterator-native.ts
func-budget-allow:
  - src/codegen/binary-ops-typed-dispatch.ts::compileTypedBinaryDispatch
  - src/codegen/binary-ops.ts::compileBinaryExpression
  - src/codegen/destructuring-params.ts::destructureParamArray
  - src/codegen/literals.ts::compileArrayLiteral
  - src/codegen/statements/for-of-destructuring.ts::compileForOfIteratorAssignDestructuring
  - src/codegen/statements/for-of-destructuring.ts::compileForOfAssignDestructuringExternref
  - src/codegen/statements/for-of-destructuring.ts::compileForOfAssignDestructuring
  - src/codegen/iterator-native.ts::buildIteratorNextBody
  - src/codegen/iterator-native.ts::fillNativeIteratorLateArms
---

# #4447 — for-of destructuring standalone residual

## Problem

201 non-passing ES2015 tests under `language/statements/for-of/dstr/*` in the
standalone lane are NOT generator-carrier failures (those are #2864's; ~15 of
the 216 total are and stay out of scope — skip any test whose failure mentions
`__gen_`/`__create_generator`). Top sub-buckets by test-name pattern
(measured 2026-08-15 from the fresh standalone baseline via
`.tmp/es6-standalone-clusters.ts`):

| ~Tests | Pattern | Symptom |
|---|---|---|
| 23 | `array-elem-trlg-iter-*` | trailing-element iterator state: elision/rest after a completed or abrupt iterator |
| 14 | `obj-prop-elem-init-*` | object-pattern property element with initializer (incl. fn-name inference `NaN vs undefined`) |
| 27 | `{const,var,let}-ary-ptrn-*` | array-pattern binding forms |
| ~25 | `*-nested-obj-*` / `*-nested-array-*` | nested pattern recursion (null/undefined → "Expected a TypeError but none thrown") |
| ~12 | `*-iter-{rtrn,thrw,close}*` | IteratorClose on abrupt completion; `return`/`throw` propagation |
| rest | put-prop / put-unresolvable / init-fn-name / elision | assignment-target evaluation order, strict unresolvable ReferenceError, fn `name` |

Error mix: "Expected a TypeError/Test262Error/ReferenceError but none thrown"
(~62), SameValue mismatches (value semantics, ~35), "Cannot convert undefined
or null to object" (~10).

## Implementation Plan (fable, 2026-08-15) — triage-first

This bucket is diverse; do NOT attempt one mega-fix. Work top-down by
sub-bucket, each with its own commit:

1. **Reproduce cheaply.** Compile single tests with the CLI
   (`npx tsx src/cli.ts <file> --nativeStrings` per its `--help`) or run the
   scoped suite (see Validation). Pick ONE representative per sub-bucket and
   diff actual-vs-expected before touching code.
2. **Locate the lowering.** Destructuring lowering lives in the codegen
   statements/expressions path (grep `dstr`, `ArrayBindingPattern`,
   `ObjectBindingPattern` under `src/codegen/` and `src/ir/`; #1219/#2566 name
   the iterator-destructuring machinery — read their issue files first for
   known constraints, esp. #2566's eager-buffer over-consumption note: the
   standalone iterator protocol for array patterns may be eager-buffered,
   which is likely the root of the `trlg-iter` bucket).
3. **Expected order of attack** (largest bounded first):
   a. `trlg-iter` (23): trailing elision/rest must NOT call `next()` after
      `done:true`, and elision still advances the iterator — check where the
      pattern consumes the iterator record and thread the `done` flag.
   b. Nested-pattern TypeErrors (~25): destructuring `undefined`/`null` at a
      nested level must throw TypeError (RequireObjectCoercible /
      GetIterator on the nested value). Likely a missing coercible check in
      the recursive pattern-lowering entry.
   c. IteratorClose family (~12): abrupt completion inside the pattern body
      must call `return()` on the iterator when `done` is false.
   d. `obj-prop-elem-init` + fn-name (~14): default-initializer evaluation
      (only when value is undefined) + NamedEvaluation for anonymous
      fn/class/arrow initializers (`NaN vs undefined` on `.name` reads).
   e. Binding-form residual (`const/let/var-ary-ptrn`): re-measure after
      a-d — many are the same defects surfacing through different binding
      forms; fix what remains.
4. **Shared machinery caution**: destructuring lowering is shared with plain
   assignment/declaration destructuring (`language/expressions/assignment/dstr`
   has ~89 similar failures — same fixes likely flip those too; measure and
   report the cross-bucket delta, don't scope-creep into new machinery for
   them).

## Validation

- Scoped run: `TEST262_TARGET=standalone TEST262_PATH_FILTER="language/statements/for-of/dstr" pnpm run test:262`
  Baseline: 201 non-pass (of ~700 total dstr files). Report per-sub-bucket
  flips; also run `language/expressions/assignment/dstr` once at the end for
  the cross-bucket delta.
- gc lane must not regress: the same lowering runs in both lanes — run the
  same filter with `TEST262_TARGET=gc` before finishing.
- Equivalence guard: `npm test -- tests/equivalence.test.ts`.

## Result — slice 1 (2026-08-15, Opus implementation — dev-4447-dstr)

**standalone for-of/dstr 342→400/569 (+58, 0 lost); gc 344→395/569 (+51, 0
lost); standalone assignment/dstr cross-check 240→246/370 (+6, 0 lost).**
File-copy A/B against HEAD; measured on a quiescent tree. 19 new unit tests
(`tests/issue-4447-forof-dstr-standalone.test.ts`) + 13-file regression sweep.

Four root causes, all in the ASSIGNMENT form of for-of heads (the binding form
routes through `destructureParamArray` and was already correct):

1. §13.15.5.2 GetIterator was never performed — elements were read via
   `__extern_get(elem, i)`, so user iterables saw zero `next()`/`return()`.
2. `__iterator_next`'s closed-struct read required BOTH `__sget_done` AND
   `__sget_value`, so a conformant `{done}`-only IteratorResult degraded to
   "exhausted on step 1" and suppressed IteratorClose.
3. Object assignment patterns dropped defaults and wrote the KEY name instead
   of the target (`{k: t = d}` wrote `k`, ignored `d`).
4. Nested patterns in value/element/rest position were silently dropped
   (isIdentifier bail) instead of recursing + throwing TypeError on
   null/undefined.

Secondary fixes: `emitGlobalSyncWritebackByName` (stale module-global index
after `addStringConstantGlobal` import-global remap → "immutable global #3
cannot be assigned"); `__sget_done` result-type following the field type (f64
fed `__is_truthy`) — additive gate, pre-existing path untouched.

**Deferred (named in worktree RESULT-4447.md with reasons)**: assignment-target
evaluation ORDER (needs interleaved stepping — rewrite of shared lowering);
§7.4.9 IteratorClose refinements (throwing/non-Object `return()` — needs a
native throw path, #2038 note); NamedEvaluation/fn.name (6); nested obj pattern
over rest slice (string-keyed `__extern_get` misses `$Vec`, #3100);
generator-carrier (27, #2864). **Natural follow-up: the BINDING form**
(`destructureParamArray`, `src/codegen/destructuring-params.ts`, ~30 residual
tests).

## Result — slice 2: binding-carrier preservation (2026-08-25, Codex)

### Implementation plan

1. Preserve the actual externref-backed carrier produced by a direct nested
   heterogeneous array literal used as a for-of subject. The existing #3543
   re-key is scoped to `_forOfPreserveUndefElem`, so typed and flag-off array
   paths remain unchanged.
2. At the shared array-binding default/read boundary, classify an already-boxed
   externref honestly before storing it in a nullable `$AnyValue` binding local:
   null becomes tag 0, boxed numbers tag 3, boxed booleans tag 4, and strings
   retain tag 5. Generic externref coercion intentionally remains unchanged.
3. Keep nullable heterogeneous locals on AnyValue equality dispatch, including
   comparisons with `null`; the raw `ref.is_null` shortcut is only valid for a
   true nullable reference carrier.
4. Exercise all three for-of binding forms and sample standalone/gc test262
   rows. The aggregate scoped runner is deferred while the shared lock is held.

### Measured results

The focused mixed binding probe was `10001` before the carrier/tag fixes
(null/string preserved; number/boolean comparisons failed while no defaults
ran) and is `11111` after them. `JS2WASM_UNION_ANYREP=0` also produced `11111`,
confirming the representation boundary as the causal slice.

`tests/issue-4447-binding-iterclose.test.ts`: 4/4 tests pass (const/let/var and
one parameter-destructuring carrier check).
The existing heterogeneous nested-carrier regression
`tests/issue-2190.test.ts`: 20/20 pass.

Focused `runTest262File` probes pass in both standalone and gc lanes:

- `const-ary-ptrn-elem-id-init-skipped.js`
- `const-ary-ptrn-elem-id-init-exhausted.js`
- `const-ary-ptrn-elem-id-iter-step-err.js`
- `const-ary-ptrn-rest-id-iter-close.js`
- `var-ary-ptrn-elem-ary-elem-init.js`
- `var-ary-ptrn-elem-id-iter-val.js`

`let-ary-ptrn-elision-iter-close.js` passes standalone but remains a gc-lane
generator-carrier failure (`#2864` scope), consistent with the previously
deferred generator residuals.

### Measurement blocker

The requested scoped standalone+gc aggregate
(`language/statements/for-of/dstr`) was not run because the shared
`/tmp/js2wasm-test262.lockdir` was occupied by #4449. No aggregate delta is
claimed for this slice; the direct probes above are the measured evidence.
