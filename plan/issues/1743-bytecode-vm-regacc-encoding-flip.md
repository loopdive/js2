---
id: 1743
title: "Bytecode VM: coordinated stack → register+accumulator encoding flip"
status: ready
created: 2026-05-30
updated: 2026-05-30
priority: medium
feasibility: hard
model: fable
reasoning_effort: high
task_type: feature
area: runtime
language_feature: eval
goal: spec-completeness
sprint: Backlog
parent: 1584
depends_on: [1584]
---
# #1743 — Bytecode VM: coordinated stack → register+accumulator encoding flip

## Problem

The #1584 Phase-1 bytecode VM currently runs a **stack machine** — the #1715
proof's encoding, kept deliberately for the first Phase-1 increment per the
architect's contract (#955 §1a staging note):

> "build on the #1715 STACK shapes FIRST (keeps triple-equivalence green), then
> align to reg+acc in the ONE coordinated flip commit (with sdev-emitter — don't
> flip independently)."

The VM slice (b) landed on that stack encoding (PR #956: `src/ir/backend/bytecode-vm.ts`
dispatch loop + `tests/ir-bytecode-wasmgc-vm.test.ts` quadruple-equivalence). The
**production** encoding decision is **register + accumulator** (Ignition-style),
for the reasons the #1584 issue and #955 §1a/Component-2 record:

1. fewer opcodes per source operation (operands are register indices, not
   push/pop pairs);
2. the accumulator absorbs the implicit destination, halving operand encoding on
   the common case;
3. **Wasm-locals map 1:1 to virtual registers** in the compiled dispatch
   function, so the AOT-compiled dispatch loop avoids a software operand stack
   (a `number[]` push/pop hot loop the AOT cannot turn into Wasm locals).

This issue is the **coordinated flip** that moves the VM from stack to reg+acc.

## Why this is its own (coordinated) issue, not inline in the VM slice

Per the #955 contract §5 ("If the contract shape changes — READ THIS"), the
encoding flip is one of exactly two bounded, additive contract changes, and it
is **owned by slice (a) (sdev-emitter, `bytecode-emitter.ts`)**, with the VM
slice (b, `bytecode-vm.ts`) realigning the dispatch body **in lockstep**:

> "The `OP` *names* and the `BytecodeEmitter` *primitive surface* are preserved;
> what changes is the *operand layout* of each opcode (register indices instead
> of implicit stack) and the VM's internal model (an accumulator + register file
> instead of a `number[]` operand stack). This is a slice-(a)-owned contract
> bump landed as ONE commit on `bytecode-emitter.ts` + a matching
> `bytecode-vm.ts` change by (b), coordinated, NOT raced."

So this must NOT be done by the VM slice alone. It is a two-file, two-owner,
single-logical-change that lands together (or as a tightly-sequenced pair gated
on each other) so `tests/ir-bytecode-proof.test.ts` and
`tests/ir-bytecode-wasmgc-vm.test.ts` never go red between the two halves.

## Scope

1. **Emitter half (slice a / sdev-emitter, `bytecode-emitter.ts`):** change the
   opcode *operand layout* to register+accumulator — e.g. `Ldar r` / `LdaConst k`
   (load into accumulator), `Star r` (store accumulator), `Add r` / `Sub r` /
   `Mul r` (`acc = registers[r] (op) acc`), `TestGt r` etc.
   (`acc = (registers[r] (cmp) acc) ? 1 : 0`), `JumpIfZero t` (`if acc == 0`),
   `Jump t`, `Return` (return `acc`). Preserve the `OP` *names* / primitive
   surface where possible; renumbering existing values is a contract change to
   flag explicitly.
2. **VM half (slice b / VM owner, `bytecode-vm.ts`):** replace the operand
   `stack: number[]` with an `accumulator` + `registers: number[]` model; rewrite
   each `switch` arm to the reg+acc semantics. Keep the loop in the
   js2wasm-compilable subset (the compiled-VM test must stay green).
3. **Tests:** keep the quadruple equivalence green across the flip —
   `runSink` (host VM) == compiled `bytecode-vm.ts` == WasmGC source == JS — for
   the #1715 subset (arithmetic, local/const, return, one branch, NEG, all
   CMP_*). Update the hand-lowering in `ir-bytecode-wasmgc-vm.test.ts` to the
   reg+acc operand layout.

## De-risking already done (PR #956 prep)

A throwaway probe during the VM slice confirmed a **register+accumulator
dispatch loop also compiles to Wasm-GC with the identical loop shape** (`for(;;)`
+ `switch` + `number[]` registers/code/pool). So the flip is contained to the
per-opcode bodies + the entry seeding (acc + registers vs locals + stack) — it
does NOT need a compiler change. The "interpreter-as-compiled-Wasm-GC" property
proven by #956 is encoding-independent; the flip changes only the encoding below
the seam, not the boundary contract (the #1700 in-module-build entry stays).

## Acceptance criteria

- [ ] `bytecode-emitter.ts` emits reg+acc operand layout (slice-a owned).
- [ ] `bytecode-vm.ts` dispatch uses accumulator + register file (slice-b owned).
- [ ] Both land coordinated; `tests/ir-bytecode-proof.test.ts` AND
      `tests/ir-bytecode-wasmgc-vm.test.ts` stay green through the change.
- [ ] The compiled-VM arm (compile the real `bytecode-vm.ts`) still equals the
      host VM == WasmGC source == JS over the #1715 subset.
- [ ] ADR / issue note records the final opcode operand encoding (the #1584
      ADR-XXX consumes this).
- [ ] Zero conformance delta (experimental backend, no default-path change).

## Relationship

- **parent #1584** — Phase 1 Component 2/3. This is the planned second step
  after the stack-first increment (PR #956).
- **coordinate with the emitter slice** (`bytecode-emitter.ts` owner) — this is
  the one-commit contract bump §5 of the #955 plan calls out.
- The reg+acc rationale + prior art (V8 Ignition, Lua 5, Hermes) live in the
  #1584 issue and the #955 plan; this issue executes that decision.
