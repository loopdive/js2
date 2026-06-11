---
id: 1939
title: "Binary emitter: encodeInstr silently drops unknown ops — add default throw, un-gate validateFuncRefs, add round-trip test"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
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

1. `default: throw new Error(\`encodeInstr: unknown op ${(instr as any).op}\`)`
   plus a `satisfies never` exhaustiveness check where the union allows it.
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

## Source

Compiler quality review 2026-06. Direct child of #1858. Related: #1095/#1526
(cast budget), #1899 (funcIdx authority), #1916.
