---
id: 4632
title: "Standalone: symbol[] elements are raw i32 ids — compareArray renders the id number"
status: done
sprint: Backlog
created: 2026-08-23
updated: 2026-08-23
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen
goal: test262-conformance
lane: B
files:
  - src/codegen/literals.ts
  - src/codegen/symbol-native.ts
  - src/codegen/index.ts
loc-budget-allow:
  - src/codegen/literals.ts
  - src/codegen/symbol-native.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/symbol-native.ts::fillSymbolAnyToStringArm
  - src/codegen/literals.ts::compileArrayLiteral
coercion-sites-allow:
  # The fill SPLICES an arm INTO __any_to_string itself (the single coercion
  # terminal), it does not hand-roll a parallel ToString matrix — the name
  # reference is the splice target lookup.
  - src/codegen/symbol-native.ts
status-note: implemented (compare-array-symbol passes standalone)
---

# #4632 — Standalone symbol[] element representation

## Problem

`test/harness/compare-array-symbol.js` fails standalone: an array of
symbols (`[Symbol("a")]`) lowers its elements into a numeric vec
(`$__arr_i32`-family), losing the symbol brand per element. The harness's
`compareArray.format` does `map.call(arr, String)`, which renders the raw
id NUMBER (e.g. `"1"`) instead of `"Symbol(a)"`, and element equality
against another symbol value compares id-as-number vs boxed carrier.

Related fixed context: #4626 slice 1 branded the SCALAR `Symbol()` result
(`{kind:"i32", symbol:true}`, native-symbol lanes only) so any-channel
coercions box via `__box_symbol`. The ARRAY path does not consult that
brand when choosing the element vec type.

## Implementation Plan

1. **Element-type inference**: in the array-literal lowering
   (literals.ts), when the inferred element ValType carries
   `symbol: true` (or the checker type is `symbol`), do NOT select the
   numeric vec; select the externref/anyref vec and store the interned
   `$Symbol` carriers (`__box_symbol(id)`) as elements. This keeps every
   existing reflective consumer (String(), sameValue, typeof, key use)
   correct with no new arms, at the cost of boxing on store.
2. **Read path**: element reads then flow as externref carriers —
   `typeof arr[0]` already answers "symbol" via the #4626 typeof arm;
   `o[arr[0]]` symbol-keying already works via the defineProperty /
   `__key_equals` id-compare.
3. **Check the micro-shape residual from #4626's survey**: param-type
   inference turning `t(Symbol())` params into f64 — the same brand-loss
   family; verify whether step 1's inference hook also covers the
   param-inference site (declarations/param-return-inference.ts), and if
   not, note it as a follow-up rather than widening this slice.
4. **Acceptance**: `harness/compare-array-symbol.js` passes standalone;
   `String(Symbol("a"))` renders `Symbol(a)` from an array element; a
   15-test standalone sample over `built-ins/Symbol/**` baseline-pass
   tests shows 0 regressions; js-host lane byte-identical (gate on
   `usesNativeSymbolProvider`, mirroring the #4626 brand gate — the
   js-host brand leak was exactly the 2026-08-23 merge_group park, do not
   repeat it).

## Permanent repro

`test262/test/harness/compare-array-symbol.js` (standalone lane via `pnpm run test:262` / `runTest262File`).
