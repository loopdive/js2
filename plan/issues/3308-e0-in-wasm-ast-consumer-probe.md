---
id: 3308
title: "E0 — in-Wasm AST consumer probe: walk compiled-acorn's AST inside Wasm to arbitrate parser bugs vs host-marshalling losses"
status: ready
created: 2026-07-16
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: test
area: runtime, dogfood
language_feature: eval
goal: runtime-eval
sprint: current
parent: 2927
related: [2928, 1584, 1710, 1712, 2841, 2851, 2852, 2847]
---

# #3308 — E0: in-Wasm AST consumer probe

Slice **E0** of the runtime-eval sequencing
(`docs/architecture/runtime-eval-interpreter.md` Part II §15–§16; the
`## Implementation Plan` in #2928). Extracted from umbrella #2927 so it is
independently claimable. **Unblocked now** (post-#2937).

## Problem

The #1710/#1712 dogfood corpus reads compiled-acorn's AST **across the host
boundary** via `wrapExports`, so its divergence report conflates two very
different failure classes:

- **True parser bugs** (block the #2928 interpreter): #2853-A/B (fixed),
  #2846 (BigInt literals).
- **Suspected host-marshalling-only losses** (likely irrelevant to the
  interpreter): #2841 (`params[]` blank), #2851 (template quasis blank),
  #2852 (sequence children blank), #2847 (cosmetics).

Under strategy 2(a) the bytecode emitter consumes the AST **in-Wasm** via
dynamic `$Object` field reads — never through `wrapExports`. If the fields are
intact in-Wasm, those four issues drop off the interpreter's critical path
entirely. _Suspected — not proven._ E0 is the arbitration measurement, and it
doubles as the maturity metric for the dynamic-`$Object`-reader substrate the
emitter will inherit (compiled-acorn `Node`s are open `$Object`s with
dynamically-assigned fields; every emitter field read goes through the
name-keyed dynamic read path).

## Implementation plan (distilled from §15/§16 + #2928 E0)

1. **Author a small TS walker** (strictly-typed js2wasm-compilable subset) that
   is compiled **alongside Acorn** in the same module — extend the #1710
   harness under `tests/dogfood/`. Entry points, all returning scalars so no
   marshalling is involved in the _measurement_ itself:
   - `probeNodeCount(src: string): number` — parse + full recursive walk,
     count nodes (objects with a `type` field).
   - `probeParamCount(src: string): number` — parse, walk to the first
     Function/Arrow node, return `params.length` (arbitrates #2841).
   - `probeQuasiCount(src: string): number` — first TemplateLiteral's
     `quasis.length` + a `cooked` first-char code (arbitrates #2851).
   - `probeSeqCount(src: string): number` — first SequenceExpression's
     `expressions.length` (arbitrates #2852).
2. **Walk pattern**: node-field reads on the compiled side are plain property
   accesses on `any`-typed values (`node.body`, `node.params[i]`) — exactly the
   dynamic `$Object` read path the #2928 emitter will use.
3. **Harness**: a Node-side runner (mirror `tests/dogfood/acorn-corpus.mjs`)
   feeds the same corpus inputs, compares the in-Wasm scalars against
   node-acorn ground truth computed in JS.
4. **Report**: extend `tests/dogfood/CORPUS-GAP-MAP.md` with an
   `in-Wasm vs host-boundary` column per gap issue.

## Acceptance criteria

- [ ] Probe module compiles (Acorn + walker in one js2wasm compile) and runs
      under the host harness.
- [ ] For each of #2841/#2851/#2852: a definitive verdict — "field intact
      in-Wasm (marshalling-only; off the interpreter critical path)" or "field
      lost in-Wasm (real parser/substrate bug; stays blocking)" — recorded in
      the issue and in CORPUS-GAP-MAP.md.
- [ ] Node-count parity (±0) with node-acorn on ≥ 5 corpus inputs that already
      reach structural parity through the host boundary.

## Notes

Sized S. No dependency on P1/P2 (#2853, done) or E1 (#3101 pre-spec). Feeds
the E2 go/no-go in #2928's milestone order (E0 → E1/P1/P2 → E2).
