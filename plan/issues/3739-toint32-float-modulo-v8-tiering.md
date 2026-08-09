---
id: 3739
title: "ToInt32's float-based modulo-reduction (f64.div/f64.floor) never tiers up in V8 — landing-page loop.ts benchmark showed ~37x wasm-vs-js slowdown"
status: done
sprint: 77
created: 2026-07-28
updated: 2026-07-30
completed: 2026-07-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
language_feature: bitwise-operators
goal: performance
depends_on: []
related: [3707, 3733, 3734]
loc-budget-allow:
  - src/ir/lower.ts
  - src/codegen/binary-ops.ts
func-budget-allow:
  - src/ir/lower.ts::lowerIrFunctionBody
---
# #3739 — ToInt32's float-based modulo reduction never tiers up in V8

## Context

After landing #3707/#3709-#3711 (unfreezing the test262 landing-page pass
rate), the landing-page `loop.ts`/`array.ts` wasm-vs-js benchmark chart
showed a catastrophic ~28-37x wasm-slower-than-js ratio for `loop.ts`
(`s = (s + i) | 0`, 1,000,000 iterations) and a smaller ~2.6-3x ratio for
`array.ts`. The user reported this as "a catastrophic array and loop
regression in the host lane" and asked for investigation + fix.

## Investigation

`array.ts`'s ~2.6-3x ratio is real but modest, already correctly diagnosed
in #3734 (generic `__vec_push` externref-boxing dispatch overhead) — not
addressed here, tracked separately.

`loop.ts`'s ~28-37x ratio was bisected all the way down to a **V8/Node
engine tiering limitation**, confirmed with a 100%-handwritten WAT module
with zero connection to the compiler:

- Pure f64 accumulator loop (no ToInt32 at all): ~1.4ms/call, tiers up
  normally across repeated calls.
- Add the float-based modulo-reduction ToInt32 needs
  (`f64.trunc`/`f64.div`/`f64.floor`/`f64.mul`/`f64.sub`/`i32.trunc_sat_f64_u`
  — required because WasmGC has no direct f64→i32-mod-2^32 instruction):
  ~17.3ms/call, **never improves across 15+ repeated calls** — V8 never
  tiers this function up to its optimizing compiler; it stays at baseline
  (Liftoff) speed indefinitely.
- Isolating instruction-by-instruction: `f64.floor` alone (no trunc/div/mul)
  already costs ~2.4ms/iteration-batch of overhead vs. plain f64 add; the
  full modulo-reduction chain (minus the final i32 conversion) costs ~8.4ms.
- This reproduces byte-for-byte identically with the OLD (pre-session) and
  current compiler source — it is **not a regression introduced by any
  recent PR**, simply never visible before because the whole benchmark
  pipeline was frozen/stale until #3700-#3704 unfroze it this session.

## Fix

Replaced the float-based modulo reduction with IEEE-754 bit decomposition
(sign/exponent/significand extraction + direct shifting), matching how
native JS engines implement ToInt32 in C++. Avoids `f64.floor`/`f64.div`
entirely — only `i64.reinterpret_f64`, integer shifts/and/or, and
`i32.wrap_i64`.

Two independent call sites needed the fix:

1. `emitToInt32` (`src/codegen/binary-ops.ts`) — the legacy AST-direct
   codegen path.
2. `emitJsToInt32`'s fast branch (`src/ir/lower.ts`) — the IR path, generic
   over `BackendEmitter<S>` and shared across WasmGC, linear (WASI), bytecode,
   and Porffor backends. The fast bit-manipulation path only fires when
   `S = Instr[]` (WasmGC and linear both use this sink type — confirmed via
   `linear-emitter.ts`'s pass-through `emitBinary`/`emitUnary`/
   `emitNumericConversion`, which push the identical raw `Instr` either
   backend would need). Bytecode is already excluded from `js.bitwise` ops
   entirely by an earlier legality check. **Porffor keeps the old portable
   float-based algorithm** — its expression-tree sink doesn't model i64
   bit-cast/shift ops, and extending it to do so (adding `i64` as a first-class
   type across Porffor's `binaryOp()`/`emitUnary()` dispatch) is out of scope
   here; the branch on `Array.isArray(out)` in `emitJsToInt32` cleanly
   preserves Porffor's existing behavior unchanged.

## Results

- Landing-page `loop.ts` benchmark: wasm went from ~17.3ms → ~8.4ms per
  1M-iteration call (~2x faster) in local sandbox measurement. Still doesn't
  fully tier up to the sub-millisecond speed of a pure-i32/pure-f64 loop
  (isolated handwritten-WAT testing shows the branch-heavy bit-decomposition
  itself also resists full V8 tiering, just far less severely than the
  float-modulo version) — chasing that last mile would need deeper
  V8-specific tuning, judged out of scope for this fix.
- Correctness: 500,000+ fuzz cases plus hand-picked edge cases (NaN,
  ±Infinity, ±0, subnormals, exact `2^31`/`2^32` boundaries, `Number.MAX_VALUE`,
  `Number.MIN_VALUE`, large fractional values) verified byte-identical to
  native JS `ToInt32` across both the `|`/`^`-with-zero fast path and the
  general bitwise-op path (`&`, `<<`, `>>`, `>>>`).
- No regressions: existing `tests/bitwise.test.ts` reproduces its pre-existing
  environment-only failure identically with/without this change (confirmed
  via `git stash`); one pre-existing, unrelated equivalence-test failure
  (`arguments-nested-and-loops.test.ts`) also reproduces identically via
  `git stash` — not caused by this change.

## Out of scope / follow-ups

- Extending the bit-manipulation fast path to the Porffor backend (would
  need i64 support added to Porffor's own IR/type system).
- `array.ts`'s `__vec_push` dispatch overhead — tracked in #3734.
- Further V8-tiering optimization for `loop.ts` beyond this fix (unclear
  payoff, and unclear whether it reproduces in real browsers vs. this
  sandbox's specific V8/Node build).
