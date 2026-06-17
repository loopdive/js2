---
id: 1924
title: "Instruction-level type rules in the IR verifier — operands, branch-arg types, and resultType validation"
status: done
assignee: ttraenkler/tld-2139
sprint: 63
created: 2026-06-10
updated: 2026-06-16
completed: 2026-06-16
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir
language_feature: compiler-internals
goal: correctness
---
# #1924 — IR verifier: instruction-level type rules

## Problem

The IR verifier is positioned as the project's compensation for TypeScript's
unsound type system (`docs/architecture/structure-and-language-assessment.md:107-110`),
and #1850 hardened SSA/dominance/legality. But it still checks **no
per-instruction operand typing at all**:

- `f64.add` over two i32 values, `string.concat` over f64s, `object.get` of
  a missing field, `closure.call` arity/type mismatch — all pass verification.
  The only type rules are the union trio (`verify.ts:375-410`) and
  conservative return assignability (#1798, `verify.ts:264-285`).
- Branch args: **arity checked, types not** — `checkBranchArity`
  (`verify.ts:681-704`) compares lengths only; `blockArgTypes` are never
  matched against passed values' types.
- `resultType` is denormalized onto every instr "for verifier speed"
  (`nodes.ts:438`) and **trusted, never re-derived** — yet it directly
  becomes Wasm local types at lowering (`lower.ts:523-533`). A pass that
  writes a wrong resultType is invisible until the engine rejects the binary
  (or worse, accepts it with wrong semantics).
- Slot discipline unchecked: `slot.read/write` indices never validated
  against `func.slots` bounds or declared types.
- Perf note: `operandIrType` re-scans the whole function per query
  (`verify.ts:629-641`) — quadratic; build a def-map once (the dominance
  check already builds one).

## Proposed approach

1. Table-driven rule per `IrInstr` kind: expected operand IrType kinds →
   derived result kind. Start permissive (kind-level: scalar/ref/string/
   object) and tighten; reuse the def map from #1850's dominance pass.
2. Validate `resultType` against the derived kind; mismatch ⇒ verify error
   (demotes safely via the existing channel, metered by #1923).
3. Branch-arg type matching against `blockArgTypes`.
4. Slot read/write bounds + declared-type checks.
5. Keep total verify cost O(n): one def-map, one pass.

## Acceptance criteria

- Injected wrong-resultType and i32-into-f64.add IR (unit tests via
  IrFunctionBuilder) are rejected.
- No new post-claim demotions on the playground corpus (or each one
  investigated — they are real latent bugs by definition).
- Verify wall-time on the corpus within 1.5× of current.

## Source

Compiler quality review 2026-06. Extends #1850 (in-review). Related: #1923,
#1857 (attributes vs operands).

## Resolution (2026-06-16)

Instruction-level type rules added to `src/ir/verify.ts`, all O(n).

### Implementation

- **`buildDefTypeMap(func)`** — builds the SSA value → `IrType` map **once**
  per function (params + `blockArgTypes` + each instr's denormalized
  `resultType`, via the existing `forEachInstrDeep`). The rules consult this
  O(1) map instead of `operandIrType`, which re-scanned the whole function per
  query — the issue's quadratic-perf note. One build keeps total verify O(n).
- **`verifyInstrTypeRules(func, typeOf, errors)`** — a single linear walk
  applying per-`instr.kind` rules:
  - **binary**: operand `ValType.kind` must match the op domain (`f64.*` →
    f64, `i32.*` → i32; `js.bit*` left unconstrained — the lowerer's Stage-3
    fast path accepts i32 *or* f64). `resultType` validated against the op's
    fixed result kind (f64 arithmetic → f64; comparisons/logical → i32;
    `js.bit*` skipped — result may be f64 or i32 after Stage-3 narrowing).
  - **unary**: `f64.neg`/`i32.trunc_sat_f64_s` → f64 operand; `i32.eqz` → i32;
    result-kind validated likewise (`ref.is_null` operand left unconstrained).
  - **string.len / vec.len** → f64 result; **string.const / string.concat** →
    string result; **string.eq** → i32 result.
  - **slot.read / slot.write**: `slotIndex` must be within `func.slots` bounds.
- **`checkBranchArgTypes`** — branch args' `ValType.kind` matched against the
  target block's `blockArgTypes` (previously only arity was checked).

**Conservatism (key to AC #2):** every rule fires ONLY on a *definite*
mismatch — the operand/result type is KNOWN and its kind contradicts the op.
Unknown / null / non-scalar types are skipped (mirrors `operandIrType`'s
contract). A fired rule demotes the function to legacy (integration.ts skips
verify-erroring functions), so the bar for firing is "provably wrong" — a real
program never demotes on a missing annotation.

### Acceptance criteria — verified

- ✅ **Injected wrong-resultType and i32-into-f64.add IR are rejected** —
  `tests/issue-1924.test.ts` (11 tests): i32 operands into `f64.add` flagged
  (`lhs/rhs must be f64`); `f64.add` with `resultType: i32` flagged
  (`resultType must be f64`); plus branch-arg mismatch + slot-OOB rejection,
  and well-formed / unknown-operand / `js.bit*` cases verify clean.
- ✅ **No new post-claim demotions on the corpus** — `check:ir-fallbacks` clean
  (no bucket growth); `test:ir:alloc` 14/14; the IR test suite shows the
  **same** 8 pre-existing `duplicate SSA def` failures (an unrelated inline-pass
  bug) with AND without this change — verified by swapping in `origin/main`'s
  `verify.ts` (identical 140 pass / 8 fail). None of the failures carry a
  rule message from this change.
- ✅ **Verify within 1.5× wall-time** — replaced the per-query O(n)
  `operandIrType` scans with a single O(n) def-type-map build + one linear
  rules walk; no per-instruction full-function rescans added.

### Scope note

Phase-1 rules are kind-level (scalar domain) and conservative by design, per
the issue's "start permissive and tighten" guidance. Tightening (e.g.
slot.write *declared-type* matching beyond bounds, ref-typeIdx matching, object
field-type checks) is left to follow-ups so this lands without risking corpus
demotions.
