---
id: 2171
title: "standalone: native generator only supports numeric yields — string/boolean/object yields bail (#680)"
status: done
completed: 2026-06-17
assignee: sendev-closures
sprint: 63
created: 2026-06-15
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: iterators-generators
goal: standalone-mode
parent: 2157
depends_on: [2079]
related: [2072]
---

# #2171 — non-numeric yields (SF-4 of #2157)

## Problem

```ts
function* g(){ yield "a"; yield "b"; }   // standalone: #680 CE
```

The native generator state struct spills and the result value slot are typed
f64; non-numeric yields bail to the #680 diagnostic.

## Fix direction

Widen the generator result `value` slot (and any non-numeric spilled locals) to
a boxed representation (native `$AnyString` / `anyref` / `externref` per the
declared yield type), and make the for-of / `next()` value extraction unbox by
the static element type. Coordinate with the value-rep work (#2072 family) so
the boxing/unboxing tags are consistent across the AnyValue helpers.

## Acceptance criteria

- `tests/issue-2157-*.test.ts` SF-4 `it.todo` passes, zero host imports.
- Mixed-type yields (`yield 1; yield "a";`) iterate with correct values.

## Source

Triage of #2157 (2026-06-15, sdev5), SF-4.

## Implementation spec (2026-06-15, sdev5) — de-risked, dispatch-ready

> Investigated against current main (`39a63edf0`, post-#2079/#2157/#2172). Key
> finding that makes this tractable: **every consumer of the generator result
> reads `info.resultTypeIdx` (per-generator), never a hardcoded singleton.** A
> grep for `nativeGeneratorResultTypeIdx` / `RESULT_VALUE_FIELD` outside
> `generators-native.ts` is empty — the for-of driver, `.next()` dispatch
> (`tryCompileNativeGeneratorResultProperty`), and the #2169 consumers
> (`emitNativeGeneratorToVec`, spread, Array.from) all thread `info.resultTypeIdx`
> + `RESULT_VALUE_FIELD`. So a **per-generator result type keyed on the yield
> element ValType** is a localized change; the numeric path stays byte-identical.

### Representation decision

Add a generator-level **`elemValType: ValType`** (default `{kind:"f64"}`). For a
generator whose yields are *uniformly* one supported non-numeric type, set it to
that type's ValType:
- all-string yields → `nativeStringType(ctx)` (the `$AnyString` ref) in
  nativeStrings/standalone mode;
- (future) mixed / object yields → `{kind:"externref"}` boxed via the #2072
  value-rep helpers — **deferred to a follow-up**; this slice does strings only.

The result struct and the state struct's value-carrying fields (`sent`,
`abrupt`, and the per-yield value) are typed `elemValType` instead of f64. The
result struct name becomes `__NativeGeneratorResult_<kind>` (e.g. `_anystr`) so
numeric and string generators get distinct cached types.

### Change sites (all in `src/codegen/generators-native.ts` unless noted)

1. **`isNumericExpression` → `yieldElemType(ctx, decl): ValType | null`** (line
   97). Walk the generator's yield expressions; if all are numeric → f64; if all
   are native-string → `$AnyString`; mixed / unsupported → null (→ existing
   `fail()` bail). Thread the chosen type through `buildNativeGeneratorPlan`.
   Replace the 6 `isNumericExpression(...) return fail()` sites (lines 261, 350,
   387, 434, 469, 523) with a check against the generator-wide elem type
   (a yield whose type disagrees with the generator's elem type → fail).
2. **`ensureNativeGeneratorResultType(ctx, elemValType)`** (line 691). Key the
   cache + struct name by elem kind; `value` field type = `elemValType`.
3. **`registerNativeGenerator`** (line 712). Compute `elemValType` from the plan,
   store on `info`; type `sent`/`abrupt` state fields + non-numeric spills as
   `elemValType` (string spills → the string ref). `spillFieldOffset` math
   unchanged.
4. **Yield terminator emission** (the `yield(next)` state lowering ~line 830–1070)
   — compile the yield expression to `elemValType` (no `f64.const` default);
   `emptyResultForType` / abrupt completions use the elem type's null/default
   (`ref.null` for string, `f64.const NaN` for numeric).
5. **`compileNativeGeneratorFunction`** (line 1197) — the initial state-struct
   build's spill defaults must match `elemValType`.
6. **`tryCompileNativeGeneratorResultProperty`** (line ~1457) and the **for-of
   driver** (`tryCompileNativeGeneratorForOf`) — the loop var / `.value` read
   type is `info.elemValType` (string ref vs f64), not hardcoded f64.
   `emitNativeGeneratorToVec` (#2169) — build a vec of `info.elemValType`
   instead of always f64.

### Scope guard / acceptance

- This slice: **uniformly-numeric** (unchanged) and **uniformly-native-string**
  generators. `tests/issue-2157-*.test.ts` SF-4 (`yield "a"; yield "b"`) passes,
  zero host imports.
- **Mixed-type** (`yield 1; yield "a"`) and **object/boolean** yields → still
  `fail()` cleanly (no crash); a follow-up generalizes to an `externref`/AnyValue
  value field using the #2072 boxing. Note that in the issue.
- No regression on the numeric path (the result type is now per-elem-kind; the
  f64 generators keep `__NativeGeneratorResult_f64`).
- Re-run `issue-2079`, `issue-1665`, `issue-2172`, `issue-2169-*` suites — all
  must stay green.

### Why spec-not-impl from this session (sdev5)

The change is a representation change that ripples through the exact
generator-result code path that PRs #1492 (#2172 nested-gen) and #1493 (#2169
Array.from) are actively landing through the merge queue this session. Starting
it mid-flight risks a hard-to-debug interaction with those in-queue PRs (the
shared `info.resultTypeIdx` they read). The spec is de-risked (the per-generator
result-type finding is the crux and is confirmed), so the next dev — or me once
#1492/#1493 land — can implement the string slice in one focused pass.

## Resolution (2026-06-17)

**Implemented and merged** in `c3eb18936` ("feat(#2171): string-yield native
generators in standalone (SF-4 of #2157)"), exactly per the spec above:
`generatorElemValType` / `isStringYieldExpression` choose a per-generator
`elemValType` (f64 for numeric, the native `$AnyString` ref for all-string
generators); `ensureNativeGeneratorResultType` keys the result struct
(`__NativeGeneratorResult_<kind>`) and value field on the elem type; the resume
function, state-struct spills, and the for-of driver
(`tryCompileNativeGeneratorForOf`) all thread `info.elemValType`. Mixed/object
yields still `fail()` cleanly (numeric path byte-identical).

The issue file's `status` was left at `ready` (the impl commit didn't flip it).
Reconciled to `done` here, and the SF-4 acceptance test was promoted from
`it.todo` to a live test (+ two value-correctness guards: concat length, first
char code). Verified on `upstream/main`: SF-4 string yields iterate 2× with zero
host imports, and `s += v` concatenation produces the correct `$AnyString`
(`"ab"`, length 2, first char `'a'`).

### Known residual → follow-up #2187

A **per-element string method on an `any`-typed loop variable** in standalone
(e.g. `for (const v of g()) n += v.length` where TS infers `v: any` because no
lib types resolve the generator's element type) routes through the generic
externref property path instead of the native `$AnyString` path, yielding `0`.
The loop var's *local ValType* is the string ref, but `compilePropertyAccess`
gates the native-string `.length`/method fast-path on the *TS static type*
(`isStringType(tsObjType)`), which is `any` here. This is the broader value-rep
concern (#2072 family) — string-method dispatch keyed on local ValType when the
TS type is `any` — not specific to generators. Tracked as #2187; out of scope
for SF-4 (whose acceptance is iteration + concat, both correct).
