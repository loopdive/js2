---
id: 820
title: "Nullish TypeError / null-pointer / illegal-cast umbrella (6,993 FAIL)"
status: ready
created: 2026-03-28
updated: 2026-04-09
priority: critical
feasibility: hard
reasoning_effort: max
goal: async-model
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
