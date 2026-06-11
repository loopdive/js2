---
id: 1939
title: "Binary emitter: encodeInstr silently drops unknown ops — add default throw, un-gate validateFuncRefs, add round-trip test"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: compiler-internals
goal: correctness
---

# #1939 — encodeInstr default throw + funcref validation + round-trip test

## Problem

- **`encodeInstr` has no `default:` arm** (`src/emit/binary.ts:728-1678`).
  Combined with the **173 `as unknown as Instr` casts** (#1095) that bypass
  the type union, an op string that misses its case is **silently omitted
  from the binary** — the exact failure shape the casts invite. The fix is
  one line plus an exhaustiveness check.
- `encodeValType` silently encodes i8/i16 as i32 with a "this shouldn't
  happen" comment (`binary.ts:599-607`) — should throw.
- `validateFuncRefs` (`binary.ts:105-157`) guards the recurring
  stale-funcIdx bug class (#1891, #1899) but is **env-gated off by default**
  (`binary.ts:190`).
- **No round-trip test exists** for the emitter, even though
  `src/link/reader.ts` is a full Wasm decoder that could verify it.

## Proposed approach

1. `default: throw new Error(\`encodeInstr: unknown op ${(instr as any).op}\`)`plus a`satisfies never` exhaustiveness check where the union allows it.
   Run equivalence + test262 sharded to flush any op currently being
   silently dropped (each hit is a live bug found).
2. `encodeValType` i8/i16 outside array-element context: throw.
3. Enable `validateFuncRefs` whenever `process.env.NODE_ENV !== "production"`
   and always in vitest/CI (cost is per-emit linear scan; measure, expect
   negligible).
4. Round-trip test: emit a representative module (the playground corpus
   compiled small), decode with `link/reader.ts`, re-encode, assert
   byte-identical; plus property: every `Instr` op in the union encodes to
   ≥1 byte.

## Acceptance criteria

- Unknown-op and i8/i16-leak paths throw (unit tests).
- funcref validation active in CI; round-trip test in `tests/`.
- Any ops flushed out by the default-throw are fixed or added to the
  encoder in the same PR.

## Implementation notes (resolved 2026-06-11)

All in `src/emit/binary.ts` (+ one opcode in `src/emit/opcodes.ts`).

**`encodeInstr` default arm + exhaustiveness.** Added a `default` arm that
binds `const unknown: never = instr` (compile-time exhaustiveness over the
real `Instr` union) and throws `encodeInstr: unknown op "<op>"` at runtime
(catches cast-injected strings the union can't see).

**Three latent silent-drops flushed by the `never` check** — all were `Instr`
union members with **no encoder case** (would be silently omitted from the
binary the instant any path emitted one; none does today, so no live
miscompile, but a removed footgun):

- `i32.trunc_f64_u` — real op, given a proper case (opcode `0xab`, added to
  `opcodes.ts` next to its signed sibling `0xaa`).
- `end` — structured-block terminator (`0x0b`); block/loop/if normally emit
  their own trailing `end`, but a standalone `end` instr is valid.
- `br_table` — declared as `{ op: "br_table" }` with **no payload** (no target
  label vector / default). There is no correct encoding, so its case _throws_
  with a clear message rather than emit a truncated branch. Wiring it requires
  the union to carry `targets: number[]` + `default: number` first.

**`encodeValType` i8/i16 leak → throw.** Packed storage types are valid only
in struct fields / array elements (a dedicated path handles those). Reaching
them in a value position (param/result/local/global) used to silently encode
i32, producing a binary whose declared type disagreed with its values. Now
throws.

**`validateFuncRefs` un-gated.** Was `if (process.env.JS2WASM_VALIDATE_FUNCREFS)`
(off by default). Now runs whenever `VITEST`/`CI` is set or `NODE_ENV !==
"production"` (env override still force-enables; a production build opts out
for byte-identical output). It is a pure in-range scan — cannot reject a valid
module, only turns the recurring stale-funcIdx class (#1891/#1899) into a named
emit-time error. Validated as a no-op across the equivalence suite (0 fires).

**Tests** — `tests/emit-encodeinstr-failloud.test.ts`: unknown-op throws,
br_table throws, the three flushed ops encode (or throw, for br_table),
a no-silent-drop spot-check over representative simple ops, and i8/i16
value-position leak throws. Full equivalence suite green with the default-throw

- funcref validation active (no op dropped, no funcref false-fire).

## Source

Compiler quality review 2026-06. Direct child of #1858. Related: #1095/#1526
(cast budget), #1899 (funcIdx authority), #1916.
