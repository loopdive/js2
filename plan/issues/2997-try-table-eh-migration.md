---
id: 2997
title: "Migrate legacy Wasm EH (try/catch 0x06/0x07) to try_table so binaries run under modern wasmtime/wasmer"
status: in-review
sprint: Backlog
created: 2026-07-02
priority: medium
horizon: xl
feasibility: hard
model: fable
task_type: refactor
area: codegen
language_feature: exceptions
goal: standalone-mode
related: [2968, 2962, 1473]
origin: "follow-up filed from #2968 wrap-up (wasmtime rejects legacy EH opcodes)"
---

# Migrate legacy Wasm exception-handling opcodes to `try_table`

## Problem

The compiler emits the **legacy** Wasm exception-handling encoding — `try`
(`0x06`), `catch` (`0x07`), `catch_all`, `delegate`, `rethrow` — from the first
(withdrawn) exception-handling proposal. V8/Node and the #2962 exception-render
harness accept these opcodes, but **modern wasmtime (46+) rejects them**:

```
Error: WebAssembly translation error
Caused by: Invalid input WebAssembly code ... legacy_exceptions feature
required for try instruction
```

wasmtime (and wasmer) implement only the **standardized** exception-handling
proposal, which replaces the legacy stack-structured `try/catch` with
`try_table` (`0x1F`) + `throw_ref`. As a result, **any** js2wasm binary that
uses `try/catch` — whether a user-written `try { … } catch { … }`, or the
`_start` uncaught-exception wrapper added in #2968 — fails to even validate
under a current standalone WASI runtime.

This is a **compiler-wide gap**, not specific to any single feature. It was
surfaced while wrapping up #2968 (WASI `_start` exception printer): that fix is
correct and validated under `node:wasi`, but its acceptance criterion mentioned
wasmtime specifically, and wasmtime can't load the binary because of this
pre-existing legacy-EH encoding — identical to how an ordinary user `try/catch`
already fails under wasmtime on clean `origin/main`.

## Scope

Migrating from legacy EH to `try_table` is not a localized change — it touches
every place the instruction tree is produced, encoded, or walked:

- **Emitter / encoder** — the opcode encoding for `try`/`catch`/`catch_all`/
  `delegate`/`rethrow` must be replaced with `try_table` (which takes an inline
  block type + a vector of catch clauses, each `(tag, label)` / `catch_all`),
  and `throw` handling reworked to the `throw` / `throw_ref` model. The
  structured `try`/`end` block nesting changes to a single `try_table` block
  whose body branches to handler labels.
- **Instruction-tree walkers** — every pass that traverses or rewrites the
  instruction tree and currently special-cases the legacy `try`/`catch`
  structure: dead-code elimination / index remapping, the funcidx-shift fixups
  (`addUnionImports` / late-import shifting), stack-balance validation, and the
  WAT pretty-printer / disassembler.
- **Control-flow / label model** — legacy `catch` is a stack-structured landing
  pad; `try_table` catch clauses branch to ordinary block labels, so the label
  map and branch-depth accounting must account for the catch-target labels.

Because of that breadth this is a **hard, XL** refactor and needs a proper
architect spec before implementation — do **not** attempt it as an inline fix.

## Acceptance criteria

- The compiler emits `try_table` (+ `throw`/`throw_ref`) instead of legacy
  `try`/`catch`/`catch_all`/`delegate`/`rethrow`.
- A `--target wasi` binary using `try/catch` (and the #2968 `_start` wrapper)
  **validates and runs under wasmtime 46+**, printing the expected stderr and
  exiting nonzero on an uncaught throw.
- V8/Node execution and the #2962 exception-render harness remain correct
  (no regression in host or standalone lanes); test262 conformance is unchanged
  or improved.

## Notes

- Needs an architect spec (functions, exact opcode encodings, the catch-clause
  label lowering, and the pass-by-pass walker changes) before dev work.
- Reference: the WebAssembly exception-handling proposal (`try_table` /
  `throw_ref`) and wasmtime's `legacy_exceptions` gate.

---

## Implementation Plan

### Root cause

Every exception region is compiled to a single legacy structured `try` IR op
(`{ op: "try", blockType, body, catches, catchAll }`) whose binary encoding
(`src/emit/binary.ts` case `"try"`) emits `0x06 … 0x07 … 0x19 … 0x0b`, and whose
re-raise uses `rethrow` (`0x09`). wasmtime/wasmer implement only the
**standardized** proposal, which removed the legacy `try`/`catch`/`catch_all`/
`delegate`/`rethrow` stack-structured landing-pad model. The standardized
encoding is:

- `try_table bt vec(catch)` (`0x1F`) — behaves like a `block`; on a matching
  throw inside the body it pushes the caught operands and **branches to a label**
  (relative depth), then `end` (`0x0b`).
- Each catch clause in the vector is `kind:u8` + operands:
  - `0x00 catch      tag label` — push tag args, `br label`
  - `0x01 catch_ref  tag label` — push tag args **+ exnref**, `br label`
  - `0x02 catch_all      label` — `br label`
  - `0x03 catch_all_ref  label` — push **exnref**, `br label`
- `throw tag` (`0x08`) — **UNCHANGED** across both proposals.
- `throw_ref` (`0x0A`) — pop an `exnref`, re-raise it.
- `rethrow` (`0x09`) and `delegate` (`0x18`) — **REMOVED**. Re-raise is now
  "capture the exnref via `catch(_all)_ref`, hold it in a local, `throw_ref` it".

The structural consequence: handlers no longer nest _inside_ a landing pad —
they sit in **enclosing blocks** that the catch clauses branch _out_ to. So a
`try/catch` lowers to wrapper `block`s around the `try_table`, and every
outward-targeting `br`/`return`/break/continue inside the region must have its
label depth adjusted for the added wrapper levels.

### Feasibility & recommended slicing

This is genuinely **XL** and must NOT be one atomic PR. The decisive
simplification is that the **only lane that requires the change is
wasi/standalone** (the lanes that must load under wasmtime). The JS-host lane
targets V8/Node, which **accept the legacy encoding** — so we keep legacy EH
there and stay **byte-inert** for every existing host-lane test (the entire
~33 k test262 baseline runs under Node). This makes the migration a
**target-gated dual encoding**, not a hard cutover, which both de-risks it and
slices it naturally.

Two more facts make the wasi/standalone subset much smaller than the general
case (verified in `src/codegen/statements/exceptions.ts`):

1. `const skipCatchAll = ctx.wasi || ctx.standalone;` (line 549) — the
   host-foreign-exception `catch_all` + `__get_caught_exception` handler is
   **already dead-code-eliminated** in standalone. So the only `catch_all` that
   survives in wasi/standalone is the **try/finally re-raise** helper (line 390).
2. In wasi/standalone **every** thrown value goes through the single `$exc` tag,
   whose signature is `(externref) -> ()` (`ensureExnTag`,
   `src/codegen/registry/imports.ts:176`). There are no foreign (non-`$exc`)
   exceptions (Wasm traps are not catchable). Therefore **re-raise can be
   lowered as `local.get $exn ; throw $excTag`** on the captured externload —
   `exnref` / `throw_ref` are **not needed** for the wasmtime target. (Keep
   `catch_all_ref` + `throw_ref` documented as the fully-general form for a
   later host-lane cutover, but do not build it in slice 1.)

Recommended slices:

- **Slice 1 (this issue — unblocks the wasmtime acceptance criterion):**
  target-gated `try_table` for **wasi/standalone only**, `$exc`-tag externref
  model, re-raise via `throw $excTag` (no exnref/throw_ref). Host lane keeps
  legacy `try`. Covers try/catch, try/finally, try/catch/finally, nested,
  `throw e` rethrow fast-path. Delivers: wasmtime 46+ loads & runs a
  `--target wasi` try/catch binary and the #2968 `_start` wrapper.
- **Slice 2 (follow-up):** introduce the `exnref` valtype + `throw_ref` +
  `catch_all_ref`, and flip the **JS-host lane** to `try_table` too (V8/Node
  already accept it), then delete the legacy `try`/`catch`/`rethrow` encoding and
  the `env::__get_caught_exception` host import path. This retires legacy EH
  entirely. Gate behind its own conformance run.
- **Slice 3 (optional):** wasmer parity + a standalone EH conformance smoke test
  in CI (wasmtime run of a try/catch fixture).

### New IR op (keep legacy `try` intact)

Add a **new** op rather than mutating `{op:"try"}` — that preserves byte-inert
host output and lets the encoder own the wrapper-block/label synthesis.

**File: `src/ir/types.ts`** (union near lines 333–335, `CatchClause` at 460)

- Add:
  ```ts
  | { op: "try_table"; blockType: BlockType; body: Instr[];
      catches: TryTableCatch[] }
  | { op: "throw_ref" }            // slice 2 only
  ```
  with
  ```ts
  export interface TryTableCatch {
    kind: "catch" | "catch_ref" | "catch_all" | "catch_all_ref";
    tagIdx?: number; // present for catch / catch_ref
    /** handler body — the encoder lowers this into an enclosing block the
     *  clause branches out to; NOT emitted inline in the try_table vector. */
    handler: Instr[];
    /** externref catch-var local the handler expects the payload in (or
     *  undefined for value-less catch_all). */
    payloadLocal?: number;
  }
  ```
- Keep `{op:"try"}`, `{op:"rethrow"}` in the union (legacy host path still uses
  them).

Design note for the dev: model the handler bodies as **structured children**
(like today's `catches[].body`/`catchAll`) and let the **binary/WAT emitter**
synthesize the `block $join / block $handler … / try_table (catch … L) … end /
br $join / end / <handler> / end` scaffold and compute the relative label
depths. This keeps the codegen lowering shape close to today's and **localizes
the fragile depth math to one place**. See "Branch-depth accounting" below for
the unavoidable body-depth fixup that the emitter must still apply.

### Codegen lowering

**File: `src/codegen/statements/exceptions.ts`**

- `compileTryStatement` (line 252) and `compileThrowStatement` (line 209): gate
  on `ctx.wasi || ctx.standalone`. When set, emit the new `try_table` op and the
  externref-rethrow model; otherwise emit the existing legacy `try`/`rethrow`
  unchanged.
- `compileThrowStatement` rethrow fast-path (lines 213–228): in the gated path,
  instead of `{op:"rethrow", depth}`, emit `local.get $exnLocal ; throw $excTag`
  where `$exnLocal` is the catch-var externref local recorded on
  `catchRethrowStack`. **`catchRethrowStack` entries need the exn local index
  added** (currently `{varName, depth}` — add `exnLocalIdx`). The `throw`
  opcode itself is unchanged.
- try/finally re-raise (lines 388–395): in the gated path, lower the
  finally-without-catch helper as `catch_all` (kind `"catch_all"`) whose handler
  runs the cloned finally then `local.get $exn ; throw $excTag`. To have `$exn`,
  use `catch $excTag` (capture the externref payload) rather than a value-less
  `catch_all` — i.e. emit a `catch` clause for `$excTag` whose handler runs
  finally + re-throw. (Traps aren't catchable and no non-`$exc` tag exists in
  standalone, so `$exc`-only coverage is complete.)
- Inner-try-wraps-catch-body finally re-raise (lines 526, 572): same
  substitution — the `{op:"try", …, catchAll:[…rethrow]}` inner wrapper becomes a
  `try_table` with a `catch $excTag` handler doing `finally ; throw $excTag`.

**Branch-depth accounting (the sharp edge).** Legacy `try` is **one** label
level; the current code bumps break/continue/return/rethrow depths by **+1**
inside the try/catch/finally bodies (e.g. lines 339–342, 450–452, and
`cloneFinallyAtDepth`). `try_table` is _also_ one label level, but its handlers
require **wrapper blocks** (`$join` + one `$handler` per catch clause) enclosing
it, adding **N extra levels** (N = number of catch handlers + 1) that every
**outward-targeting** branch inside the body/handlers now crosses.

Recommended handling: let the **emitter** insert the wrapper blocks and, in the
same pass, rewrite outward branch depths — reuse the existing
`bumpOuterBranchDepths` walker (lines 57–82; it already treats `try` as a label
op — **add `try_table` to its `isLabelOp` set at line 78**) to add `+N` to
`br`/`br_if`/`br_table` targets that escape the try*table body. Internal
branches (targeting labels created \_inside* the body) keep their relative depth.
This is the single most error-prone part — spec a dedicated unit test matrix
(break/continue/return-inside-try-with-finally, `continue outer`, nested try)
mirroring the #993/#1858 finally cases.

### Emitter / encoder

**File: `src/emit/opcodes.ts`** (OP table, lines 9–22)

- Add `try_table: 0x1f`, `throw_ref: 0x0a`. Keep `throw: 0x08` (unchanged);
  legacy `try/catch/catch_all/delegate/rethrow` stay for the host lane.
- Add catch-clause kind bytes as local constants in the encoder (not runtime
  opcodes): `catch=0x00, catch_ref=0x01, catch_all=0x02, catch_all_ref=0x03`.

**File: `src/emit/binary.ts`** (EH cases at 1464–1491)

- Keep the existing `"throw"` / `"rethrow"` / `"try"` cases.
- Add a `case "try_table"`:
  1. Emit the wrapper `block`s ($join outermost, then one `$handler`block per
catch clause with the handler's result type = the catch payload type, i.e.`externref`for`catch $exc`, empty for value-less `catch_all`).
  2. Emit `OP.try_table`, then `encodeBlockType(blockType)`, then
     `enc.vector(catches, …)` writing each clause as `kind:u8` + (`tagIdx` u32
     for catch/catch_ref) + `label` u32 (the computed relative depth from the
     try_table to the clause's `$handler` block).
  3. Emit the `body` instrs, then `OP.end` (closes try_table).
  4. Emit `br $join`, then for each catch clause: close its `$handler` block
     (`OP.end`), emit the handler body (which starts by `local.set $payloadLocal`
     when it captures a value), and finally `OP.end` to close `$join`.
  - `vIdx("exception tag", …, valCtx.numTags)` validation for each `tagIdx`, as
    the legacy `"try"`/`"throw"` cases already do (lines 1465, 1479).
- Add `case "throw_ref": enc.byte(OP.throw_ref)` (slice 2).

**File: `src/emit/wat.ts`** (try printer at 342–359, throw/rethrow at 454–457)

- Add a `case "try_table"` printer emitting
  `(block $join (block $handler … (try_table (catch $t L) … ) br … ) …)` — the
  same synthesized shape as the binary path, so WAT and binary agree. Add
  `throw_ref` printing (slice 2). Keep legacy `try`/`rethrow` printers.

### Instruction-tree walkers

Every walker that special-cases `"try"` must also recognize `"try_table"`. The
new op carries `body` + `catches[].handler` (no `catchAll` field), so update
child-traversal accordingly.

- **`src/codegen/walk-instructions.ts`** (51–56): the canonical child walker —
  add: if `op === "try_table"`, `fn(body)` and `fn(c.handler)` for each catch.
  Fixing this one covers every consumer that routes through `walkChildren`
  (including `bumpOuterBranchDepths`).
- **`src/codegen/stack-balance.ts`** — the try op is special-cased in five
  places: dead-code elim (209–220), stack-balance fix (1078–1109), value-flow
  (1518–1550), local-liveness (1890–1898), and repair (2639–2671). Each needs a
  parallel `"try_table"` branch. Also add `"try_table"` to the **label-op sets**
  (lines 78, 506, 795, 1347, 2397) and confirm the **terminator sets**
  (185–186, 277–278, 2016–2017) — `throw` stays a terminator; `throw_ref` is a
  terminator too (add it). `getTagArity` (1028) applies unchanged to
  `try_table`'s `catch $tag` handlers.
- **`src/emit/binary.ts` validation context (`valCtx`)** — the wrapper blocks
  the encoder synthesizes shift no function/type/tag indices (they add only
  label depth, resolved locally), so `addUnionImports` / late-import funcidx
  shifting is unaffected _as long as_ the new op's `body`/`handler` arrays are
  reached by the existing shift walker. They are structured `Instr[]` children,
  so the same `savedBodies` tracking used for legacy `try` bodies
  (exceptions.ts pushes `tryBody`/`catchBody`/`finallyInstrs` into
  `fctx.savedBodies`) must push the `try_table` body + handler arrays. Verify no
  orphaned array escapes shift tracking.

### IR backend

**File: `src/ir/backend/wasmgc-emitter.ts`** (`emitTry`/`emitThrow`/`emitRethrow`
at 195–221) and the trait in **`src/ir/backend/emitter.ts`** (196–214): the IR
WasmGC backend realizes EH **byte-identically** to the direct path. Route the
gated `try_table` lowering through the same helper so both front-ends
(direct-AST and IR) produce identical output. `src/ir/backend/legality.ts`
(102, 256) already gates on the presence of a catch clause — no change to the
legality decision, only to what `emitTry` emits when `ctx.wasi || ctx.standalone`.

**File: `src/codegen-linear/index.ts`** — **no change**. The linear backend
already **refuses** `try/catch` with a compile error (line 813–821, "does not
yet lower JS exception handling"); it never emits EH opcodes.

### Edge cases

- **Nested try/catch** — each nested region gets its own `$join`/`$handler`
  wrappers; the `+N` outward-depth bump composes with the existing per-level +1
  bumps. This is the primary regression risk — test 2- and 3-deep nesting with
  break/continue/return crossing multiple regions.
- **catch_all** — in wasi/standalone the only surviving `catch_all` is the
  try/finally re-raise, lowered as a `catch $excTag` handler (see above). The
  host-foreign `catch_all` + `__get_caught_exception` path stays on the legacy
  encoding (host lane) until slice 2.
- **rethrow (`throw e`)** — becomes `local.get $exnLocal ; throw $excTag`; only
  valid when the catch var is unmodified (the existing `catchVarIsReassigned`
  guard at line 154 still applies — if reassigned, `throw e` already compiles the
  local's current value via `throw`, which is unchanged).
- **finally semantics** — finally is already inlined on every exit path by
  codegen (returns/break/continue clone the finally; exceptional exit uses the
  catch/catch_all wrapper). The migration only changes the exceptional-exit
  re-raise (`rethrow` → `throw $excTag`); the normal/return/break/continue
  finally inlining is opcode-agnostic and unchanged.
- **finally with `break outer`/`continue outer`/`return`** — depends on the
  `bumpOuterBranchDepths` +N correction being right (the #993/#1858 hazard).
  Port those exact regression cases to the gated path.
- **throw of a non-object / null** — unchanged; `throw` opcode and the externref
  payload coercion (compileThrowStatement lines 232–249) are identical.
- **generators/async** — `generators-native.ts` emits bare `{op:"throw", tagIdx}`
  (lines 1578, 2063, 2224). `throw` is unchanged, so these need **no** change.
  If a generator body contains a user `try/catch`, it flows through
  `compileTryStatement` and picks up the gated lowering automatically.

### Rollout / non-regression strategy

**Byte-inert for host lanes.** Slice 1 gates the new lowering strictly behind
`ctx.wasi || ctx.standalone`. The default JS-host lane keeps emitting legacy
`try`/`catch`/`rethrow`, so every existing host-run test (equivalence + the full
test262 baseline, which executes under Node) produces **identical bytes** — zero
regression surface. Confirm with a sha256 of a host-lane fixture binary
before/after (the standard byte-inert gate).

**Positive validation for the wasmtime lane.** Add a fixture that compiles a
`--target wasi` `try { throw new Error("x") } catch (e) { … }` (and the #2968
`_start` wrapper) and asserts it **loads and runs under wasmtime 46+** (nonzero
exit + expected stderr on uncaught throw). Also keep the `node:wasi` run green.

**Optimizer.** `--optimize` runs Binaryen wasm-opt; modern Binaryen supports
`try_table`, but pin/verify the vendored version handles it, and run the wasmtime
fixture with `-O` too. Flag as a risk if the bundled wasm-opt predates
`try_table` support.

### Files to touch (summary)

| File                                   | Change                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ir/types.ts`                      | add `try_table` op + `TryTableCatch` (+ `throw_ref` slice 2)                                                                          |
| `src/emit/opcodes.ts`                  | add `try_table 0x1f`, `throw_ref 0x0a`, clause-kind bytes                                                                             |
| `src/emit/binary.ts`                   | `case "try_table"` (+ wrapper-block/label synthesis), `throw_ref`                                                                     |
| `src/emit/wat.ts`                      | `try_table` + `throw_ref` printers                                                                                                    |
| `src/codegen/statements/exceptions.ts` | gated lowering; `catchRethrowStack` gets `exnLocalIdx`; rethrow→`throw $excTag`; add `try_table` to `bumpOuterBranchDepths` label ops |
| `src/codegen/walk-instructions.ts`     | descend `try_table` body + handlers                                                                                                   |
| `src/codegen/stack-balance.ts`         | 5 try special-cases + label-op/terminator sets get `try_table`/`throw_ref`                                                            |
| `src/ir/backend/wasmgc-emitter.ts`     | route gated lowering through `emitTry`                                                                                                |
| `src/codegen-linear/index.ts`          | **no change** (already refuses EH)                                                                                                    |
| `src/codegen/generators-native.ts`     | **no change** (`throw` unchanged)                                                                                                     |

### Re-grounding note (2026-07-12, fable-arch @ upstream/main 31b1970cfb)

The plan above remains valid; anchors spot-checked against current main:

- `src/codegen/statements/exceptions.ts` — `compileThrowStatement` :209,
  `compileTryStatement` :252, `skipCatchAll` :549, `bumpOuterBranchDepths`
  :57-80: **exact**.
- `src/emit/opcodes.ts` — `try: 0x06` :9, `throw: 0x08` :11,
  `rethrow: 0x09` :12, `delegate: 0x18` :21: **exact**.
- `src/emit/binary.ts` — the EH cases drifted ~14 lines up: `"throw"` :1450,
  `"rethrow"` :1455, `"try"` :1459 (plan cites 1464–1491). Re-grep before
  editing.
- `src/codegen/walk-instructions.ts` — catches/catchAll descent :51-52:
  **exact**.

Slice 1 is dev-dispatchable as written (target-gated wasi/standalone
`try_table`, host lane byte-inert). Status: this issue no longer "needs
architect spec first" — the spec is above.

### Test files / fixtures to verify

- New: `--target wasi` try/catch fixture run under **wasmtime 46+** (load +
  nonzero exit + stderr) and under `node:wasi` (both green).
- Byte-inert sha256 of a **host-lane** try/catch/finally binary (unchanged).
- Port the finally/break-continue-return depth regressions from #993 and #1858
  to the gated path (nested try, `continue outer` inside finally).
- The #2962 exception-render harness stays green (host lane, unchanged bytes).

## Implementation status — 2026-08-20

The target-gated migration is implemented for standalone/WASI output while the
JavaScript-host lane retains the legacy encoding. The implementation adds the
`try_table` IR, binary/object/WAT encoders, structured branch-depth retargeting,
walker/fixup support, and matching IR-backend lowering.

Focused coverage now proves:

- simple catch, nested catch/rethrow/finally, break/continue, and return-through-
  finally semantics;
- a real WASI exception module executing under current Wasmtime;
- the pinned `deno_core` 0.407.0 wrapper transaction precompiling under
  Wasmtime 47 and booting in two isolated stores with probe value `42`; and
- the JavaScript-host lane continuing to use the legacy representation.

The broader host-lane conversion to `exnref`/`throw_ref` remains the separately
scoped slice 2 and is not required by the Deno/Wasmtime prototype.
