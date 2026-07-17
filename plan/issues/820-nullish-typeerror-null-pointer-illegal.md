---
id: 820
title: "Nullish TypeError / null-pointer / illegal-cast umbrella (6,993 FAIL)"
status: in-progress
assignee: sd-4
created: 2026-03-28
updated: 2026-06-21
priority: critical
feasibility: hard
model: fable
reasoning_effort: max
goal: async-model
sprint: 64
test262_fail: 6993
---
# #820 -- Nullish TypeError / null-pointer / illegal-cast umbrella (6,993 FAIL)

## Problem

This umbrella is still real, but the old framing is stale. In the latest full
official run `20260407-111308`, the bucket is not one uniform
"null/undefined access" family. It currently contains three distinct runtime
failure classes:

- `5,962` `TypeError (null/undefined access)`
- `606` `dereferencing a null pointer`
- `425` `illegal cast`

Total: **6,993 FAIL**

These failures are spread across property access, receiver validation,
arguments-object setup, class/private-member lowering, eval/direct-eval paths,
and built-in receiver coercion. The umbrella remains useful, but concrete work
should happen in narrower children.

### History
- 2026-03-28 (initial in-progress analysis): `7,032`
- 2026-03-28 (older full run): `6,077`
- 2026-04-07 (latest full official run): `6,993`

### Current split by failure kind

| Kind | Count | Notes |
|------|-------|-------|
| `TypeError (null/undefined access)` | `5,962` | Still the largest family; now concentrated in property/receiver semantics |
| `dereferencing a null pointer` | `606` | Lower-level runtime trap family, often in eval/arguments/object setup paths |
| `illegal cast` | `425` | Wrong-ref-shape / receiver-cast family, especially expressions and arrays |

### Current category distribution (latest run)

| Category | Count |
|----------|-------|
| `language/expressions` | `1,299` |
| `language/statements` | `1,095` |
| `built-ins/Array` | `594` |
| `built-ins/TypedArray` | `536` |
| `built-ins/Object` | `478` |
| `built-ins/String` | `250` |
| `built-ins/RegExp` | `246` |
| `annexB/language` | `210` |
| `built-ins/Date` | `194` |
| `built-ins/Promise` | `182` |
| `built-ins/Iterator` | `174` |
| `language/eval-code` | `152` |
| `built-ins/DataView` | `137` |
| `built-ins/TypedArrayConstructors` | `126` |
| `built-ins/Proxy` | `107` |

### Common patterns

| Pattern | Count |
|---------|-------|
| Class / private-member / method-as-value access still collapses to wrong ref shape | large residual |
| Built-in prototype methods called on wrong receivers still trap or cast-fail | large residual |
| TypedArray / DataView / iterator receiver validation remains incomplete | large residual |
| Direct eval / arguments-object interactions still hit null-pointer paths | concentrated residual |
| Object.defineProperty / descriptor boxing remains a concrete child issue | tracked in `#929` |

## Root causes

1. **Receiver validation and method-as-value lowering** -- property access and method extraction still over-assume WasmGC object shapes in many paths.
2. **Class/private-member access shape mismatches** -- static/private/class-element lowering still feeds wrong references into later property access or call paths.
3. **Arguments/eval/object-setup null paths** -- some runtime objects are still missing or built with the wrong shape in eval-heavy and arguments-object-heavy tests.
4. **Built-in receiver coercion gaps** -- Arrays, TypedArrays, DataView, Date, RegExp, Iterator, and Promise built-ins still diverge on non-happy-path receivers.
5. **Descriptor / reflection boxing gaps** -- some object reflection APIs still expose raw WasmGC assumptions instead of JS-visible behavior.

## Sub-issues

- #778 (done): Guard ref.cast with ref.test to prevent illegal cast traps
- #789 (done): Null guard only throws TypeError for genuinely null refs
- #825: null-deref umbrella follow-up
- #826: illegal-cast umbrella follow-up
- #929: `Object.defineProperty called on non-object`
- #983: WasmGC objects leak to JS host as opaque values
- **#1542** (new, ~134 fails): Class method destructured-pattern param default not applied
- **#1543** (new, ~74 fails): Async-generator method with destructured default params throws illegal cast
- **#1544** (new, ~45 fails): for-of / for-await-of destructuring of iterator results throws illegal cast

## 2026-05-20 Architect re-analysis

Latest baseline (`benchmarks/results/test262-current.jsonl`, run 2026-05-20):
filtering official tests only, the matching FAIL count is **3,009**, not 6,993
as the issue header states. The original 6,993 figure was from
`20260407-111308` and included `built-ins/Temporal/*` (now correctly scoped as
`proposal`, not `scope_official`). Temporal/* contributes ≈700+ fails that
look identical (`Cannot read properties of null (reading 'since' | 'until' |
'subtract' | 'round' | 'equals' | 'with' | 'total')`) — these are
**feature-incompleteness**, not codegen bugs; tracked separately under the
Temporal proposal scope. They should NOT be addressed in this umbrella.

Of the 3,009 official fails, the actionable concentrations:

| Cluster | Count | Sub-issue |
|---------|-------|-----------|
| Class method dstr default param not applied | ~134 | **#1542** |
| Async-gen-meth dstr default → illegal cast | ~74 | **#1543** |
| for-of / for-await-of dstr → illegal cast | ~45 | **#1544** |
| RegExp Symbol.replace/match/search/matchAll null deref | ~90 | (next sub-issue — see below) |
| Object accessor-name computed (hex-escape etc) null deref | ~22 | (next sub-issue) |
| Function.prototype.bind / Symbol.hasInstance null deref | ~8 | (long-tail) |
| eval-code/direct arguments interaction | ~20 | known umbrella, narrow |
| Generic `Cannot access property on null or undefined` | ~80 | long-tail; needs per-site analysis |

**Total addressable via the three new sub-issues: ~253 fails** (~8.4% of the
official umbrella).

### Additional sub-clusters not yet ticketed

Two further high-value clusters are documented here for follow-up sub-issues:

#### RegExp Symbol.replace / Symbol.match / Symbol.search null deref (~90)

Tests under `built-ins/RegExp/prototype/Symbol.replace/`,
`Symbol.match/`, `Symbol.search/`, `Symbol.matchAll/`, plus
`RegExpStringIteratorPrototype/next/` produce `L41:3 dereferencing a null
pointer` and `L55:3 dereferencing a null pointer` deep inside the
`Symbol.replace`/`Symbol.match` implementation.

Likely root cause: the RegExp builtins (in `src/codegen/builtins/regexp.ts` or
the dual regex backend `#682`) return `null` for "no match" but downstream
code that consumes the result (substitution helper, iterator) does not
re-check for null before reading `.index` or `.length` fields. Audit the
match-result consumption paths in the JS-host regex backend.

#### Object accessor-name computed-property string-escape (~22)

Tests under `language/expressions/object/accessor-name-*` exercise
computed accessor names that use string escapes (`'hex\x45scape'`, numeric
literals coerced to strings, etc). The `L55:3 dereferencing a null pointer`
fires inside the accessor lookup path, suggesting the object-literal
emission writes the accessor under one key while the lookup resolves under
the unescaped form. Audit:
- `src/codegen/literals.ts` accessor-property emission (search
  `getAccessor`/`setAccessor`)
- `src/codegen/property-access.ts` string-key normalisation

Both can be filed as additional sub-issues when bandwidth allows; specs are
mechanical follow-ups.

## Acceptance criteria

- reduce the combined umbrella materially from current `3,009` official fails
- keep the umbrella analytical: concrete fixes should land in narrower child issues
- no regressions in pass count
- close (or downgrade priority of) the umbrella once #1542, #1543, #1544 land
  and the residual is < 500 fails

## 2026-05-21 Senior-dev re-analysis (sendev-820)

Re-bucketed against `benchmarks/results/test262-current.jsonl` (run
20.5.2026 18:11:55). Official fails in the umbrella's three `error_category`
buckets are now:

| `error_category` | Count |
|------------------|-------|
| `null_deref`     | `569` |
| `type_error`     | `508` |
| `illegal_cast`   | `241` |
| **umbrella total** | **`1,318`** |

(The `5,962` "TypeError (null/undefined access)" header figure was from an
older runner schema that included generic `assertion_fail` rows with
"Cannot access property..." messages. Latest runner correctly buckets
the deref TypeErrors under `type_error`.)

Three new tractable sub-issues filed in `plan/issues/sprints/53/`:

| Sub-issue | Title | Est fails | Feasibility |
|-----------|-------|-----------|-------------|
| **#820a** | RegExp Symbol.match/replace/search/matchAll + RegExpStringIterator null deref | ~148 | medium |
| **#820b** | Object literal computed-property accessor names silently dropped | ~30 | **easy (implemented)** |
| **#820c** | Async-gen object-method `yield*` iterator-protocol null deref | ~39 | medium-hard |

Total addressable via these three: ~217 fails (~16% of the umbrella).

## 2026-05-28 Triage update (dev-1655-2)

Re-bucketed against `.test262-cache/test262-current.jsonl` (2026-05-25
baseline, 3 days post sprint-53 close). Umbrella now **868 fails total**
(was 1318 on 2026-05-21 — **−450 reduction** over sprint-53 #820a/b/d/h/j/k +
#1542/#1543/#1544/#1568/#779e/#1129/#1525/#1607/#1638 etc).

Two new untracked sub-buckets carved:

| Sub-issue | Title | Est fails | Feasibility |
|-----------|-------|-----------|-------------|
| **#820l** | `arguments` object: extra positional args beyond declared formals not retained | ~61 | medium |
| **#820m** | NamedEvaluation: `fn-name-class` + `__proto__-fn-name` (object literal + assignment) | ~12 | easy-medium |

Plus a meta status doc:

| Doc | Title |
|-----|-------|
| **#820n** | Umbrella status 2026-05-28: recommendation to close umbrella post-#820l/#820m |

#820n documents the residual ~793-fail decomposition (overlaps with active
in-flight work: #1610, #1633, #1347b, #1620-v2, #1640, #779d, #1605) and
out-of-scope features (`new Function(...)`, dynamic-import `_FIXTURE.js`,
Iterator-helpers proposal).

**#820b** has been implemented on branch `sendev-820-investigation`
(`src/codegen/literals.ts` — adds `resolveAccessorPropName` helper to handle
`ts.ComputedPropertyName` wrapping a string/numeric/no-substitution-template
literal in the accessor pre-pass and emission loop). Test added at
`tests/issue-820b.test.ts`. Local test execution blocked by a stale
fakeowner mount on `/workspace`; needs to be run via CI after merge of the
PR.

**Top residual clusters (not yet ticketed, all >25 fails):**

- ~64 `annexB/language/.../global-existing-non-enumerable-global-init` —
  `TypeError: Object.defineProperty called on non-object`. Likely already
  tracked under #929; verify scope.
- ~57 `Cannot destructure 'null' or 'undefined' [in C_method() ← test]` —
  class-method destructuring where the argument is null/undefined; partial
  overlap with #1543/#1544 residuals.
- ~46 `dereferencing a null pointer [in fn() ← test]` in `for-await-of`
  dstr — close cousin of #1544.
- ~25 `Cannot access property on null or undefined` (no line info) — built-ins
  Proxy/get + language eval-code residuals.

## Implementation Plan

(Author: architect, 2026-05-21. #820 is an umbrella, not a single
codegen change. The plan is to drive the sub-issues to completion
rather than write umbrella code. This section names the work items
and the dispatch order.)

### No direct entry point

#820 itself has no code to write. Each sub-issue has (or needs) its
own Implementation Plan:

| Sub-issue | Title | Plan? | Priority |
|-----------|-------|-------|----------|
| #1542 | Class method dstr default param not applied (~134) | needs plan | 1 |
| #1543 | Async-gen-meth dstr default → illegal cast (~74) | needs plan | 2 |
| #1544 | for-of / for-await-of dstr → illegal cast (~45) | needs plan | 3 |
| #820a | RegExp Symbol.* + RegExpStringIterator null deref (~148) | needs plan | 4 |
| #820b | Object literal computed-prop accessor names (~30) | done (merged) | — |
| #820c | Async-gen `yield*` iterator-protocol null deref (~39) | needs plan | 5 |

### Dispatch order

1. #1542 first — largest single cluster, mechanical destructuring
   fix in `src/codegen/destructuring-params.ts`.
2. #820a second — RegExp Symbol.* surgery is contained in
   `src/codegen/builtins/regexp.ts` and runtime.ts match-result
   paths; medium feasibility.
3. #1543/#1544 together — both touch async-gen + dstr lowering, so
   one dev should pick them up to amortise context.
4. #820c last — depends on async-iteration correctness work in #735.

### Residual cluster triage

After the six sub-issues land, re-bucket the umbrella. The remaining
~370 official fails split predictably:

- **~64** AnnexB global-init `Object.defineProperty on non-object`
  → already #929; verify no double-counting with #983/#1129.
- **~57** Class-method destructure of null/undefined → file as
  `#1547` follow-up under #1542 once #1542 lands; the residual is
  the *outer* null/undefined arg, not the inner default-param case.
- **~46** for-await-of dstr null deref → file as `#1548` follow-up
  under #1544.
- **~25** Proxy/eval long-tail → file individually as found, do not
  bundle.

### Acceptance for closing umbrella

Per the existing acceptance criteria: residual <500 official fails
AND #1542/#1543/#1544/#820a/#820c all merged. Estimated post-work
residual: ~280 fails. Close umbrella, downgrade tracking to
individual sub-issues.

### Dependencies

- #1542/#1543/#1544 — independent, dispatchable in parallel.
- #820a — independent of all of the above.
- #820c — soft-blocks on #735 (async-iteration correctness).
- #983 — separate umbrella; do not co-mingle.

### Risks

- **Double-counting**: bucket counts may overlap across sub-issues.
  The senior-dev re-bucket on 2026-05-21 should be the authoritative
  baseline; re-bucket after each sub-issue lands.
- **Temporal contamination**: ensure all baselines filter
  `proposal:` scopes out — Temporal contributes 700+ similar-looking
  null derefs that are not codegen bugs.

## 2026-06-21 sd-4 — async-gen-meth-dflt-* illegal-cast cluster fixed (PR pending)

Re-bucketed against the fresh baseline (`.test262-cache/test262-current.jsonl`,
run 2026-06-20): umbrella now **680 official fails** (null_deref 211 /
type_error 248 / illegal_cast 221). The single largest concrete `illegal_cast`
cluster was the **100-file `async-gen-meth-dflt-*` family** (all 50 unique
`dflt`-template variants × static/non-static × statements/expressions), every
one failing with `illegal cast in __closure_3/4()` *before* the test's intended
error path could run.

**Root cause (deeper than #1543's destructure-default theory):** the failure
is in the **inline dynamic call dispatcher**, `tryEmitInlineDynamicCall` in
`src/codegen/expressions/calls.ts`. An async-generator method extracted as a
value (`var m = C.prototype.method; m()`) is wrapped into a closure struct and
called through this dispatcher. Two defects:

1. **Struct-typed `ref.test` over-matched across arities.** Every `__fn_wrap_*`
   wrapper struct subtypes a single *root* wrapper
   (`getOrCreateFuncRefWrapperTypes`, closures.ts:3270). So
   `ref.test (ref <root-wrapper-struct>)` is TRUE for wrapper values of *every*
   arity. A 0-arg call to a 1-formal method matched an arity-0 dispatch arm,
   did `struct.get 0` + `ref.cast (ref <arity-0 funcType>)` on the arity-1
   funcref → **`illegal cast`**.
2. **No arity adaptation.** Candidates were filtered to *exact* arity, so a
   0-arg call to a 1-formal method found no candidate and silently returned
   `undefined` instead of invoking the method (which must apply its default
   param and run the spec-mandated destructure).

**Fix:** discriminate by the **funcref signature** (`ref.test (ref funcTypeIdx)`
on field 0 — encodes the exact param count + result, so each arm fires only for
its own signature regardless of struct subtyping), and accept candidates with
`paramTypes.length >= arity`, padding missing trailing args with `undefined`.

**Result:** 96/100 of the cluster now pass; 0 regressions in a 160-file
previously-passing sample (dstr / closure / default-param families), 0 new
hard errors, stack-balance gate OK. The directly-affected `issue-1063` /
`issue-1712-dynamic-dispatch` unit tests stay green. Regression test:
`tests/issue-820-async-gen-dstr-default-dispatch.test.ts`.

**Residual carved to #2569:** the 4 `…-dflt-obj-ptrn-prop-eval-err` variants
(`{ [thrower()]: x }`) — a distinct, orthogonal defect: a **computed property
key in a destructuring pattern is not evaluated**, so the throwing key never
fires. See `plan/issues/2569-computed-key-dstr-pattern-not-evaluated.md`.
