---
id: 3686
title: "perf: null-check/throw + cast scaffolding dominates WasmGC-lowered field access"
status: ready
created: 2026-07-27
updated: 2026-07-27
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: perf
area: codegen
language_feature: compiler-internals
goal: performance
sprint: current
related: [3673, 3683, 3685, 1947, 1852]
---

# #3686 — Null-check/throw + cast scaffolding on every field access

## Problem

Two independent #3673 investigations, using different workloads and
different methods, converged on the same dominant cost in WasmGC-lowered
code: **the scaffolding around field access, not the field access.**

**Evidence 1 — opcode census of a hot tokenizer function** (`Lexer_next`,
our `-O3` standalone module):

```
throw 54 · ref.is_null 35 · extern.convert_any 73 · any.convert_extern 19
ref.cast 38 · ref.test 19 · struct.get 57 · struct.set 16 · call 7
array.get_u 5 · i32.trunc_sat_f64_s 5 · f64.convert_i32_u 5 · f64.add 6
```

54 throws and 35 null checks in ONE function; **149 conversion/cast ops
against 5 actual character reads**.

**Evidence 2 — GC vs linear-memory twin of the same parser** (#3673
"Linear memory vs WasmGC"): on the parse+AST workload the linear lane was
5.9x faster, and the mechanism was NOT allocation (that is ~1:1). GC's
`parsePrimary` carries **`ref.cast` ×38 + `ref.test` ×45** re-narrowing
`Node | null` on every field read; **the linear twin has zero casts.**

Both point at the same thing from opposite directions. This is also the
unfinished half of #1947, which observed it statically in 2026-06:
"every typed param is `(ref null $T)` with per-access null-check-throw
blocks; a 6-line function carried four" — but never priced it. It is now
priced, and it is the largest identified remaining cost in the
GC lane for parser-shaped code.

## Why it happens

- A nullable declared type (`Node | null`, or any binding the checker
  cannot prove non-null) lowers to `(ref null $T)`. Every subsequent
  read must re-establish non-nullness, so codegen emits a null test plus
  a throwing branch, then a `ref.cast` to re-narrow the static type it
  already knew.
- Values that round-trip through `externref` (the #1947 laundering
  problem) lose their concrete type and must be re-cast on the way back
  in, which is where the `extern.convert_any`/`any.convert_extern`/
  `ref.cast` triples come from.

## PREREQUISITE (found 2026-07-27 by the #3687 study) — read before starting

**`class Node { left: Node }` — a non-nullable field of the class's own
type, which is exactly the AST shape this issue targets — makes codegen
recurse until stack overflow.** `objectIrTypeFromTsType` ↔
`tsTypeToFieldIr` (`src/codegen/index.ts` ~1081/~1099) have no cycle
guard. The nullable/optional spellings only work because a union misses
the `Object` flag and bails to the legacy path — i.e. today's code
survives *because* it is untyped. **This issue's end state is therefore
not expressible in source yet; the cycle guard is a prerequisite, not an
optimisation.** Fix that first or this work cannot land.

## Revised expectations (same study)

The scaffolding was PRICED with a hand-written WasmGC control: **+10-16 %
on build+walk, +23-29 % on a pure walk** (0.45-0.53 ns/read). That is a
percentage, not the multiple the opening evidence suggested, and
`extern.convert_any` turns out to be a V8 no-op — so the `extern`/`any`
half of the census is cheaper than the raw count implies. Size the work
accordingly.

**A bigger prize sits next door**: the generic `===` ladder. `tk[i] === 40`
with BOTH operands statically `number` emits 4 `__box_number`, 4 unboxes,
**an object→string conversion and a string comparison per token**. That
is #3685/#1584/#1852 territory and, on the measured evidence, worth more
than this issue. Consider sequencing it first.

## Direction

1. **Hoist the check to the binding, not the access.** A local proven
   non-null once (`ref.as_non_null` at the binding, or a single guarded
   entry) should be typed `(ref $T)` for its whole live range, so
   subsequent reads are bare `struct.get`. This is the same
   "guard per binding, not per access" rule #3685 S4 already identifies
   for receivers — the two should share a mechanism.
2. **Non-null params under `strictNullChecks`** (#1947 item 2): a
   non-optional reference param lowers to `(ref $T)`; callers guarantee,
   callees drop the null blocks entirely.
3. **Stop the externref round trip inside the module** (#1947 item 1),
   which removes the re-cast on the way back.

## Non-goals

- Removing genuinely required null checks. Where a value can actually be
  null, the check stays; this issue is about the ones the compiler can
  prove redundant.
- Changing throw semantics or which errors are raised.

## Acceptance criteria

- `throw` / `ref.is_null` / `ref.cast` counts in the #3673 hot tokenizer
  function drop materially (target: `throw` and `ref.is_null` to
  single digits, from 54 and 35).
- Measured on the #3673 harnesses (`.tmp/parser-shootout.mjs`,
  `.tmp/tokenize-only.mjs`, `.tmp/simd-shootout.mjs`) against the
  established ladder: node ~0.033-0.035 ms, hand-written WasmGC ceiling
  ~0.015 ms, our compiler ~0.100 ms.
- **Whole-chain or negative** (the #3673 law, confirmed three times): a
  partial application that leaves re-widening/re-casting in place will
  measure WORSE. Land the complete chain or do not land it.
- Full `tests/equivalence` failure set identical by test NAME; corpus
  0 real gaps; canaries `imports: ZERO`.
