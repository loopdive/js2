---
id: 1713
title: "IR backend-trait: audit WasmGC bias in lower.ts + define BackendEmitter seam"
status: done
created: 2026-05-29
updated: 2026-05-29
completed: 2026-05-29
priority: high
feasibility: hard
reasoning_effort: high
task_type: refactor
area: ir, codegen, architecture
language_feature: n/a
goal: backend-agnostic-ir
sprint: 57
required_by: [1714, 1715]
es_edition: n/a
related: [1131, 1527, 1530, 1584, 1714, 1715]
needs_architect_spec: true
---
# #1713 — IR backend-trait: audit WasmGC bias in `lower.ts` + define a `BackendEmitter` seam

## Problem

`src/ir/lower.ts` (~2,460 lines) is the IR→Wasm emission pass. It emits WasmGC
ops (`struct.new`, `struct.get`, `struct.set`, `array.get`, `ref.cast`,
`array.new_fixed`, …) **inline in its per-IR-node switch**. There is no backend
boundary: the mapping from IR-node intent ("read field N of this object",
"build a closure cell", "box a scalar") to concrete WasmGC ops is hardcoded.

The codegen-axes doc (`docs/architecture/codegen-axes.md`, "Current hidden bias
in `src/ir/`" table) already enumerates the leak points and states the intent:

> The architecture admits an IR adoption on the linear backend (a
> `lower-linear.ts` sibling) … When [a node kind demands it], the lift becomes
> worth the cost.

This issue does that lift's *foundation*: extract a `BackendEmitter` trait so a
backend becomes a visitor over IR-node emission intents, not a hardcoded switch
arm. It blocks both #1714 (lower one kind to two backends) and #1715 (bytecode
proof) — neither can proceed until the seam exists.

## Why `feasibility: hard` / needs architect spec

This touches the central IR emission pass. The risk is a behavior-changing
refactor regressing test262. The design questions that need an architect spec
before any dev work:

1. **Granularity of the trait.** Too fine (one method per Wasm op) and it's
   just a renamed `Instr` constructor — no abstraction. Too coarse (one method
   per IR node kind) and each backend re-implements the whole switch. The right
   level is *semantic emission primitives*: `emitStructNew(layout, fields)`,
   `emitFieldGet(layout, fieldName)`, `emitFieldSet`, `emitArrayGet(elemType)`,
   `emitArrayLen`, `emitBoxScalar(valType)`, `emitUnboxScalar`,
   `emitClosureCell`, `emitCallRef(sig)`, `emitConst`, `emitLocalGet/Set`,
   `emitBranch`, `emitReturn`. The architect must enumerate the actual set by
   walking `lower.ts`'s emission sites and clustering them.
2. **Where layout decisions live.** The WasmGC layout (`union.typeIdx`,
   `obj.fieldIdx(name)`, `vec.arrayTypeIdx`) is computed in the alloc-registry
   passes. The trait must take *abstract layout handles* (a struct identity, a
   field name) and let the backend resolve them to its representation (a WasmGC
   typeIdx vs a linear-memory offset vs a bytecode constant-pool index). The
   spec must decide what the layout-handle type is and how the `WasmGcEmitter`
   maps it back to today's `typeIdx`/`fieldIdx`.
3. **Type representation at the seam.** `IrType` is already backend-neutral
   (`nodes.ts` separates it from `ValType`). Confirm the trait consumes
   `IrType`/abstract layout handles, never raw `ValType`/`typeIdx`, except
   inside `WasmGcEmitter`.

## Scope (Sprint 57)

Phase 1 — the seam + behavior-identical WasmGC implementation. NOT a second
backend (that's #1714/#1715).

1. Architect writes `## Implementation Plan` enumerating the emission primitive
   set, the layout-handle abstraction, and the `lower.ts` call sites that move
   behind each primitive (with line refs against current main).
2. Define `BackendEmitter` interface (likely `src/ir/backend/emitter.ts`).
3. Implement `WasmGcEmitter implements BackendEmitter` (likely
   `src/ir/backend/wasmgc-emitter.ts`) that produces the *exact same* `Instr`
   stream `lower.ts` produces today.
4. Refactor `lower.ts` to route emission through the trait instance instead of
   pushing `Instr`s inline, for the node kinds the spec covers. (The spec may
   stage this — not every node kind must move in one PR; the audit defines the
   order. A partial but clean seam is acceptable as long as the moved kinds are
   100% behind the trait and the rest are explicitly flagged as not-yet-moved.)
5. Update the codegen-axes "Current hidden bias" table to mark which leaks are
   now behind the trait.

## Acceptance criteria

1. A `BackendEmitter` trait exists, consumed by `lower.ts`; a `WasmGcEmitter`
   implements it.
2. **Zero conformance delta** — this is a pure refactor. test262 pass count is
   unchanged (±0 net; any change is a bug). The IR fallback budget
   (`pnpm run check:ir-fallbacks`) does not grow.
3. The emission primitives the spec enumerated are routed through the trait;
   `lower.ts` no longer pushes WasmGC `Instr`s inline for those node kinds.
4. The codegen-axes doc "Current hidden bias" table is updated.
5. The architect spec (`## Implementation Plan`) is committed in this issue
   before dev dispatch.

## Notes / scope

- This is the enabling refactor. It must NOT try to also add a second backend
  — that scope is #1714 (linear) and #1715 (bytecode), which depend on this.
- Keep `src/ir/types.ts` (the shared Wasm `Instr` union) as-is — per the
  codegen-axes doc it is shared Wasm-encoding bookkeeping, not IR coupling. The
  trait sits *above* `Instr`; `WasmGcEmitter` still produces `Instr`.
- Reasoning effort high; route to architect for the spec before any dev claims.

---

## Implementation Plan

> Architect spec. Branch off fresh `origin/main` (or `origin/plan-sprint57` if
> PR #900 has not yet merged — this spec PR then merges after #900). Audit done
> against `src/ir/lower.ts` @ `plan-sprint57` (2462 lines). All `file:line`
> below are at that revision; a dev should re-grep before editing.

### Root cause / what the seam is

`src/ir/lower.ts` already has **half** the seam: `IrLowerResolver`
(`lower.ts:183–321`) abstracts *layout* — it maps an abstract IR type (a vec
value, an object shape, a union) to a layout handle (`IrVecLowering`,
`IrObjectStructLowering`, `IrUnionLowering`, … `lower.ts:64–181`). What it does
**not** abstract is *op emission*: every switch arm in `emitInstrTree`
(`lower.ts:704–1932`) reads the layout handle and then **pushes WasmGC `Instr`s
inline** — `out.push({ op: "struct.get", typeIdx: …, fieldIdx: … })`. The
layout handle leaks the WasmGC representation (`typeIdx`/`fieldIdx`) into the
otherwise backend-neutral switch, and the `Instr` kind is hardcoded WasmGC.

The string ops are the existing proof that the seam is viable: `string.const`,
`string.concat`, `string.eq`, `string.len` (`lower.ts:956–987`) do **not** push
ops inline — they call `resolver.emitStringConst()` / `emitStringConcat()` /
`emitStringEquals()` / `emitStringLen()` and splice the returned `Instr[]`.
That is because strings genuinely differ between backends (host externref vs
native i16 array). **`BackendEmitter` generalises that already-shipping
`emit*` pattern to the struct/array/ref ops.** This is not a new architecture —
it is finishing one that lower.ts started.

The trait therefore sits **between** the resolver (layout) and `Instr`
(encoding): `lower.ts` decides *intent* ("read field `name` of this object
value"), the emitter decides *ops* ("WasmGC: `struct.get typeIdx fieldIdx`" vs
"linear: `i32.load offset` vs "bytecode: `OP_GETFIELD slot`"). The resolver
stays as the layout-handle factory; `WasmGcEmitter` consults it, a
`LinearEmitter` consults a linear layout map, a `BytecodeEmitter` consults a
constant-pool.

### 1. Audit table — WasmGC-specific emission sites in `lower.ts`

Every site below currently does `out.push({ op: "<gc-op>", … })` inline. The
"Emitter method" column is the primitive that replaces it. Counts are exact
`Instr`-push occurrences at the audited revision.

| Op (Instr.op) | Sites (lower.ts:line) | n | IR instr kind(s) served | Emitter method |
|---|---|---|---|---|
| `struct.new` (union) | 917 | 1 | `box` | `emitBox(handle, …)` |
| `struct.new` (object) | 998 | 1 | `object.new` | `emitAggregateNew(objHandle, nFields)` |
| `struct.new` (closure subtype) | 1042 | 1 | `closure.new` | `emitClosureNew(sub, …)` |
| `struct.new` (refcell) | 1100 | 1 | `refcell.new` | `emitRefCellNew(cellHandle)` |
| `struct.new` (Promise) | 1827, 1842 | 2 | `async.return/throw` | `emitPromiseNew(state)` (async group — defer) |
| `struct.get` (union val) | 934 | 1 | `unbox` | `emitUnbox(handle)` |
| `struct.get` (union tag) | 951 | 1 | `tag.test` | `emitTagLoad(handle)` |
| `struct.get` (object field) | 1013 | 1 | `object.get` | `emitFieldGet(objHandle, name)` |
| `struct.get` (closure capture) | 1059 | 1 | `closure.getCapture` | `emitCaptureGet(sub, i)` |
| `struct.get` (closure func) | 1079 | 1 | `closure.call` | `emitClosureFuncGet(cl)` |
| `struct.get` (refcell) | 1113 | 1 | `refcell.get` | `emitRefCellGet(cell)` |
| `struct.get` (class field) | 1153 | 1 | `class.getField` | `emitFieldGet(clsHandle, name)` |
| `struct.get` (vec length) | 1204, 1313 | 2 | `vec.len`, `forof.vec` | **`emitVecLen(vecHandle)`** |
| `struct.get` (vec data) | 1216, 1318 | 2 | `vec.get`, `forof.vec` | **`emitVecDataPtr(vecHandle)`** |
| `struct.get` (anyStr) | 1613 | 1 | string-len native | (string group — already behind `emitStringLen`) |
| `struct.get` (Promise) | 1884, 1900, 1914, 2038 | 4 | `await` | (async group — defer) |
| `struct.set` (object) | 1029 | 1 | `object.set` | `emitFieldSet(objHandle, name)` |
| `struct.set` (refcell) | 1127 | 1 | `refcell.set` | `emitRefCellSet(cell)` |
| `struct.set` (class) | 1167 | 1 | `class.setField` | `emitFieldSet(clsHandle, name)` |
| `array.get` | 1218, 1336 | 2 | `vec.get`, `forof.vec` | **`emitElemGet(vecHandle)`** |
| `array.new_fixed` | (string native, 280 doc) | 1 | string-const native | (string group) |
| `ref.cast` | 1058, 1085, 1872 | 3 | closure new/call, await | `emitDowncast(handle)` |
| `ref.func` | 1040 | 1 | `closure.new` | `emitFuncRef(funcIdx)` |
| `ref.null` / `ref.null.extern` | 1275, 1826, 1841, 2445, 2454 | 5 | gen.epilogue, async, const-null | `emitNull(irType)` |
| `extern.convert_any` | 1382, 1828, 1843 | 3 | coerce.to_externref, async | `emitToExternref()` |
| `any.convert_extern` | 1871 | 1 | await | `emitFromExternref(handle)` |
| `call` (funcIdx) | 711, 1262, 1276, 1293, 673 | 5 | `call`, gen.*, unbox-coerce | `emitCall(funcIdx)` |
| `call_ref` | 1086 | 1 | `closure.call` | `emitCallRef(funcTypeIdx)` |
| `local.get`/`local.set`/`local.tee` | many (680–2006) | ~40 | params, slots, SSA materialisation | `emitLocalGet/Set/Tee(idx)` |
| `global.get`/`global.set` | 715, 719 | 2 | `global.get/set` | `emitGlobalGet/Set(idx)` |
| `i32.const`/`f64.const`/etc | emitConst @ 2424 | — | `const` | `emitConst(constInstr)` |
| arithmetic (`f64.add`, `i32.eq`, `jsBitwise…`) | 816, 821, 757, 803 | — | `binary`, `unary` | `emitBinary(op)` / `emitUnary(op)` |
| `if`/`br`/`br_if`/`return`/`unreachable`/`select`/`drop` | 882, 1972, 1989, 2010, 830, 1961 | — | control flow | `emitIf/Br/BrIf/Return/Select/Drop` |

**Clustering conclusion.** The leak is dominated by **three aggregate
families** — object/class structs (field get/set/new), closures+refcells
(struct get/set/new + ref.cast + ref.func + call_ref), and **vecs**
(struct.get length/data + array.get). Plus the **ref-coercion** ops
(`extern.convert_any`, `any.convert_extern`, `ref.null`, `ref.cast`). Scalars,
locals, globals, control flow, and arithmetic are *already* backend-neutral in
shape (a stack machine emits the same skeleton) and only need a thin pass-through
emitter so the seam is total rather than partial.

### 2. The `BackendEmitter` interface

New file `src/ir/backend/emitter.ts`. The trait is the set of **emission
primitives** `lower.ts` needs; it consumes **layout handles** (the existing
`IrVecLowering` etc.) and abstract `IrType`, never raw `ValType`/`typeIdx`
outside `WasmGcEmitter`.

**Return-type convention (critical, honour exactly):** every method takes the
output sink `out: Instr[]` and **pushes** onto it (side-effecting `void`
return), mirroring today's `out.push(...)` call sites and the existing
`emitValue(v, out)` helper. The emitter does **not** return `Instr[]` to be
spliced (that is the string-op shape; we converge on push-to-sink because the
hot switch already threads `out`). Operand evaluation order is unchanged: the
caller emits operand subtrees via the existing `emitValue(v, out)` before
calling the emitter primitive, exactly as the inline code does today. The
emitter never calls `emitValue` itself — it only emits the *terminal* op(s) for
the node, so SSA/materialisation logic stays in `lower.ts`.

```ts
// src/ir/backend/emitter.ts
import type { Instr, ValType } from "../types.js";
import type { IrType } from "../nodes.js";
import type {
  IrVecLowering, IrObjectStructLowering, IrClassLowering, IrUnionLowering,
  IrClosureLowering, IrRefCellLowering, IrBoxedLowering,
} from "../lower.js"; // (or move handle types into backend/handles.ts — see §4)

export interface BackendEmitter {
  // ---- aggregate allocation -------------------------------------------
  /** Operands (field values, canonical order) already on stack → aggregate ref. */
  emitAggregateNew(layout: IrObjectStructLowering, fieldCount: number, out: Instr[]): void;
  /** Box a scalar into a tagged union. tag + val already pushed in field order. */
  emitBox(layout: IrUnionLowering, out: Instr[]): void;

  // ---- field / element access -----------------------------------------
  /** aggregate ref on stack → field value. `name` is the shape field name. */
  emitFieldGet(layout: IrObjectStructLowering | IrClassLowering, name: string, out: Instr[]): void;
  /** aggregate ref + new value on stack → (void). */
  emitFieldSet(layout: IrObjectStructLowering | IrClassLowering, name: string, out: Instr[]): void;
  /** union ref on stack → scalar val (caller proved tag). */
  emitUnbox(layout: IrUnionLowering, out: Instr[]): void;
  /** union ref on stack → i32 tag discriminator. */
  emitTagLoad(layout: IrUnionLowering, out: Instr[]): void;

  // ---- vec (array) — the §5 first-proof primitives --------------------
  /** vec ref on stack → i32 length. (caller appends f64.convert if needed) */
  emitVecLen(layout: IrVecLowering, out: Instr[]): void;
  /** vec ref on stack → data-region handle (WasmGC: data array ref; linear: base ptr i32). */
  emitVecDataPtr(layout: IrVecLowering, out: Instr[]): void;
  /** data-region handle + i32 index on stack → element value. */
  emitElemGet(layout: IrVecLowering, out: Instr[]): void;

  // ---- type tests / casts ---------------------------------------------
  /** ref on stack → same ref narrowed to the layout's runtime type. */
  emitDowncast(layout: IrClosureLowering | { promiseTypeIdx: number }, out: Instr[]): void;

  // ---- refs / null / scalar boxing across the ABI ---------------------
  /** push a typed null appropriate for `irType`. */
  emitNull(irType: IrType, out: Instr[]): void;
  /** ref on stack → externref (WasmGC: extern.convert_any). */
  emitToExternref(out: Instr[]): void;
  /** externref on stack → ref of layout's type (WasmGC: any.convert_extern + ref.cast). */
  emitFromExternref(layout: { typeIdx: number } | IrType, out: Instr[]): void;
  /** push a funcref to the resolved function index. */
  emitFuncRef(funcIdx: number, out: Instr[]): void;

  // ---- closures / refcells (aggregate-family, staged last) ------------
  emitClosureNew(layout: IrClosureLowering, captureCount: number, out: Instr[]): void;
  emitClosureFuncGet(layout: IrClosureLowering, out: Instr[]): void;
  emitCaptureGet(layout: IrClosureLowering, index: number, out: Instr[]): void;
  emitRefCellNew(layout: IrRefCellLowering, out: Instr[]): void;
  emitRefCellGet(layout: IrRefCellLowering, out: Instr[]): void;
  emitRefCellSet(layout: IrRefCellLowering, out: Instr[]): void;

  // ---- calls ----------------------------------------------------------
  emitCall(funcIdx: number, out: Instr[]): void;
  emitCallRef(funcTypeIdx: number, out: Instr[]): void;

  // ---- scalars / locals / globals / control flow (pass-through) -------
  emitConst(instr: Extract<import("../nodes.js").IrInstr, { kind: "const" }>, funcName: string, out: Instr[]): void;
  emitBinary(op: Instr["op"], out: Instr[]): void;
  emitUnary(op: Instr["op"], out: Instr[]): void;
  emitLocalGet(index: number, out: Instr[]): void;
  emitLocalSet(index: number, out: Instr[]): void;
  emitLocalTee(index: number, out: Instr[]): void;
  emitGlobalGet(index: number, out: Instr[]): void;
  emitGlobalSet(index: number, out: Instr[]): void;
  emitDrop(out: Instr[]): void;
  emitSelect(out: Instr[]): void;
  emitReturn(out: Instr[]): void;
  emitUnreachable(out: Instr[]): void;
  /** structured if. then/else already lowered into their own Instr[]. */
  emitIf(blockType: import("../types.js").BlockType, then: Instr[], els: Instr[], out: Instr[]): void;
  emitBrIf(depth: number, out: Instr[]): void;
  emitBr(depth: number, out: Instr[]): void;
}
```

**Notes on the boundary the trait must honour:**
- The emitter never owns the `IrLowerResolver` (layout) — `lower.ts` resolves
  the handle and passes it in. This keeps memoisation/registration in one place.
- `emitVecDataPtr` returning "a data-region handle" is deliberately abstract:
  WasmGC leaves a `(ref $arr)` on the stack; linear leaves an `i32` base
  pointer. Both feed `emitElemGet`, which closes the abstraction so `lower.ts`
  never reasons about what is on the stack between the two calls. This is the
  single most important abstraction decision — see §5 + §7.
- Async (`Promise`) and string ops stay where they are for Phase 1: strings are
  *already* behind `emit*` resolver methods (no work); Promise/await is its own
  group, flagged not-yet-moved (§7).

### 3. `WasmGcEmitter` — the behaviour-identical first implementation

New file `src/ir/backend/wasmgc-emitter.ts`, `class WasmGcEmitter implements
BackendEmitter`. Each method is the **literal `out.push` from the audited line**,
moved 1:1. Examples (must be byte-identical to current emission):

```ts
emitVecLen(layout: IrVecLowering, out: Instr[]): void {
  out.push({ op: "struct.get", typeIdx: layout.vecStructTypeIdx, fieldIdx: layout.lengthFieldIdx });
}
emitVecDataPtr(layout: IrVecLowering, out: Instr[]): void {
  out.push({ op: "struct.get", typeIdx: layout.vecStructTypeIdx, fieldIdx: layout.dataFieldIdx });
}
emitElemGet(layout: IrVecLowering, out: Instr[]): void {
  out.push({ op: "array.get", typeIdx: layout.arrayTypeIdx });
}
emitFieldGet(layout, name, out) {
  out.push({ op: "struct.get", typeIdx: layout.typeIdx, fieldIdx: layout.fieldIdx(name) });
}
emitConst(instr, funcName, out) { emitConst(instr, out, funcName); } // reuse existing free fn
emitBinary(op, out) { out.push({ op }); }
emitLocalGet(i, out) { out.push({ op: "local.get", index: i }); }
```

The free `emitConst` function (`lower.ts:2424`) stays where it is; `WasmGcEmitter`
delegates to it. `f64.convert_i32_s` tails (e.g. after `emitVecLen` at
`lower.ts:1206`) stay in `lower.ts` — they are IR-result-type coercions
(f64 Number semantics), **not** backend ops. Keep that line in the caller so the
emitter only owns the length load.

**Verification of identity:** after each migration step, the emitted `Instr[]`
for the moved kind must be array-equal to before. Because each method is a
mechanical move of the exact `out.push` object literal, this is guaranteed by
construction; the equivalence suite (§7) is the regression net.

### Migration order (each step independently testable, zero delta)

Stage in this order so the smallest, most-isolated group lands first and each
PR is a clean, reviewable, byte-identical move:

1. **Pass-through group** (locals/globals/const/binary/unary/drop/select/
   control flow). No layout handles; pure op moves. Wires the emitter into
   `lowerIrFunctionToWasm` (see §4) and proves the injection plumbing with zero
   semantic surface. *This is also exactly the #1715 subset — do it first.*
2. **Vec group** (`emitVecLen`/`emitVecDataPtr`/`emitElemGet`). Three methods,
   four call sites (`vec.len`, `vec.get`, two in `forof.vec`). *This is the
   #1714 proof surface — land it cleanly and #1714 can start immediately.*
3. **Object/class field group** (`emitFieldGet`/`emitFieldSet`/
   `emitAggregateNew`). Shared method for object + class (both are
   `{typeIdx, fieldIdx(name)}` handles).
4. **Union group** (`emitBox`/`emitUnbox`/`emitTagLoad`). Note `tag.test`
   keeps its trailing `i32.const tag; i32.eq` in `lower.ts` (that is IR logic,
   not a backend op) — only the `struct.get $tag` moves.
5. **Ref-coercion group** (`emitNull`/`emitToExternref`/`emitFromExternref`/
   `emitFuncRef`/`emitDowncast`).
6. **Closure/refcell group** (the remaining aggregate methods + `emitCallRef`).

Stop after the group(s) that fit the sprint; the acceptance criteria explicitly
permit a partial-but-clean seam (issue Scope §4). Recommended Phase-1 floor for
#1713 to unblock both followers: **stages 1–2** (pass-through + vec). Stages 3–6
can be follow-up PRs under the same issue or spun out.

### 4. Seam boundary & injection

- **Where lower.ts calls the emitter:** inside `emitInstrTree` and
  `emitBlockBody` switch arms, replacing each inline `out.push({op:"struct.*"…})`
  with `emitter.emitX(handle, …, out)`. The *resolver* calls
  (`resolver.resolveVec(...)` etc.) stay in `lower.ts` — layout resolution is
  not the emitter's job.
- **Where lower.ts stays backend-agnostic:** SSA local allocation, use-counting,
  cross-block materialisation, the `emitValue` operand-evaluation dispatch, and
  control-flow structuring (`emitBlockBody`'s if/br/return shaping) are all
  representation-neutral and **do not move**. The emitter only owns terminal op
  emission.
- **Injection:** add a parameter to `lowerIrFunctionToWasm(func, resolver,
  emitter: BackendEmitter)` (`lower.ts:335`). Default it for call-site
  compatibility: `emitter: BackendEmitter = new WasmGcEmitter(resolver)`. The
  emitter is constructed once per lowering call and closed over by
  `emitInstrTree`/`emitBlockBody` (they are already closures over `resolver`).
  Audit callers of `lowerIrFunctionToWasm` (`integration.ts` is the main one)
  — with a default arg they need **no change** in Phase 1, which keeps the
  refactor zero-delta. #1714/#1715 pass an explicit emitter selected by target.
- **Layout-handle types:** the `IrVecLowering`/`IrObjectStructLowering`/… types
  currently live in `lower.ts`. Move them (and only the type decls) to
  `src/ir/backend/handles.ts` and re-export from `lower.ts` so both the trait
  file and lower.ts import from one place without a cycle. (Optional but
  recommended — avoids `emitter.ts` importing from the 2.4k-line `lower.ts`.)

### 5. How #1714 plugs in (recommended first node kind: **vec**)

**Recommend the vec length+element-read path** (matches the issue's own
suggestion and the audit): it is IR-owned, structurally trivial (three
primitives, four sites), and has the cleanest linear analogue.

`LinearEmitter` (in new `src/ir/lower-linear.ts` or
`src/ir/backend/linear-emitter.ts`) implements **only** the three vec methods;
every other `BackendEmitter` method `throw new Error("LinearEmitter:
<method> not implemented (#1714 scope is vec only)")`. The linear vec layout
(from `src/codegen-linear/` conventions, which already use a header + bump
`__malloc`):
- vec value = an `i32` base pointer to a `{ i32 length @ off 0, i32 dataPtr @
  off 4 }` header (mirror the linear backend's existing array header — confirm
  exact offsets in `src/codegen-linear/runtime.ts`).
- `emitVecLen`: `i32.load offset=0`.
- `emitVecDataPtr`: `i32.load offset=4` → leaves the **data base ptr (i32)** on
  the stack (the abstraction: WasmGC leaves a ref, linear leaves an i32 — both
  are "the data-region handle").
- `emitElemGet`: data-base + index on stack → `i32.const stride; i32.mul;
  i32.add; <f64|i32>.load offset=0` (stride/elem-load from `IrVecLowering.
  elementValType`). `IrVecLowering` may need a backend-neutral element-stride/
  kind — add `elementValType` is already present; a `LinearVecLowering`
  sibling handle (base-offset layout) is what `resolveVec` returns under the
  linear target. **Decision for the dev:** keep `IrVecLowering` as the WasmGC
  handle; introduce a parallel linear layout handle the linear resolver returns,
  and have `LinearEmitter` accept it. The trait method signature stays
  `IrVecLowering`-typed only if we widen it to a union; cleaner is to make the
  handle types generic per-emitter — but that is a #1714 call, flagged here so
  the dev expects it.
- **Target selection:** the active emitter is chosen by compile target
  (`target: "wasi"`/linear → `LinearEmitter`; default → `WasmGcEmitter`) at the
  `lowerIrFunctionToWasm` call site in `integration.ts`.
- **Differential test:** `tests/ir-vec-two-backend.test.ts` — compile
  `function sum(a: number[]): number { let s = 0; for (const x of a) s += x;
  return s; }` (and an indexed `a[i]` variant) to both targets; assert identical
  numeric result for the same input array. This exercises `emitVecLen` +
  `emitVecDataPtr` + `emitElemGet` on both backends from the *same IR*.

### 6. How #1715 (stretch) plugs in — **opcode encoding choice**

**Choice: stack machine.** Reasoning:
- The proof's only job is to show the trait can target a *non-Wasm execution
  model*. A stack machine is the minimum code to prove that, and #1715 is
  explicitly throwaway-grade ("knowledge + a green triple-equivalence test").
- `lower.ts`'s emission is **already stack-oriented** — operands are pushed by
  `emitValue` then the op consumes them. A `BytecodeEmitter` that emits a
  stack-VM opcode per primitive is a near-mechanical mirror of `WasmGcEmitter`
  (`emitBinary(op)` → push `OP_ADD`; `emitConst` → push `OP_CONST, value`),
  so it maximally reuses the existing operand-ordering logic and minimises
  throwaway code — exactly the issue's stated tiebreaker ("a stack machine is
  acceptable for the proof if simpler").
- #1584 wants register+accumulator for the *eventual* VM. This proof should
  **document** that the stack encoding maps cleanly to the trait, and note the
  register+accumulator delta is purely an *encoding* concern downstream of the
  same seam (the seam does not care). That finding — "the trait abstracts
  execution model, and encoding is a free choice below it" — is precisely the
  de-risking input #1584's ADR needs, and a stack machine proves it for less
  code than register+accumulator. If the dev finds the stack VM trivially easy,
  they may upgrade to register+accumulator to pre-inform #1584; not required.

**Minimal opcode set** (for the #1715 subset: arithmetic, local get/set, const,
return, one conditional branch):

```
OP_CONST <f64 imm>     ; push imm
OP_LOAD  <localIdx>    ; push frame.locals[idx]
OP_STORE <localIdx>    ; pop → frame.locals[idx]
OP_ADD / OP_SUB / OP_MUL   ; pop b, pop a, push (a op b)
OP_CMP_GT (etc.)       ; pop b, pop a, push (a>b)?1:0   — the one branch needs a compare
OP_JZ    <target>      ; pop c; if c==0 goto target     ; maps from emitBrIf/emitIf
OP_JMP   <target>      ; goto target                    ; maps from emitBr
OP_RET                 ; halt, return top-of-stack
```

`BytecodeEmitter` emits into `number[]` (opcode + inline operands). `emitIf`
lowers to `OP_JZ elseLabel; <then ops>; OP_JMP endLabel; <else ops>` with a
backpatch pass for labels (the then/else `Instr[]` the trait passes are instead
collected as opcode sub-arrays — the BytecodeEmitter overrides `emitIf` to take
opcode arrays; cleanest is a parallel `BytecodeSink` type, since the trait's
`Instr[]` sink does not fit bytecode — **flag:** the `out: Instr[]` sink type is
WasmGC-biased; for #1715 generalise the sink to `EmitSink` (`Instr[]` for Wasm,
`number[]` for bytecode) — see §7 risk).

**Dispatch loop** (`src/ir/backend/bytecode-vm.ts`, plain TS so #1584 can later
compile it):

```ts
function run(code: number[], args: number[]): number {
  const locals = args.slice(); const stack: number[] = []; let pc = 0;
  for (;;) {
    switch (code[pc++]) {
      case OP_CONST: stack.push(code[pc++]); break;          // (imm boxed appropriately)
      case OP_LOAD:  stack.push(locals[code[pc++]]); break;
      case OP_STORE: locals[code[pc++]] = stack.pop()!; break;
      case OP_ADD:   { const b = stack.pop()!, a = stack.pop()!; stack.push(a + b); } break;
      // … sub/mul/cmp …
      case OP_JZ:    { const t = code[pc++]; if (stack.pop() === 0) pc = t; } break;
      case OP_JMP:   pc = code[pc++]; break;
      case OP_RET:   return stack.pop()!;
    }
  }
}
```

**Triple-equivalence test:** for `f(a,b)=a+b`, `g(a)={let x=a*2; return x}`,
`h(a,b)=a>0?a+b:a-b`, assert `run(bytecode) === wasmGcCompiledResult ===
plainJsResult`. (Const float immediates: store via a side constant-pool
`number[]` and index it, since `code` is `number[]` of ints — the dev decides
encoding detail; the proof only needs numbers in and out.)

### 7. Risks / invariants

**Must NOT change (zero conformance delta):**
- The emitted WasmGC `Instr` stream for every IR-owned kind must be
  **byte-identical** after the refactor. Each `WasmGcEmitter` method is a
  mechanical move of the exact object literal — review every method against its
  audited source line. No reordering of `out.push` relative to `emitValue`
  operand emission.
- `lowerIrFunctionToWasm`'s default `emitter` arg means existing callers are
  unchanged; the IR-fallback budget (`pnpm run check:ir-fallbacks`) must not
  grow (the refactor changes *how* IR emits, not *whether* a kind is IR-owned).

**Verify zero delta by:**
1. `npm test -- tests/equivalence.test.ts` (the IR path is exercised here).
2. `pnpm run check:ir-fallbacks` — no bucket grows.
3. CI test262 net delta = 0 (any non-zero is a bug, per acceptance criteria).
4. (Strong, recommended) a golden-`Instr` snapshot test on a couple of
   IR-lowered functions captured *before* the refactor, asserted *after* —
   proves byte-for-byte identity directly rather than only behaviourally.

**Places the current structure fights the abstraction (flag early — this is the
#1584 de-risking payload):**
- **The `out: Instr[]` sink is WasmGC-biased.** It works for linear (linear ops
  are in the same `Instr` union — see codegen-axes "types.ts stays shared").
  It does **not** fit bytecode (`number[]`). **Recommendation:** in Phase 1 keep
  `Instr[]` (don't over-generalise for a stretch goal); when #1715 starts,
  introduce a generic `EmitSink<T>` or a separate `BytecodeEmitter` sink. Note
  this in the trait file so #1715 knows the seam needs one generalisation to
  reach bytecode — *that finding is itself the #1715 deliverable*, so it is not
  a blocker, it is the answer.
- **`emitVecDataPtr` stack-handle polymorphism** (ref vs i32) is the load-bearing
  abstraction for #1714. If a future op needs to inspect the data handle's type
  mid-sequence, the abstraction leaks. For the vec read path it does not — the
  handle is produced and immediately consumed by `emitElemGet`. Keep that
  invariant: **no `lower.ts` code may assume what `emitVecDataPtr` left on the
  stack.**
- **Layout handles still expose `typeIdx`.** `IrVecLowering` etc. are WasmGC
  layout descriptors. For #1714 the linear resolver returns a *different* handle
  shape (offsets). The trait method signatures must therefore be either (a)
  widened to a handle union, or (b) made generic per-emitter. Phase 1 (#1713)
  keeps them WasmGC-typed (no second backend yet); **#1714 must pick (a) or (b)**
  — flagged so it is a known design step, not a surprise. Recommended: (b)
  generic, `BackendEmitter<H extends BackendHandles>`, so each emitter declares
  its own handle types and `lower.ts` is parameterised by the active backend.
- **Async/Promise + string groups are explicitly not moved in Phase 1.** Strings
  are already behind `emit*` resolver methods (no leak). Promise/await
  (`lower.ts:1799–1932`) stays inline and is flagged not-yet-moved — it is a
  WasmGC-only feature today with no linear analogue, so per codegen-axes it
  correctly stays backend-specific until a backend demands it (like `ref.eq` in
  the doc's counter-example).

### Files to create / touch
- **create** `src/ir/backend/emitter.ts` — the `BackendEmitter` interface.
- **create** `src/ir/backend/wasmgc-emitter.ts` — `WasmGcEmitter`.
- **create (optional)** `src/ir/backend/handles.ts` — move layout-handle type
  decls out of `lower.ts`, re-export from `lower.ts`.
- **edit** `src/ir/lower.ts` — add `emitter` param to `lowerIrFunctionToWasm`
  (`:335`, default `new WasmGcEmitter(resolver)`); replace inline `out.push`
  GC-op sites (audit table) with `emitter.emitX(...)` for the staged groups.
- **edit** `docs/architecture/codegen-axes.md` — update the "Current hidden bias
  in `src/ir/`" table (`:146–151`) to mark the moved leaks as now-behind-trait.
- **(#1714)** create `src/ir/lower-linear.ts` (`LinearEmitter`), differential
  test. **(#1715)** `src/ir/backend/bytecode-emitter.ts` + `bytecode-vm.ts`,
  triple-equivalence test.

---

## 2026-05-29 — Phase 1 implementation note (senior-dev, stages 1-2)

**Landed** (branch `issue-1713-backend-emitter`): the seam exists and the
pass-through + vec groups route through it. The remaining aggregate / union /
closure-refcell / ref-coercion groups stay inline (the issue Scope §4 + spec
migration order explicitly permit a partial-but-clean seam; the recommended
Phase-1 floor for unblocking #1714/#1715 was stages 1-2, which this delivers).

**Files**
- `src/ir/backend/handles.ts` — the layout-handle type decls, moved verbatim
  out of `lower.ts` (re-exported from `lower.ts` so existing
  `import { IrVecLowering } from "./lower.js"` sites are unchanged). This is
  the cycle-avoidance the spec §4 recommended (emitter.ts must not import the
  2.4k-line lower.ts).
- `src/ir/backend/emitter.ts` — the `BackendEmitter` interface. Stage-1/2
  methods are required; the not-yet-moved groups are declared **optional**
  (`?`) so a Phase-1 `WasmGcEmitter` need not implement them yet, while #1714
  has a stable signature to migrate against.
- `src/ir/backend/wasmgc-emitter.ts` — `WasmGcEmitter`. Every method is a 1:1
  mechanical move of the exact `out.push` object literal from the audited
  `lower.ts` line, so the emitted `Instr` stream is byte-identical.
- `src/ir/lower.ts` — `lowerIrFunctionToWasm` gains
  `emitter: BackendEmitter = new WasmGcEmitter()` (default-arg, so the sole
  caller `integration.ts` is unchanged → zero-delta). Routed: const,
  binary/unary final op, select, global.get/set, value-producing `if`, the
  `br_if`/`return`/`unreachable`/`drop` terminators, the function-tail
  `unreachable`, and the vec primitives in `vec.len`/`vec.get`/`forof.vec`
  (`emitVecLen`/`emitVecDataPtr`/`emitElemGet`). The `f64.convert_i32_s` after
  a length load is an **IR-result-type coercion, not a backend op**, so it
  stays in the caller (spec §3).

**WHY a partial seam, not all six groups in one PR**
- Byte-identity is the load-bearing invariant. Each routed site was moved as
  an exact literal and re-verified; doing all ~30 aggregate/closure sites in
  one pass multiplies the chance of a silent reordering relative to the
  `emitValue` operand emission. The spec stages 3-6 as independently-testable
  follow-ups for exactly this reason. The vec group is the #1714 proof
  surface and pass-through is the #1715 subset, so stages 1-2 unblock both
  followers — which is the whole point of this issue.
- The deeply-nested loop-body slot `local.get`/`local.set` inside
  `forof.vec` / `forof.iter` / `while.loop` / the `if`-arm `emitArmBody`
  cross-block materialisation are **slot/SSA scaffolding, not the per-node
  terminal vec/pass-through primitives** — they are left inline (flagged
  not-yet-moved) so the moved set is 100% behind the trait and the rest is
  explicit, per the acceptance criteria.

**Zero-delta evidence**
- Full IR test suite (`tests/ir`, `tests/ir-*equivalence*`, `tests/linear-ir`,
  …): **87 failed / 248 passed on BOTH this branch and a clean `origin/main`
  worktree** — identical, proving the refactor introduces no behavioural
  change. (The 87 failures are pre-existing on the sprint-57 base — e.g.
  `func.params is not iterable` in ir-scaffold, the inline-small/passes
  end-to-end LinkError — and are unrelated to this change.)
- New `tests/ir-backend-emitter.test.ts` — 9 golden-Instr unit tests asserting
  each routed primitive pushes the exact expected `Instr` (direct byte-identity
  proof, spec §7 recommendation).
- `tsc --noEmit` clean · `biome lint` clean · `check:ir-fallbacks` OK (no
  unintended bucket increase).

**Remaining (follow-up PRs under this issue, then `status: done`)**
- Stage 3 object/class field group (`emitFieldGet`/`emitFieldSet`/
  `emitAggregateNew`), stage 4 union (`emitBox`/`emitUnbox`/`emitTagLoad`),
  stage 5 ref-coercion, stage 6 closure/refcell. Async/Promise + string groups
  stay inline by design.
