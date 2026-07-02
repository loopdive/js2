---
id: 2972
title: "IR selector accepts string element access with computed index; from-ast throws 'not in slice 12' — 14 test262 CEs under IR-first"
status: done
sprint: current
created: 2026-07-02
updated: 2026-07-02
completed: 2026-07-02
priority: medium
feasibility: medium
horizon: s
task_type: bug
area: compiler
language_feature: compiler-internals
goal: correctness
related: [2135, 2138, 2945]
origin: "2026-07-02 #2138 Slice-3 full flagged test262 run (28580162377) — divergence class 1 (14 tests)"
---

# Element-access capability drift: selector claims `s[i+1]`-shaped reads, builder throws

## Problem

The largest divergence class from #2138's full `JS2WASM_IR_FIRST=1` test262
run (14 of 15 regressions, all `pass → compile_error`):

```
IR path failed for decimalToPercentHexString: ir/from-ast: element access on
string with index BinaryExpression not in slice 12 (…) [IR-FALLBACK]
[IR-FIRST skipped-slot, #2138]
```

The test262 harness helper `decimalToPercentHexString` (used by the
encodeURI / decodeURI / encodeURIComponent / decodeURIComponent /
parseInt / parseFloat suites) indexes a string with a computed
(BinaryExpression) index. The selector's element-access shape check accepts
it and claims the function; `from-ast.ts`'s element-access lowering only
accepts a narrower index shape and throws post-claim. Flag-off this demotes
silently to legacy; flag-on the skipped slot fails the compile LOUDLY —
exactly the designed #2138 surfacing.

Affected (all share the one harness function):
`built-ins/decodeURI/S15.1.3.1_A2.1_T1`, `decodeURIComponent/S15.1.3.2_A2.1_T1`,
`encodeURI/S15.1.3.3_A1.{1,2,3}_T{1,2}`, `encodeURIComponent/S15.1.3.4_A1.{1,2,3}_T{1,2}`,
`parseFloat/S15.1.2.3_A6`, `parseInt/S15.1.2.2_A8`.

## Fix — this IS #2135 family 2/3 work

Single-source the **element-access index-shape** guard in
`src/ir/capability.ts` (the #2135 table), consumed by the selector's
element-access arm and asserted at from-ast's lowering entry. Then either:

1. **Selector-side (cheap)**: reject computed-index string element access
   (capability "defer" for that shape) — restores flag-on/flag-off parity
   immediately; the 14 tests go back to legacy compile.
2. **Builder-side (better)**: lower `s[<f64 expr>]` — the constant-index
   string read lowering exists; extend it to a computed index (same charAt
   semantics: index ToInteger, out-of-range → undefined … match the LEGACY
   emission, verify-first per #2945's lesson).

## Acceptance criteria

- A `JS2WASM_IR_FIRST=1` compile of the `decimalToPercentHexString` harness
  function either legacy-compiles (option 1) or IR-compiles (option 2) —
  no hard error; the 14 test262 tests pass flag-on.
- The shape guard lives in `capability.ts` (one row/predicate, not two).

## Resolution (2026-07-02)

Implemented option 1's outcome ("the 14 tests go back to legacy compile"), but
at the IR-first **skip-set** layer rather than the selector/`capability.ts`,
because two of the issue's premises did not hold up under measure-first:

1. **Constant-index string reads are ALSO unimplemented.** `from-ast.ts`'s
   `lowerElementAccess` has no string-receiver arm at all — `hex[0]` throws
   `element access on string with index FirstLiteralToken not in slice 12`
   exactly like `hex[i]`. So option 2 is not "extend constant to computed"; it
   is building the string-read arm from scratch, including OOB→undefined
   widening (the legacy `#2760` `expectedType` semantics) — a silent-miscompile
   hazard, out of scope for this bug.
2. **The selector cannot type-resolve the receiver.** `isPhase1Expr(expr,
scope, localClasses)` is checker-free (`scope: ReadonlySet<string>`), so its
   element-access arm cannot tell a `string` receiver from a `vec` receiver.
   Rejecting computed-index element access there would over-reject working vec
   `arr[i]` reads. The issue's "consumed by the selector's element-access arm,
   single-sourced in capability.ts" is therefore infeasible as written.

**Fix:** added **gate 5** (`irFirstBodyReadsStringElement`) to
`computeIrFirstSkipSet` (`src/codegen/ir-first-gate.ts`, wired in
`src/codegen/index.ts`), mirroring gate 4 (`irFirstBodyReadsHostNode`). Any
function whose body reads an element of a (syntactically) string receiver stays
on the **compile-twice** path (legacy body + silently-demoting overlay) instead
of the IR-first compile-once set, so the from-ast throw demotes to a warning
instead of the `[IR-FIRST skipped-slot]` hard error. No string-element read can
validly be IR-first today (it always throws), so this loses nothing real and
does not touch vec/object element access (verified). Lifting gate 5 is the
trigger for a future real string-element-read lowering in the IR builder.

Tests: `tests/issue-2972.test.ts` — harness runs correctly flag-on and
flag-off; a claimed const-string-index function no longer hard-errors; vec
`arr[i]` is still IR-first compile-once; predicate fire/no-fire table.
