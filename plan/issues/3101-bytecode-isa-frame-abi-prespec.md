---
id: 3101
title: "Bytecode interpreter ISA + `$Frame`/`$EnvRec` ABI pre-spec (E1 executable-cold): opcode set, encoding, exception table, AOT↔interp call protocol"
status: ready
sprint: Backlog
model: fable
created: 2026-07-09
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
task_type: architecture
area: runtime, ir
language_feature: eval
goal: runtime-eval
parent: 2928
depends_on: []
related: [2928, 2929, 2927, 1715, 2864, 1584, 3017]
origin: "2026-07-09 fable-arch hard-problems audit (domain 5) — E1's opcode ADR is the one unwritten design artifact on the interpreter critical path; pre-speccing it lets E1 (the interpreter library, Node-testable, zero substrate risk) start in any budget window"
---

# #3101 — the bytecode ISA, concretely

## Why this issue exists

The runtime-eval architecture is settled
(`docs/architecture/runtime-eval-interpreter.md` Part II): 4-tier ladder,
**bytecode over tree-walking (ADR'd §13)**, register+accumulator machine,
unified `$EnvRec` name resolution (§14), slices E0–E6 (#2928). E1 —
"interpreter library, developed in Node" — is fully parallelizable **today**
(no compiled-acorn dependency, no substrate risk), but its first deliverable
is the opcode ADR, a design-taste artifact. This issue IS that design, so an
Opus dev can execute E1 cold: implement, don't decide. Deliverable of E1
remains committing this as `docs/adr/0019-bytecode-isa.md` (next free ADR
number — verify) + the `src/interp/` library.

## Design constraints (inherited, normative)

1. **Values are the AOT boxed-any substrate** — every operand register holds
   the same `anyref` rep AOT code produces (tag classifier, `$Object`,
   native strings, undefined/null singletons). No interpreter-private value
   kinds. `ref.eq` identity crosses the boundary (roadmap §4.2).
2. **Two producers, one consumer** (§12.1): runtime ESTree→bytecode emitter
   (Phase 1) and, later, build-time IR→bytecode (#1715). No opcode may
   assume "parsed at runtime".
3. **Suspension-ready**: PC + registers live in a heap `$Frame`; the
   dispatch loop caches hot fields in Wasm locals and writes back only at
   suspension/call boundaries (generators/async are #2929, but the frame
   layout must not need a v2).
4. Typed fast paths are a **non-goal** — AOT owns performance.

## The machine

Register + accumulator (Ignition-style). One implicit accumulator `acc`
(boxed-any) + a per-frame register file `regs[0..R)` (boxed-any, mutable
array). Most ops read/write `acc`; binary ops take one register operand.

### Types (WasmGC; authored in the js2wasm-compilable TS subset)

```
$FuncMeta = struct {
  code:      (ref $BcArray)        ;; array (mut i32) — the bytecode
  consts:    (ref $ConstPool)      ;; array (mut anyref) — literals, names, nested $FuncMeta
  regCount:  i32
  paramCount:i32
  exnTable:  (ref null $ExnTable)  ;; array (mut i32), rows of 4: [startPC, endPC, handlerPC, handlerReg]
  name:      anyref                ;; string or undefined (Function.prototype.name)
  flags:     i32                   ;; bit0 strict, bit1 isGenerator*, bit2 isAsync* (*#2929)
}
$Frame = struct {
  meta:   (ref $FuncMeta)
  pc:     (mut i32)
  regs:   (ref $Regs)              ;; array (mut anyref), length = regCount
  envRec: (ref null $EnvRec)       ;; §14 chain head (Phase 1: the global record)
  parent: (ref null $Frame)        ;; caller frame (debug/stack traces; NOT control flow)
}
$EnvRec = struct {                 ;; doc §14, shared with #2925/#2864 — coordinate, do not fork
  kind:    i32                     ;; 0 declarative | 1 object | 2 global
  parent:  (ref null $EnvRec)
  names:   anyref                  ;; declarative: name→slot map carrier; object/global: null
  slots:   (ref null $Regs)        ;; declarative: mutable boxed slots
  backing: anyref                  ;; object/global: the backing $Object (globalThis for global)
}
```

### Encoding

- `code` is an **i32 array**; one instruction = `op | (a << 8) | (b << 20)`
  packed, with `op` an 8-bit opcode, `a`/`b` 12-bit unsigned operands
  (register index / const-pool index / jump-target low bits). Ops needing a
  wider immediate (jump targets, big const indices) use a trailing extension
  word (op flag bit 7). Rationale: dense `br_table` dispatch on `op & 0x7f`,
  no variable-length decode in the hot loop beyond one optional extra word.
- Jumps are **absolute PCs** (not relative) — simpler patching in the
  emitter; the emitter back-patches forward references.
- The **disassembler** (E1 deliverable) renders `pc: OpName a, b  ;; const`
  and is the debugging contract — no blind-in-Wasm debugging.

### Phase-1 opcode set (34 ops)

| Group      | Ops                                                                                                                             | Semantics (all values boxed-any)                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| const/reg  | `LdaConst c` · `LdaUndef` · `LdaNull` · `LdaTrue` · `LdaFalse` · `LdaZero` · `Star r` · `Ldar r` · `Mov r1,r2`                  | pool load → acc; acc↔reg moves                                                                                                                                                                                                                                                                                                                                              |
| arith/cmp  | `Add r` · `Sub r` · `Mul r` · `Div r` · `Mod r` · `Neg` · `Not` · `TypeOf` · `Eq r` (==) · `StrictEq r` (===) · `Lt r` · `Le r` | `acc = op(regs[r], acc)`; delegates to the EXISTING generic runtime ops (`__any_add`-family / coercion-engine siblings — the #2927 generic-built-in audit surface). ToPrimitive/ToNumber live in those helpers, NOT in the loop                                                                                                                                             |
| property   | `GetProp c` (named, key from pool) · `GetElem r` (dynamic key in regs[r]) · `SetProp c, r` · `SetElem rK, rV`                   | route through `__dyn_member_get` (#3053) / `__extern_set` — the SAME dynamic MOP the AOT path uses; Proxy/chain semantics come free per #3031 §0.1                                                                                                                                                                                                                          |
| variables  | `LdGlobal c` · `StGlobal c` · `LdName c` · `StName c`                                                                           | Phase 1: `LdName/StName` walk the `$EnvRec` chain rooted at global (root miss ⇒ typed ReferenceError, §14); `LdGlobal/StGlobal` are the root-only fast case                                                                                                                                                                                                                 |
| calls      | `Call rArgsBase, argc` (callee in acc, receiver = argsBase[0]) · `Construct rArgsBase, argc` · `CallBuiltin c, rArgsBase, argc` | contiguous register windows for args (the emitter allocates arg windows; avoids per-call array alloc). Callee dispatch = the #3098 classifier: compiled closure → `__apply_closure`; interpreted callee ($FuncMeta-backed closure) → push new `$Frame`, iterate (NO host stack recursion for interp→interp calls — loop-with-frame-stack, suspension-ready); else TypeError |
| control    | `Jump t` · `JumpIfTrue t` · `JumpIfFalse t` (ToBoolean via `__is_truthy`) · `Return` (acc = result)                             | absolute PC                                                                                                                                                                                                                                                                                                                                                                 |
| exceptions | `Throw` · (no TryStart/TryEnd ops — see below)                                                                                  | `Throw` raises the same Wasm exn tag AOT throw uses                                                                                                                                                                                                                                                                                                                         |

**Exception regions are a side table, not opcodes** (deviation from the
#2928 sketch's `TryStart/TryEnd`, deliberate): the dispatch loop wraps
opcode execution in a Wasm `try_table`; on catch it consults
`meta.exnTable` for the innermost row containing `pc`, stores the caught
value into `regs[handlerReg]`, sets `pc = handlerPC`, continues; no row →
write back frame state and rethrow across the boundary (E4). Rationale:
zero cost on the non-throwing path, no paired-opcode invariants for the
emitter to break, and it matches how the AOT lane already uses EH tags.
`finally` compiles to duplicated/jump-threaded blocks (the standard
bytecode answer; revisit only if size measurements object).

### Call protocol (AOT ↔ interpreted, E2's contract)

An interpreted function value is an ordinary **closure struct** whose code
pointer is the single exported trampoline `__interp_enter(meta, envRec,
thisArg, argsVec) -> anyref` and whose capture slot holds the `$FuncMeta`.
Consequence: to every AOT call site (and to #3098's `__invoke_cb_n`
classifier), an interpreted function is _indistinguishable_ from a compiled
closure — call dispatch needs **zero** interpreter-awareness anywhere in
codegen. `__interp_enter` allocates the `$Frame` (regs from `regCount`),
copies args into the param registers, runs the loop, returns `acc`.
Interp→AOT calls go through `Call`'s classifier arm (`__apply_closure`).
Both directions preserve `ref.eq` identity by construction (one value rep).

### Dispatch loop shape (E1; perf notes for the ADR)

`while (true) { const w = code[pc]; switch (w & 0x7f) { … } }` — js2wasm
lowers dense switches to `br_table` (#1715 proof). `pc`, `code`, `consts`,
`regs` cached in typed locals; `$Frame.pc` written back only at `Call`/
`Throw`-across-boundary/`Return` (and, later, suspension). Every opcode
handler is a small straight-line block; helpers (`__any_add`, truthiness,
MOP calls) are direct calls. Record observed hot-path boxing in the ADR
(acceptance from #2928).

## Emitter notes (ESTree→bytecode, Phase 1 coverage)

Expression statements, var/let/const (Phase 1: all function-scoped to
registers; TDZ = later), if/else, while/for/do, break/continue (to jump
targets; labels = emitter bookkeeping, no opcode), binary/unary/logical
(short-circuit via JumpIf\*), member get/set, calls/new, object/array
literals (emit via `CallBuiltin %ObjectLiteral%`/`%ArrayLiteral%` runtime
helpers rather than dedicated opcodes — fewer ops, same cost class),
`throw`, try/catch/finally (exn table), function declarations/expressions
(nested `$FuncMeta` in the pool + closure creation via `CallBuiltin
%MakeClosure%`; capture semantics Phase 1 = **none** — Function-ctor bodies
and indirect eval are global-scope, §20.2.1.1; declarative records land
with #2929). Register allocation: trivial stack-discipline allocator
(expression temporaries pushed/popped; locals pinned low), `regCount`
finalized at emit end.

## What this issue does NOT decide

- Generator/async opcodes + frame suspension encoding (#2929; the `$Frame`
  layout above is the agreed carrier, coordinate with #2864's `$Frame`
  before freezing field order).
- The `$EnvRec` declarative-record internals (#2925 owns the name-map
  carrier; §14 is the contract).
- Tier-up / inline caches / profiling — non-goals (doc §9).

## Acceptance criteria

1. This spec (amended by review) lands as `docs/adr/0019-bytecode-isa.md`
   in the E1 PR, with the encoding + opcode table + exn-table format +
   trampoline contract exactly as implemented.
2. E1 library (`src/interp/`: opcodes, encoder, emitter, loop,
   disassembler) runs the fixture corpus in **Node against node-acorn**
   (no Wasm): arithmetic/control/property/call/try fixtures + a
   differential check vs `eval` on ≥50 sampled constant-string test262
   eval bodies.
3. The loop + emitter typecheck in the js2wasm-compilable strict subset
   (`tsc` project gate), ready for E2 self-compile.
4. No opcode carries a runtime-type assumption (audit: every operand is
   boxed-any; the generic-runtime-op delegation list is complete).

## Effort estimate

L: the ISA freeze + encoder/loop skeleton is the Fable-grade half (this
spec cuts it to review + implement); the emitter coverage + fixtures are
Opus-executable grind. Fully parallel to all substrate work — the ideal
"budget-window filler" XL-adjacent rock with zero merge-conflict surface
(new directory).
