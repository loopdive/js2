---
id: 1914
title: "standalone RegExp native-engine reflection, constructor, prototype, and result-shape gaps"
status: done
completed: 2026-06-10
sprint: 61
model: fable
created: 2026-06-07
updated: 2026-06-10
priority: critical
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: regexp
goal: standalone-mode
related: [1909, 682, 1474, 1539, 1905]
test262_bucket: standalone-regexp-native-engine
test262_count: 546
---

# #1914 — Standalone RegExp native-engine and reflection gaps

## Problem

The residual RegExp bucket is not only unsupported pattern syntax. The current
standalone JSONL also includes assertion/runtime failures and object/prototype
access refusals around RegExp reflection, constructor forms, result shape, and
legacy static properties.

Representative signatures from the 2026-06-07 standalone JSONL:

- `assert.sameValue(pattern.source, ...)`.
- `assert.sameValue(__executed.input, __expected.input, ...)`.
- `assert.sameValue(__executed.index, __expected.index, ...)`.
- `dynamic constructor patterns`.
- `__get_builtin` dynamic-shape object/property refusals in RegExp prototype
  and accessor tests.
- `Cannot convert object to primitive value` in RegExp literal/prototype tests.

## Scope

- Split true RegExp runtime/result-shape failures from object-runtime
  classifier overlap.
- Fix the smallest native-engine/reflection slice if one is contained, such as
  `.source` fidelity or result `index/input` fields.
- Coordinate object/prototype value reads with #1905 where the root cause is
  generic standalone object dispatch rather than RegExp-specific behavior.

## Acceptance Criteria

- Representative assertion/runtime RegExp rows leave
  `standalone-regexp-native-engine` or are reclassified to a better owner.
- At least one native-engine/reflection residual gets a focused standalone
  regression test when implemented.
- The classifier no longer hides these failures under completed #682/#1474
  umbrellas.

## Implementation Notes (fable-rx-surface, 2026-06-10)

Landed in PR (branch `issue-1914-regexp-reflection`). Five coordinated changes —
the WHY for each:

1. **`$NativeRegExp` field 5 `lastIndex: f64 (mut)` + spec-escaped `source`**
   (`src/codegen/regexp-standalone.ts`). `[[LastIndex]]` (§22.2.7.1) is a plain
   writable property, so it must live on the struct, not be synthesized.
   `source` is stored pre-escaped via a compile-time `escapeRegExpPattern`
   (§22.2.6.13.1: empty → `(?:)`, unescaped `/` → `\/`, LineTerminators →
   escape sequences) so the getter is a bare `struct.get`. Patterns are always
   static in standalone, so escaping at compile time is exact. The g/y exec
   semantics that *mutate* lastIndex are #1913 (field is groundwork).

2. **Match-result shape = `$__regexp_match_vec`, a WasmGC SUBTYPE of the nstr
   vec** (`src/codegen/native-regex.ts ensureRegexMatchVecType`). Fields
   `{length, data}` (inherited, mutability-invariant) + immutable `index: i32`,
   `input: ref $AnyString` per §22.2.7.2 RegExpBuiltinExec. Subtyping — not a
   sibling struct — is load-bearing: every existing vec consumer (indexing,
   `.length`, iteration) keeps working by subsumption; only `.index`/`.input`
   property reads need the extra fields. `__regex_capture_array` populates
   `index` from `caps[0]` and `input` from the flattened subject.

3. **Reflection routing** (`src/codegen/property-access.ts` →
   `tryCompileStandaloneRegExpPropertyRead` / `tryCompileStandaloneRegExpMatchResultRead`
   in regexp-standalone.ts; lastIndex writes in `expressions/assignment.ts`).
   Must intercept BEFORE the extern-class path: that path emitted
   `env.RegExp_get_global` etc. — the standalone purity leak this issue's
   acceptance criteria name. The import scan in `src/codegen/index.ts` is gated
   with the same `STANDALONE_REGEXP_REFLECTION_PROPS` set so the two sides
   can never drift (a prop handled natively never pre-registers a host import;
   a prop NOT in the set keeps the refusing extern path).

4. **Module-global typing for `var m = re.exec(s)`**
   (`src/codegen/declarations.ts` + `inferStandaloneRegExpMatchGlobalType`).
   Without it the global widens to externref and `m[0]` round-trips through
   the native `__extern_get_idx`, which only recognises the open-object
   `$ObjVec` → returns null → `__str_flatten(null)` traps (the
   `null_deref __str_flatten` bucket, 42 rows). The precise type is only
   applied when EVERY write to the var in the file is a backend exec/match
   call or null/undefined — any foreign write keeps the externref widening so
   the global type can never reject a store. `compileElementAccessBody`'s
   vec-struct predicate was widened to accept the 4-field match-vec shape.

5. **Any-boundary string equality** (`src/codegen/binary-ops.ts`, two sites).
   The S15 tests assert through the harness (`isSameValue(a:any,b:any)` and
   `assert_sameValue_str(actual:any, expected:string)`), and BOTH equality
   paths compared native strings by `ref.eq` identity — so even
   `"a" === "a"` was false across the `any` boundary (every literal is a
   fresh struct). Added a string-content arm (ref.test $AnyString both →
   flatten + `__str_equals`) to (a) the #1776 standalone tag-dispatch chain
   and (b) the #1395 mixed ref+externref strict-equality bridge (gated on
   `ctx.nativeStrings`). §7.2.16 "If x is a String" requires value
   comparison. This is the gateway for the whole assertion family — without
   it zero sameValue-based string tests can pass standalone (overlaps the
   #1908 isSameValue residual bucket; noted there).

### Validation

- `tests/issue-1914.test.ts` — 11 focused tests, all green, each asserting
  zero `env.*` imports in the standalone binary.
- 10/10 sampled rows from the 130-row `__executed.index/.input` cluster now
  PASS through the real wrapTest harness (S15.10.2.3/5/6/7/8/13 families).
- Targeted equivalence files (equality-mixed-types, loose-equality,
  strict-equality-edge-cases, regexp-methods, string-methods, …, 132 tests)
  all pass; full-suite local failures (60) are all under the 100-entry
  known-failures baseline (CI equivalence gate is authoritative).

### Out of scope / residuals

- `dynamic constructor patterns` (55 rows) need runtime pattern compilation —
  the bytecode compiler runs at TS compile time; engine-side design (#1911/#1912 lane).
- `RegExp.prototype` built-in static property VALUE reads (~183 rows) are the
  #1907/#1888 S6-b built-ins-as-static-globals layer, not RegExp-specific.
- `.groups` (undefined unless named groups — engine refuses named groups, so
  reads would be spec-correct `undefined`) deferred until named-group support.
- g/y `lastIndex` exec semantics, matchAll, split limit/captures, $-substitution
  and function replacers → #1913.

