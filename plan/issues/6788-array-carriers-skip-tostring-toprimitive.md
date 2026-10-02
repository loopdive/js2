---
id: 6788
title: "codegen: array carriers skip ToPrimitive/ToString — `String(numArr)` returns the array, `[] + []` is `NaN`, `+[]` is `NaN`, `Number([5])` is `NaN`"
status: done
sprint: Backlog
created: 2026-09-30
updated: 2026-10-01
completed: 2026-10-01
assignee: "ttraenkler/claude-dev-6788"
branch: "claude/issue-6788-array-carrier-toprimitive"
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: to-primitive
goal: core-semantics
related: [1319, 1090, 1253, 4564, 1215]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — H4/H6"
loc-budget-allow:
  # 2026-10-01: one import + a 3-line dispatch into host-carrier-to-primitive.ts
  # (the logic lives in that new module, not in the god-file).
  - src/codegen/binary-ops.ts
func-budget-allow:
  # 2026-10-01: the `+`/relational/`==` array-carrier arm must run before the
  # string arms of compileBinaryExpression, so its 3-line dispatch lives there.
  - src/codegen/binary-ops.ts::compileBinaryExpression
---

# #6788 — the array carrier is not a primitive, but several sites treat it as one

## Problem

Reproduced 2026-09-30 (JS-host lane, diffed against Node):

| source | wasm | JS |
|---|---|---|
| `const arr: number[] = [0,9,0]; const s = String(arr); s === "0,9,0"` | `false`; `JSON.stringify(s)` → `[0,9,0]` (the array itself) | `true` |
| `` `${arr}` `` | the array | `"0,9,0"` |
| `[] + []` | `NaN` | `""` |
| `[] + {}` | `NaN` | `"[object Object]"` |
| `+[]` / `+[1]` | `NaN` / `NaN` | `0` / `1` |
| `Number([5])` | `NaN` | `5` |

`arr + ""` and `arr.toString()` are already correct, so the ToString
machinery exists; it is bypassed at these entry points.

## Root cause

- `String()` host-lane arm: passes the carrier through unchanged. The
  standalone arm (`src/codegen/builtin-ctor-callable.ts:325-340`) does call
  ToString; the host arm does not. (Exact host line not pinned in the review;
  start at the `String` case of the callable-builtin dispatch.)
- Template literal substitution: same pass-through for a statically typed
  array operand.
- `+`, unary `+`, `Number()`: `src/codegen/addition-to-primitive.ts:3` states
  the §13.15.3 rule; `:26` admits the carrier half is partial (#4564). The
  numeric paths call ToNumber on the carrier's boxed form, which yields NaN
  instead of ToNumber(ToPrimitive(arr)) = ToNumber(arr.join()).

## Correction

One `toPrimitiveCarrier(ctx, valType)` helper that, for any array/object
carrier in a primitive-expecting position (`String()`, template substitution,
`+` with a non-string other side, unary `+`, `Number()`, `-`/`*`/relational
after the ToPrimitive step), emits the existing OrdinaryToPrimitive path
(`Symbol.toPrimitive` → `valueOf` → `toString`, #1319) and only then the
numeric/string conversion. Wire the four entry points above to it; leave the
already-correct `arr + ""` path as the reference behaviour.

## Acceptance

- All rows above match Node on the JS-host lane and on `target: "standalone"`.
- Regression file with the rows plus objects with custom `valueOf` /
  `toString` / `Symbol.toPrimitive` in each position.
- test262 `built-ins/String/S15.5.1.1*`, `language/expressions/addition`,
  `language/expressions/unary-plus` deltas reported in the PR (expect gains).

## Implementation Plan

What was built (JS-host lane only; standalone already reduces a vec in-module
via `array-to-primitive.ts`, #2358, and is byte-identical):

1. **New module `src/codegen/host-carrier-to-primitive.ts`** — the one place
   that knows how a JS-host array carrier becomes a primitive.
   - `isHostArrayCarrier(ctx, typeIdx)` — the vec-carrier predicate that
     `coerceType(ref → externref)`'s `__make_iterable` gate used inline; that
     gate now calls it (byte-identical).
   - `emitHostArrayToPrimitive` — OrdinaryToPrimitive of an array is its
     `join(",")` (`valueOf` hands the object back). It reuses the existing
     host element stringifier `__extern_join_str` (the one `arr.join()` /
     `arr.toString()` use, #1998/#3637), which recurses into nested vecs and
     runs the struct walker on object elements. A null reference passes
     through as null. The `__make_iterable` host mirror is deliberately NOT the
     reduction path: it keeps struct elements raw, and a host `join` over a raw
     WasmGC struct throws "Cannot convert object to primitive value".
   - `emitHostArrayCarrierToNumber` — ToNumber = host ToNumber of the join;
     declines the DEFAULT hint (a `+`/`==` that reaches the f64 lowering has
     already skipped its string-vs-number or identity decision, and turning its
     NaN into the join's number would make `[1] == [1]` true).
   - `emitHostCarrierToStringTail` — after a string-hint
     `coerceType(ref → externref)` found no in-Wasm `@@toPrimitive`/`toString`
     (the arm that used to return the object itself): an array yields its join,
     any other struct the host ToString (`__extern_toString`).
   - `hostArrayCarrierBinaryArm` / `emitHostArrayCarrierBinary` — for `+`,
     relational and loose `==` with an operand whose `ctx.oracle` fact is an
     array: evaluate BOTH operands first, then replace each array carrier by
     its join and finish with the existing host operator (`__host_add`,
     `__host_compare`, `__host_loose_eq`). Loose `==` against another object is
     identity (`ref.eq`, or the host strict equality when an operand is already
     externref) — §7.2.15 step 1, no ToPrimitive. Excluded: `any`/`unknown`,
     string, bigint operands (their existing arms already apply — notably
     `arr + ""`, the reference spelling) and `arr == null`.
2. **Wiring** (four call sites, no other behaviour change):
   - `type-coercion.ts` ref→externref arm: string-hint tail, then the shared
     predicate for the mirror gate → fixes `String(arr)`, template spans,
     `String.raw` substitutions.
   - `runtime-ref-number.ts` `tryRuntimeRefToNumber`: the vec arm → fixes unary
     `+`/`-`, `Number()`, `-`/`*`/`**`/bitwise, `isNaN`, `Math.*` arguments.
   - `binary-ops.ts` `compileBinaryExpression`: the binary arm, placed right
     after the standalone object-addition arm and before the string arms.
   - `scripts/compiler-boundaries.json`: classifies the new module like its
     `host-array-carrier.ts` sibling.

Deviation from the "Correction" sketch: there is no single
`toPrimitiveCarrier(ctx, valType, hint)` emitter, because the four positions
need different tails after the shared reduction (a string, an f64, or a host
operator over BOTH operands evaluated first). The shared part — "an array
carrier's primitive is its join" — is `emitHostArrayToPrimitive`, used by all of
them.

## Resolution

Probe (JS-host lane, `const arr: number[]`, compared with Node; harness
`.tmp/probe.mts` in the worktree):

| source | before | after | Node |
|---|---|---|---|
| `String(arr) === "0,9,0"` | false (the array) | true | true |
| `` `${arr}` `` | the array | "0,9,0" | "0,9,0" |
| `[] + []` | NaN | "" | "" |
| `[] + {}` | NaN | "[object Object]" | "[object Object]" |
| `+[]` / `+[1]` | NaN / NaN | 0 / 1 | 0 / 1 |
| `Number([5])` | NaN | 5 | 5 |
| `[1, 2] == "1,2"` (typed) | false | true | true |
| `[10] < [9]` (typed) | false | true | true |
| `a == b` (same array) | false | true | true |

`tests/issue-6788-array-carrier-toprimitive.test.ts` (66 rows × JS-host, 64 ×
standalone, each compared with Node on the same source): on the parent 41 of
the 66 host rows differed; with the fix none do. Standalone: 0 failures before
and after. `tests/equivalence/array-carrier-to-primitive.test.ts` adds the
String / `+` / ToNumber rows to the equivalence suite.

Blast radius, measured (binary sha1, parent vs branch): all 42
`website/playground/examples` files × both lanes byte-identical; 15 reference
snippets (`arr + ""`, `"" + arr`, `arr.toString()`, `arr.join()`, `a.length +
1`, `a[0] + a[1]`, `String(5)`, templates of number/string, `arr == null`,
`arr === b`, `any + any`, object/class `toString`, `a < b`) byte-identical on
both lanes.

Gates (all exit 0 unless noted): check-loc-budget, check-func-budget (both
with the allowances above), check-coercion-sites, check:oracle-ratchet,
check:dead-exports, typecheck, format, biome lint, compiler-boundaries
inventory, check:ir-dialect, ir-kind-neutrality, jstag-seam, ir-layering,
codegen-fallbacks, any-box-sites, speculative-rollback, stack-balance,
pushraw, host-import-policy, ir-only, ir-adoption, issues,
done-status-integrity, issue-spec-coverage, harness-compile-budget,
verdict-oracle, lint, check:ir-fallbacks, test:guard (20 files / 255 tests).
Related suites: 11 equivalence files (78 tests) pass; of 40 existing
primitive/tostring/template/join/coercion test files, the same 17 tests fail on
the parent and on the branch (pre-existing, unrelated — standalone RegExp
toString IR capability violation, Error.isError, holes, etc.).

test262 (not run; baseline JSONL grep, linked-harness lane): the rows whose
failure message is an array reaching a primitive position are
`built-ins/String/S15.5.1.1_A1_T19.js` and `S15.5.1.1_A1_T8.js` ("typeof __str
=== object" after `String(new Array(...))`) and `built-ins/String/S9.8_A5_T1.js`
(`String(new Array(2,4,8,16,32))` not a string) — expected +3.
`language/expressions/unary-plus` has 0 failing rows; the 8 failing
`addition` rows are Date / function / Symbol / BigInt shapes this change does
not touch, so no gain is expected there. Caveat: the local single-row
reproducer (`scripts/run-test262-row.mts`, whole-assembly lane) passes the
three String rows on the parent too, so the +3 is inferred from the linked-lane
baseline messages, not measured.

Left out, deliberately (each reproduced on the parent with the spellings this
change does not touch):

- **Host walker answers "null" for a plain struct** once any struct in the
  module has a `toString`/`valueOf` method: `_hostToPrimitive` trusts the
  `__call_toString`/`__call_valueOf` dispatcher's `null` miss as a primitive
  result. `String(anyObj)` and `{a:1} + ""` already read "null" there; the new
  ToString tail goes through the same walker, so typed `String({a:1})` now
  reads "null" in such modules instead of returning the object. Needs a
  presence-aware dispatch (`__call_toString_with_presence` exists in-module but
  is not exported) — a follow-up issue.
- `boolean[]` stringifies as "1,0" through the value-level join (the vec holds
  i32; `arr + ""` gives the same); `[1, undefined, 3]` (an f64 vec with the
  undefined sentinel) stringifies as "1,NaN,3" (`__vec_get` boxes the sentinel
  as NaN; `arr + ""` gives the same). The static `arr.toString()` lowering sees
  the element type and is right for both.
- `(arr as any) == "1,2"` (a vec typed `any` by a cast) keeps its old lowering;
  tuples (`[number, string]` structs) are not vecs and still stringify as
  "[object Object]"; `Date + Date` on the host lane is the Date carrier, not an
  array.
- Standalone residue found on the way, all pre-existing: `"1,2" == arr`
  (string-left) is false, `[1] == [1]` is true, `String(boolArr)` is "1,0".
