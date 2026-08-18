---
id: 4414
title: "devirtualized prototype-method call returns a boolean as a number — live standalone miscompile"
status: done
sprint: 78
created: 2026-08-14
completed: 2026-08-14
priority: high
horizon: s
feasibility: medium
task_type: bug
area: codegen
related: [4406, 4405, 3754, 4157]
loc-budget-allow:
  - src/codegen/string-ops.ts
  - src/codegen/expressions/call-identifier.ts
---

# #4414 — devirtualized boolean return typed as a number: `("" + p.eat(5)).length` → 1, not 4

> **Read the Localization section below FIRST.** The original framing (the
> `numericFunctions` fixpoint / `refinedTwinReturnType`) was measured and
> RULED OUT. The defect is in the direct-call devirtualization path.

## Problem

Found during #4406's architect investigation (spec §1–§2 in
`plan/issues/4406-return-type-unboxing-abi.md`, commit `aedb0bb82`; full
repro and measurements there). **Default-ON on main, standalone lane:**

- `Prover.isNumeric` answers true for booleans, and the `numericFunctions`
  fixpoint loop (`src/codegen/numeric-property-analysis.ts:1267-1279`) has
  **no `isBooleanish` filter** — unlike the property loop (`:1319`) and the
  grounded-slot loop (`:1373-1379`), which both have it.
- Measured on acorn: all **83** boolean-returning functions
  (`inferBooleanFunctionNames`, `struct-field-boolean-brand.ts:147-172`) are
  swallowed into `numericFunctionNames` (102 total, intersection 83).
- Consequence: `refinedTwinReturnType` (`typed-this.ts:1054`) mints **f64**
  twins for boolean predicates (`eat`, `isContextual`, all 40
  `regexp_eat*`), and `true` crosses the call boundary as `1`.

Reproduced miscompile (standalone, default flags):

```ts
export function strlen() { var p = new P(5); return ("" + p.eat(5)).length; }
// node: 4 ("true")     standalone build: 1 ("1")
```

`JS2WASM_NUMERIC_TWINS=0` does NOT fix it — there is a second consumer with
the same missing filter: `provenNumericOperand`'s call rule
(`src/codegen/binary-ops.ts:993-999`).

acorn keeps checksum 422 only because its predicates are consumed
exclusively in boolean/condition context, where 1-vs-true is unobservable.
Any program that stringifies, strict-equals against `true`, or `typeof`s a
proven-boolean call result is miscompiled today.

## Fix shape

Thread `isBooleanish` into both consumers, mirroring the property loop:

1. `numericFunctions` loop (`numeric-property-analysis.ts:1267-1279`) —
   exclude boolean-returning functions from `numericFunctionNames` (or track
   them as a distinct set; #4406 Phase 1 wants exactly that set).
2. `provenNumericOperand` call rule (`binary-ops.ts:993-999`) — same filter.

Do NOT "fix" it by making the f64 twin box back to boolean at the edge —
#4406's spec defines the real i32/boolean return type for these; this issue
is only about stopping the wrong f64 verdict. Coordinate: #4406 Phase 1
builds on the set this fix separates out.

## Acceptance criteria

- The repro above returns 4 in standalone with default flags.
- Equivalence tests green; a new equivalence test covers
  boolean-return-stringification (and `=== true`).
- acorn lane: checksum 422, and report the twin-count delta (the 83 f64
  twins for predicates will disappear or change type — binary size and
  wall delta stated, regression tolerated since correctness wins).
- test262 standalone: no net regression (CI merge_group validates).

## Hazards (from #4406 spec — read it first)

- `unboxFromExternref`'s `i32 && boolean` arm (`typed-this.ts:1763-1768`)
  calls `__unbox_boolean`, which only recognises boxed-boolean carriers
  (`closure-exports.ts:552-561`) — currently a dead arm; do not activate it
  as part of this fix.
- `coerceType(externref → i32)` is ToNumber+truncate, not ToBoolean.

## Localization (main session, 2026-08-14) — it is the DIRECT-CALL path, not the numeric fixpoint

Reproduced on `main` (worktree off `origin/main`, standalone target, no perf
flags set). Probe: `.tmp/probe-4407-discriminate.mjs` / `-flags.mjs`.

**Which shapes miscompile** — `("" + <bool>).length`, standalone:

| shape | got | want |
| --- | ---: | ---: |
| `"" + true` (literal) | 4 | 4 ✓ |
| `"" + false` (literal) | 5 | 5 ✓ |
| `var b = (5 === 5); "" + b` | 4 | 4 ✓ |
| `function eq(a,b){return a===b} "" + eq(5,5)` | 4 | 4 ✓ |
| **`P.prototype.eat = …; "" + p.eat(5)`** | **1** | **4 ✗** |

So standalone string concatenation of a boolean is FINE, and a plain
function call is FINE. **Only the prototype-method call miscompiles**, and
both `true`→"1" and `false`→"0" (each length 1).

**Which mechanism** — same repro under single flags:

| build | result |
| --- | ---: |
| default | 1 ✗ |
| `JS2WASM_NUMERIC_TWINS=0` | 1 ✗ |
| `JS2WASM_TYPED_THIS=0` | 1 ✗ |
| **`JS2WASM_DIRECT_CALLS=0`** | **4 ✓** |

**This rules out the fix this issue originally proposed.** Adding the
`isBooleanish` veto to the `numericFunctions` fixpoint loop
(`numeric-property-analysis.ts:1267-1279`) was tried and measured: the repro
is **byte-for-byte unchanged**, 1 before and 1 after. `refinedTwinReturnType`
is not the (only) producer here — the bug survives with typed-this and
numeric twins both disabled, and dies only with direct-call devirtualization
off. Note `BOOLEAN_BINARY` already contains `===`, so `isBooleanish` DOES
answer true for `this.n === x`; the veto fires and still changes nothing.

The veto may still be correct hardening on its own merits (its two sibling
loops both carry it, and the property loop's comment documents this exact
hazard class for `node.static === false`) — but it is **not** this defect's
root cause and must not be shipped as such without its own evidence.

**Next investigator starts here**: the result type chosen for a devirtualized
prototype-method call in the direct-call fill path (`recordDirectCallTwin` /
`recordDirectCallGeneric` / `fillDirectCallTrampolines`, `typed-this.ts`), on
the standalone lane, with typed-this twins OFF. Find who decides the callee's
result is numeric there. Repro test (currently failing, do not add to CI until
it passes): `.tmp/issue-4407-repro-test.ts`.

## Root cause + fix (2026-08-14, impl PR)

The direct-call machinery was **innocent** — its result type was correct all
along. Instrumented at the trampoline reservation
(`tryEmitDirectTwinCall`, typed-this.ts): `sig.returnType` for `P.eat` arrives
as `{"kind":"i32","boolean":true}` — the #1788 **boolean brand on the i32
carrier**, exactly right — and `tryEmitDirectTwinCall` reports it faithfully
to the caller.

The defect was three **stringification consumers deciding boolean-ness from
the static TS type alone**, ignoring the runtime brand:

1. `compileNativeConcatOperand` (string-ops.ts) — the standalone `+`-concat
   cascade, deliberately not migrated to the coercion engine (its #1917 note).
2. The template-literal span path (string-ops.ts, `spanIsBool`).
3. The `String(x)` builtin lowering's i32 arm (call-identifier.ts).

`p.eat(5)` on an untyped constructor instance is `any` to the checker, so
`isBooleanType(tsType)` is false and the branded i32 fell into each site's
numeric arm → `number_toString` → `"1"`. This explains the whole shape table
above: every passing shape has a *statically known* boolean type; only
devirtualization surfaces a branded i32 under static `any`. And
`JS2WASM_DIRECT_CALLS=0` "fixes" it only because the dynamic dispatcher
returns a boxed externref that stringifies at runtime — the numeric fixpoint
(`refinedTwinReturnType`) never fired at all in the repro (`refined=undefined`,
measured).

Fix: all three sites now check `isBooleanType(tsType) || valType.boolean`,
matching what the binary-op concat path (string-ops.ts ~2047/2122) and the
migrated coercion engine (`emitToString`, coercion-engine.ts:236) already did.

Verified: repro 4 ✓; siblings `String()` 4 ✓, template 10 ✓, `=== true` ✓,
`typeof` ✓ (the last two passed before the fix — strict-eq/typeof compare the
i32 numerically, which is correct for booleans). The js-host lane cannot run
the repro shape at all (`value is not callable`, byte-identical on unmodified
HEAD — #4227 family), so the new equivalence test
(`tests/issue-4414-boolean-direct-call-stringify.test.ts`) oracles standalone
against plain JS.
