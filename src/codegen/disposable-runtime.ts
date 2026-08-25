// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3231) Wasm-native `DisposableStack` runtime for standalone / WASI targets.
 *
 * In JS-host mode `new DisposableStack()` and every method route through the
 * `DisposableStack_*` host imports (registered in index.ts). Under `--target
 * standalone` / `--target wasi` there is no JS host to satisfy those imports, so
 * this module emits a pure-WasmGC DisposableStack: an externref-carried struct
 * holding a growable array of disposal entries.
 *
 * The instance flows as an **externref** (matching the extern-class default in
 * `resolveWasmType`, index.ts) wrapping a `$DisposableStack` struct via
 * `extern.convert_any`; each method site casts externref → struct
 * (`any.convert_extern` + `ref.cast`). This avoids the Map-style `ref $Map`
 * type-resolution special case.
 *
 * ## Disposal callback dispatch (the funcIdx-ordering crux)
 *
 * `defer`/`adopt` callbacks are stored as first-class WasmGC closures (the
 * standalone gate in `closures.ts` routes them to the closure-struct path, not
 * `__make_callback`). The dispose loop must invoke HETEROGENEOUS stored closures,
 * which only the `__call_fn_N` dispatchers (funcref-type dispatch, emitted LATE
 * at finalize) can do. So the dispose function is a **reserve/fill driver**
 * (mirrors `accessor-driver.ts`): reserved early with a placeholder body so
 * `.dispose()` sites can `call` its funcIdx, then filled at finalize once
 * `__call_fn_0`/`__call_fn_1` exist.
 *
 * Phase 1a scope: construct / `disposed` / `defer` / `adopt` / `dispose` (LIFO) /
 * `move` / disposed-throw / `[Symbol.dispose]`.
 *
 * Phase 1b adds `use(value)`: a RUNTIME `value[Symbol.dispose]` member lookup on
 * an arbitrary receiver (`__box_symbol(13)` + `__extern_get` over the native
 * `$Object` substrate), TypeError on a non-disposable arg, and a third disposer
 * kind (`ENTRY_KIND_USE`) invoked at dispose via `__call_fn_method_0(value,
 * method)` so the method's `this` binds to the used value. SuppressedError
 * multi-error aggregation remains a follow-up (see the issue file).
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType, StructTypeDef, ArrayTypeDef } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { addFuncType, getOrRegisterErrorStructType } from "./registry/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import type { InnerResult } from "./shared.js";
import { coerceType, compileExpression, ensureLateImport, flushLateImportShifts, VOID_RESULT } from "./shared.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { emitUndefined } from "./expressions/late-imports.js";
import { BUILTIN_TYPE_TAGS } from "./builtin-tags.js";
import { buildTargetTaggedTry } from "../ir/try-table.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

const INITIAL_CAPACITY = 4;

/** Disposal-entry kind discriminant (matches the dispose driver's switch). */
export const ENTRY_KIND_DEFER = 0; // cb()            via __call_fn_0
export const ENTRY_KIND_ADOPT = 1; // cb(value)       via __call_fn_1
export const ENTRY_KIND_USE = 2; // value[@@dispose]() via __call_fn_method_0 (Phase 1b)

interface DisposableTypes {
  stackTypeIdx: number;
  entryTypeIdx: number;
  entriesTypeIdx: number;
}

const TYPE_CACHE = new WeakMap<CodegenContext, DisposableTypes>();

/** Register (idempotent) the WasmGC struct/array types for the native runtime. */
export function ensureDisposableStackTypes(ctx: CodegenContext): DisposableTypes {
  const cached = TYPE_CACHE.get(ctx);
  if (cached) return cached;

  // $DisposeEntry: struct { cb: externref(mut); value: externref(mut); kind: i32(mut) }
  const entryTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "DisposeEntry",
    fields: [
      { name: "cb", type: EXTERNREF, mutable: true },
      { name: "value", type: EXTERNREF, mutable: true },
      { name: "kind", type: I32, mutable: true },
    ],
  } as StructTypeDef);

  // $DisposeEntries: (array (mut (ref null $DisposeEntry)))
  const entriesTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: "DisposeEntries",
    element: { kind: "ref_null", typeIdx: entryTypeIdx },
    mutable: true,
  } as ArrayTypeDef);

  // $DisposableStack: struct { disposed: i32(mut); entries: (ref null $DisposeEntries)(mut); count: i32(mut) }
  const stackTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "DisposableStack",
    fields: [
      { name: "disposed", type: I32, mutable: true },
      { name: "entries", type: { kind: "ref_null", typeIdx: entriesTypeIdx }, mutable: true },
      { name: "count", type: I32, mutable: true },
    ],
  } as StructTypeDef);
  ctx.structMap.set("DisposableStack", stackTypeIdx);
  ctx.typeIdxToStructName.set(stackTypeIdx, "DisposableStack");

  const types = { stackTypeIdx, entryTypeIdx, entriesTypeIdx };
  TYPE_CACHE.set(ctx, types);
  return types;
}

/** ValType helpers once types are registered. */
function stackRefNull(ctx: CodegenContext): ValType {
  return { kind: "ref_null", typeIdx: ensureDisposableStackTypes(ctx).stackTypeIdx };
}

/** Instrs: convert an externref (top of stack) → (ref null $DisposableStack). */
function externToStack(ctx: CodegenContext): Instr[] {
  const t = ensureDisposableStackTypes(ctx);
  return [{ op: "any.convert_extern" }, { op: "ref.cast_null", typeIdx: t.stackTypeIdx }];
}

// ── Helper functions (early-emitted; struct/array ops + error throw only) ─────

function ensureHelper(
  ctx: CodegenContext,
  name: string,
  params: ValType[],
  results: ValType[],
  locals: { name: string; type: ValType }[],
  buildBody: () => Instr[],
): number {
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  const typeIdx = addFuncType(ctx, params, results);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body: buildBody(), exported: false });
  return funcIdx;
}

/**
 * `__disposablestack_new() -> externref` — allocate an empty stack wrapped as
 * externref. entries starts as a fixed-capacity array of nulls; count = 0.
 */
export function ensureDisposableStackNew(ctx: CodegenContext): number {
  const t = ensureDisposableStackTypes(ctx);
  return ensureHelper(ctx, "__disposablestack_new", [], [EXTERNREF], [], () => [
    // disposed = 0
    { op: "i32.const", value: 0 },
    // entries = new $DisposeEntries[INITIAL_CAPACITY] (nulls)
    { op: "ref.null", typeIdx: t.entryTypeIdx },
    { op: "i32.const", value: INITIAL_CAPACITY },
    { op: "array.new", typeIdx: t.entriesTypeIdx },
    // count = 0
    { op: "i32.const", value: 0 },
    { op: "struct.new", typeIdx: t.stackTypeIdx },
    { op: "extern.convert_any" },
  ]);
}

/**
 * `__disposablestack_append(stack, cb, value, kind)` — RequireInternalSlot +
 * disposed-throw (ReferenceError), then push an entry (growing the backing array
 * on demand). Locals: 4=struct, 5=entries, 6=cap, 7=count, 8=newEntries.
 */
export function ensureDisposableStackAppend(ctx: CodegenContext): number {
  const t = ensureDisposableStackTypes(ctx);
  const entriesRefNull: ValType = { kind: "ref_null", typeIdx: t.entriesTypeIdx };
  return ensureHelper(
    ctx,
    "__disposablestack_append",
    [EXTERNREF, EXTERNREF, EXTERNREF, I32],
    [],
    [
      { name: "__ds", type: stackRefNull(ctx) },
      { name: "__entries", type: entriesRefNull },
      { name: "__cap", type: I32 },
      { name: "__count", type: I32 },
      { name: "__new", type: entriesRefNull },
      { name: "__i", type: I32 },
    ],
    () => {
      const STACK = 0,
        CB = 1,
        VALUE = 2,
        KIND = 3,
        DS = 4,
        ENTRIES = 5,
        CAP = 6,
        COUNT = 7,
        NEW = 8,
        I = 9;
      const body: Instr[] = [];
      // ds = cast(stack); RequireInternalSlot: null → ReferenceError
      body.push({ op: "local.get", index: STACK });
      body.push(...externToStack(ctx));
      body.push({ op: "local.tee", index: DS });
      body.push({ op: "ref.is_null" });
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: buildThrowJsErrorInstrs(ctx, "ReferenceError", "DisposableStack has no [[DisposableState]]"),
        else: [],
      });
      // if disposed: throw ReferenceError
      body.push({ op: "local.get", index: DS });
      body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 0 });
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: buildThrowJsErrorInstrs(ctx, "ReferenceError", "DisposableStack already disposed"),
        else: [],
      });
      // entries = ds.entries; count = ds.count; cap = len(entries)
      body.push({ op: "local.get", index: DS });
      body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 1 });
      body.push({ op: "local.tee", index: ENTRIES });
      body.push({ op: "array.len" });
      body.push({ op: "local.set", index: CAP });
      body.push({ op: "local.get", index: DS });
      body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 2 });
      body.push({ op: "local.set", index: COUNT });
      // if count >= cap: grow (new array of cap*2, copy)
      body.push({ op: "local.get", index: COUNT });
      body.push({ op: "local.get", index: CAP });
      body.push({ op: "i32.ge_s" });
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // new = new $DisposeEntries[cap*2]
          { op: "ref.null", typeIdx: t.entryTypeIdx },
          { op: "local.get", index: CAP },
          { op: "i32.const", value: 2 },
          { op: "i32.mul" },
          { op: "i32.const", value: INITIAL_CAPACITY },
          { op: "i32.add" }, // +INITIAL guards cap==0
          { op: "array.new", typeIdx: t.entriesTypeIdx },
          { op: "local.set", index: NEW },
          // copy: array.copy(new, 0, entries, 0, count)
          { op: "local.get", index: NEW },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: ENTRIES },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: COUNT },
          { op: "array.copy", dstTypeIdx: t.entriesTypeIdx, srcTypeIdx: t.entriesTypeIdx },
          // entries = new; ds.entries = new
          { op: "local.get", index: NEW },
          { op: "local.set", index: ENTRIES },
          { op: "local.get", index: DS },
          { op: "local.get", index: NEW },
          { op: "struct.set", typeIdx: t.stackTypeIdx, fieldIdx: 1 },
        ],
        else: [],
      });
      // entries[count] = new $DisposeEntry(cb, value, kind)
      body.push({ op: "local.get", index: ENTRIES });
      body.push({ op: "local.get", index: COUNT });
      body.push({ op: "local.get", index: CB });
      body.push({ op: "local.get", index: VALUE });
      body.push({ op: "local.get", index: KIND });
      body.push({ op: "struct.new", typeIdx: t.entryTypeIdx });
      body.push({ op: "array.set", typeIdx: t.entriesTypeIdx });
      // ds.count = count + 1
      body.push({ op: "local.get", index: DS });
      body.push({ op: "local.get", index: COUNT });
      body.push({ op: "i32.const", value: 1 });
      body.push({ op: "i32.add" });
      body.push({ op: "struct.set", typeIdx: t.stackTypeIdx, fieldIdx: 2 });
      void I;
      return body;
    },
  );
}

/**
 * `__disposablestack_move(stack) -> externref` — RequireInternalSlot +
 * disposed-throw, then create a new stack that takes over this stack's entries
 * and mark this stack disposed (§12.3.3.5).
 */
export function ensureDisposableStackMove(ctx: CodegenContext): number {
  const t = ensureDisposableStackTypes(ctx);
  return ensureHelper(
    ctx,
    "__disposablestack_move",
    [EXTERNREF],
    [EXTERNREF],
    [{ name: "__ds", type: stackRefNull(ctx) }],
    () => {
      const STACK = 0,
        DS = 1;
      const body: Instr[] = [];
      body.push({ op: "local.get", index: STACK });
      body.push(...externToStack(ctx));
      body.push({ op: "local.tee", index: DS });
      body.push({ op: "ref.is_null" });
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: buildThrowJsErrorInstrs(ctx, "ReferenceError", "DisposableStack has no [[DisposableState]]"),
        else: [],
      });
      body.push({ op: "local.get", index: DS });
      body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 0 });
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: buildThrowJsErrorInstrs(ctx, "ReferenceError", "DisposableStack already disposed"),
        else: [],
      });
      // new stack struct { disposed:0, entries: ds.entries, count: ds.count }
      body.push({ op: "i32.const", value: 0 });
      body.push({ op: "local.get", index: DS });
      body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 1 });
      body.push({ op: "local.get", index: DS });
      body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 2 });
      body.push({ op: "struct.new", typeIdx: t.stackTypeIdx });
      body.push({ op: "extern.convert_any" });
      // mark this disposed: ds.disposed = 1; ds.count = 0
      body.push({ op: "local.get", index: DS });
      body.push({ op: "i32.const", value: 1 });
      body.push({ op: "struct.set", typeIdx: t.stackTypeIdx, fieldIdx: 0 });
      body.push({ op: "local.get", index: DS });
      body.push({ op: "i32.const", value: 0 });
      body.push({ op: "struct.set", typeIdx: t.stackTypeIdx, fieldIdx: 2 });
      // The new-stack externref built above is still on the value stack (the two
      // struct.set ops consume only DS + their operand), so it is the return value.
      return body;
    },
  );
}

/**
 * `__disposablestack_check_active(stack)` — RequireInternalSlot (null →
 * ReferenceError) + disposed-throw (ReferenceError). No append/return. `use()`
 * needs this as a standalone check because the null/undefined-value fast path
 * (§ AddDisposableResource step 1.a) skips the append helper (which carries the
 * same check) yet the disposed check must STILL fire first (§
 * DisposableStack.prototype.use steps 2–3 run before AddDisposableResource).
 */
export function ensureDisposableStackCheckActive(ctx: CodegenContext): number {
  const t = ensureDisposableStackTypes(ctx);
  return ensureHelper(
    ctx,
    "__disposablestack_check_active",
    [EXTERNREF],
    [],
    [{ name: "__ds", type: stackRefNull(ctx) }],
    () => {
      const STACK = 0,
        DS = 1;
      const body: Instr[] = [];
      body.push({ op: "local.get", index: STACK });
      body.push(...externToStack(ctx));
      body.push({ op: "local.tee", index: DS });
      body.push({ op: "ref.is_null" });
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: buildThrowJsErrorInstrs(ctx, "ReferenceError", "DisposableStack has no [[DisposableState]]"),
        else: [],
      });
      body.push({ op: "local.get", index: DS });
      body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 0 });
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: buildThrowJsErrorInstrs(ctx, "ReferenceError", "DisposableStack already disposed"),
        else: [],
      });
      return body;
    },
  );
}

// ── dispose reserve/fill driver (needs __call_fn_N, emitted late) ────────────

const DISPOSE_DRIVER = "__disposablestack_dispose";

/**
 * Reserve `__disposablestack_dispose(stack)` with a placeholder body so
 * `.dispose()` sites can `call` its funcIdx. Body filled by
 * `fillDisposableStackDisposeDriver` at finalize.
 */
export function reserveDisposableStackDisposeDriver(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(DISPOSE_DRIVER);
  if (existing !== undefined) return existing;
  ensureDisposableStackTypes(ctx);
  // (#3234) SuppressedError multi-error aggregation: the dispose driver wraps a
  // second+ disposer throw into a native `$Error_struct` (SuppressedError tag)
  // whose `error`/`suppressed` fields live on the `$props` open-object backing.
  // Ensure the object runtime (`__new_plain_object`/`__extern_set`), the
  // `$Error_struct` type, and the interned key/name strings NOW (compile time) so
  // the finalize-time `fillDisposableStackDisposeDriver` can resolve them (adding
  // them at finalize is unsafe — object-runtime registration runs during compile).
  ensureObjectRuntime(ctx);
  getOrRegisterErrorStructType(ctx);
  for (const s of ["error", "suppressed", "SuppressedError", ""]) addStringConstantGlobal(ctx, s);
  const typeIdx = addFuncType(ctx, [EXTERNREF], []);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(DISPOSE_DRIVER, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: DISPOSE_DRIVER,
    typeIdx,
    locals: [],
    body: [{ op: "return" }],
    exported: false,
  });
  (ctx as unknown as { disposableStackDisposeReserved?: boolean }).disposableStackDisposeReserved = true;
  return funcIdx;
}

/**
 * Fill the reserved dispose driver at finalize, AFTER `__call_fn_0`/`__call_fn_1`
 * are registered. Runs each stored disposer LIFO. No-op when the driver was
 * never reserved.
 */
export function fillDisposableStackDisposeDriver(ctx: CodegenContext): void {
  if (!(ctx as unknown as { disposableStackDisposeReserved?: boolean }).disposableStackDisposeReserved) return;
  const driverIdx = ctx.funcMap.get(DISPOSE_DRIVER);
  if (driverIdx === undefined) return;
  const driverFn = definedFuncAt(ctx, driverIdx);
  if (!driverFn) return;
  const t = ensureDisposableStackTypes(ctx);
  // `__call_fn_N` exports are pushed straight onto mod.functions/mod.exports by
  // `emitClosureCallExportN` and are NOT registered in `funcMap` (unlike
  // `__call_fn_method_N`), so resolve their funcIdx via the export table.
  const callFnIdx = (name: string): number | undefined => {
    const exp = ctx.mod.exports.find((e) => e.name === name && e.desc?.kind === "func");
    return exp?.desc?.kind === "func" ? exp.desc.index : undefined;
  };
  const callFn0 = callFnIdx("__call_fn_0");
  const callFn1 = callFnIdx("__call_fn_1");
  // (#3231 Phase 1b) `use()` disposers invoke `value[@@dispose]()` — the stored
  // method with `value` bound as `this` — via the `__call_fn_method_0` bridge
  // (unlike `__call_fn_N`, it IS registered in `funcMap`; #1636-S1). Emitted by
  // `emitClosureMethodCallExportN(0)` BEFORE this fill runs (index.ts finalize
  // order: 2560 < 2621), so a `use()` module has it. Resolve by name.
  const callFnMethod0 = ctx.funcMap.get("__call_fn_method_0");

  // (#3234) SuppressedError aggregation dependencies (pre-registered at reserve).
  const exnTag = ensureExnTag(ctx);
  const errStructIdx = getOrRegisterErrorStructType(ctx);
  const newPlainObjIdx = ctx.funcMap.get("__new_plain_object");
  const externSetIdx = ctx.funcMap.get("__extern_set");
  const canAggregate = newPlainObjIdx !== undefined && externSetIdx !== undefined;

  const STACK = 0,
    DS = 0 + 1,
    ENTRIES = 2,
    I = 3,
    ENTRY = 4,
    KIND = 5,
    // (#3234) aggregation slots: PENDING = accumulated completion error, HASPENDING
    // its presence flag (`throw null`/`throw undefined` are still throws), CUR the
    // just-caught error, PROPS the SuppressedError `$props` scratch.
    PENDING = 6,
    HASPENDING = 7,
    CUR = 8,
    PROPS = 9;
  driverFn.locals = [
    { name: "__ds", type: stackRefNull(ctx) },
    { name: "__entries", type: { kind: "ref_null", typeIdx: t.entriesTypeIdx } },
    { name: "__i", type: I32 },
    { name: "__entry", type: { kind: "ref_null", typeIdx: t.entryTypeIdx } },
    { name: "__kind", type: I32 },
    { name: "__pending", type: EXTERNREF },
    { name: "__haspending", type: I32 },
    { name: "__cur", type: EXTERNREF },
    { name: "__props", type: EXTERNREF },
  ];

  const body: Instr[] = [];
  // ds = cast(stack); if null return
  body.push({ op: "local.get", index: STACK });
  body.push(...externToStack(ctx));
  body.push({ op: "local.tee", index: DS });
  body.push({ op: "ref.is_null" });
  body.push({ op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }], else: [] });
  // if already disposed: return
  body.push({ op: "local.get", index: DS });
  body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 0 });
  body.push({ op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }], else: [] });
  // ds.disposed = 1
  body.push({ op: "local.get", index: DS });
  body.push({ op: "i32.const", value: 1 });
  body.push({ op: "struct.set", typeIdx: t.stackTypeIdx, fieldIdx: 0 });
  // entries = ds.entries; i = ds.count - 1
  body.push({ op: "local.get", index: DS });
  body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 1 });
  body.push({ op: "local.set", index: ENTRIES });
  body.push({ op: "local.get", index: DS });
  body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 2 });
  body.push({ op: "i32.const", value: 1 });
  body.push({ op: "i32.sub" });
  body.push({ op: "local.set", index: I });

  // LIFO loop
  const loopBody: Instr[] = [];
  // if i < 0 break
  loopBody.push({ op: "local.get", index: I });
  loopBody.push({ op: "i32.const", value: 0 });
  loopBody.push({ op: "i32.lt_s" });
  loopBody.push({ op: "br_if", depth: 1 }); // break out of block (depth 1 = enclosing block)
  // entry = entries[i]
  loopBody.push({ op: "local.get", index: ENTRIES });
  loopBody.push({ op: "local.get", index: I });
  loopBody.push({ op: "array.get", typeIdx: t.entriesTypeIdx });
  loopBody.push({ op: "local.tee", index: ENTRY });
  // if entry != null: dispatch
  loopBody.push({ op: "ref.is_null" });
  loopBody.push({ op: "i32.eqz" });
  const dispatch: Instr[] = [];
  dispatch.push({ op: "local.get", index: ENTRY });
  dispatch.push({ op: "struct.get", typeIdx: t.entryTypeIdx, fieldIdx: 2 });
  dispatch.push({ op: "local.set", index: KIND });
  // Instr helpers for the entry's callback (fieldIdx 0) and captured value (1).
  const entryCb = (): Instr[] => [
    { op: "local.get", index: ENTRY },
    { op: "struct.get", typeIdx: t.entryTypeIdx, fieldIdx: 0 },
  ];
  const entryValue = (): Instr[] => [
    { op: "local.get", index: ENTRY },
    { op: "struct.get", typeIdx: t.entryTypeIdx, fieldIdx: 1 },
  ];
  // Per-kind invocation, each a no-op when its dispatcher is unavailable:
  //   USE   (2): `value[@@dispose]()` → __call_fn_method_0(value, method)
  //   ADOPT (1): onDispose(value)     → __call_fn_1(cb, value)
  //   DEFER (0): onDispose()          → __call_fn_0(cb)
  const useCall: Instr[] =
    callFnMethod0 !== undefined
      ? [...entryValue(), ...entryCb(), { op: "call", funcIdx: callFnMethod0 }, { op: "drop" }]
      : [];
  const adoptCall: Instr[] =
    callFn1 !== undefined ? [...entryCb(), ...entryValue(), { op: "call", funcIdx: callFn1 }, { op: "drop" }] : [];
  const deferCall: Instr[] =
    callFn0 !== undefined ? [...entryCb(), { op: "call", funcIdx: callFn0 }, { op: "drop" }] : [];
  // if kind == USE → useCall; else if kind == ADOPT → adoptCall; else deferCall.
  const invokeSwitch: Instr[] = [
    { op: "local.get", index: KIND },
    { op: "i32.const", value: ENTRY_KIND_USE },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: useCall,
      else: [
        { op: "local.get", index: KIND },
        { op: "i32.const", value: ENTRY_KIND_ADOPT },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: adoptCall, else: deferCall },
      ],
    },
  ];
  // (#3234) Run EVERY disposer even if a prior threw (§ DisposeResources). Wrap the
  // invocation in try/catch on the module exception tag ($exn carries the thrown
  // externref); Wasm traps are not catchable and there is no JS host to raise a
  // foreign exception standalone, so a single-tag catch is complete (no catch_all).
  // On the FIRST caught error: pending = err. On each SUBSEQUENT: pending =
  // SuppressedError{ error: newer, suppressed: prior } (LIFO nesting).
  const buildSuppressedError: Instr[] = canAggregate
    ? [
        // props = __new_plain_object(); props.error = cur; props.suppressed = pending
        { op: "call", funcIdx: newPlainObjIdx! },
        { op: "local.set", index: PROPS },
        { op: "local.get", index: PROPS },
        ...stringConstantExternrefInstrs(ctx, "error"),
        { op: "local.get", index: CUR },
        { op: "call", funcIdx: externSetIdx! },
        { op: "local.get", index: PROPS },
        ...stringConstantExternrefInstrs(ctx, "suppressed"),
        { op: "local.get", index: PENDING },
        { op: "call", funcIdx: externSetIdx! },
        // pending = struct.new $Error_struct{ tag, message "", name, stack null, userClassId -1, props }
        { op: "i32.const", value: BUILTIN_TYPE_TAGS.SuppressedError },
        ...stringConstantExternrefInstrs(ctx, ""),
        ...stringConstantExternrefInstrs(ctx, "SuppressedError"),
        { op: "ref.null.extern" },
        { op: "i32.const", value: -1 },
        { op: "local.get", index: PROPS },
        { op: "struct.new", typeIdx: errStructIdx },
        { op: "extern.convert_any" },
        { op: "local.set", index: PENDING },
      ]
    : // Object runtime unavailable (should not happen — reserved at compile time):
      // degrade to last-error-wins so the module stays valid Wasm.
      [
        { op: "local.get", index: CUR },
        { op: "local.set", index: PENDING },
      ];
  const catchHandler: Instr[] = [
    { op: "local.set", index: CUR },
    { op: "local.get", index: HASPENDING },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildSuppressedError,
      else: [
        { op: "local.get", index: CUR },
        { op: "local.set", index: PENDING },
        { op: "i32.const", value: 1 },
        { op: "local.set", index: HASPENDING },
      ],
    },
  ];
  dispatch.push(buildTargetTaggedTry(ctx, { kind: "empty" }, invokeSwitch, [{ tagIdx: exnTag, body: catchHandler }]));
  loopBody.push({ op: "if", blockType: { kind: "empty" }, then: dispatch, else: [] });
  // i = i - 1; continue
  loopBody.push({ op: "local.get", index: I });
  loopBody.push({ op: "i32.const", value: 1 });
  loopBody.push({ op: "i32.sub" });
  loopBody.push({ op: "local.set", index: I });
  loopBody.push({ op: "br", depth: 0 }); // continue loop

  // block { loop { ... } }
  body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  // (#3234) After all disposers ran: if any error was accumulated, rethrow the
  // final completion (the outermost SuppressedError, or the single error as-is).
  body.push({ op: "local.get", index: HASPENDING });
  body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: PENDING },
      { op: "throw", tagIdx: exnTag },
    ],
    else: [],
  });

  driverFn.body = body;
}

// ── Front-end intercepts ─────────────────────────────────────────────────────

/** Compile an argument expression and coerce the result to externref. */
function compileArgAsExternref(ctx: CodegenContext, fctx: FunctionContext, arg: ts.Expression): void {
  const t = compileExpression(ctx, fctx, arg);
  if (t !== null && !(t.kind === "externref")) coerceType(ctx, fctx, t, EXTERNREF);
}

/**
 * (#3237 Slice 1) Intercept a native `DisposableStack` method call whose STATIC
 * receiver is `any`/externref (the test262 runner hoists a nested-closure-captured
 * `var stack = new DisposableStack()` to `let stack: any`, so `stack.dispose()`
 * loses the nominal `DisposableStack` symbol). Without this, the any-receiver
 * first-match extern loop (`tryExternClassMethodOnAny`, calls-closures.ts) binds
 * `dispose` to the `DisposableStack_dispose` HOST import — unsatisfiable
 * standalone, so the whole module fails to instantiate BEFORE dispose ever runs.
 *
 * Dispatch on the RUNTIME shape instead: `ref.test $DisposableStack` on the
 * receiver. Match → the native dispose driver (same reserve/fill func the typed
 * path uses). Miss (incl. null/undefined) → a clean TypeError (RequireInternalSlot
 * fail, §12.3.3.2 step 2) — NEVER the host import.
 *
 * Caller (`tryExternClassMethodOnAny`) gates this to fire only where the
 * first-match loop WOULD have bound the host import: `ctx.nativeStrings`, no
 * user-defined member of the same name shadows it (the #3033 refusal already ran),
 * and `DisposableStack` is a registered extern class declaring the method. A
 * user object-literal `{ dispose() {} }` on an `any` receiver keeps taking the
 * closed-struct dispatch path (#2151) — it never reaches here.
 *
 * Slice 1 handles `dispose` only. The callback methods (`defer`/`adopt`/`use`)
 * additionally need the standalone closure gate to fire on the any-receiver path
 * (Slice 2); they fall through (`undefined`) here.
 */
export function tryCompileNativeDisposableStackAnyMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  methodName: string,
): InnerResult | undefined {
  if (!ctx.nativeStrings) return undefined;
  // Slice 2: the callback methods `defer`/`adopt`/`use` route through the native
  // append/use substrate guarded by the same `ref.test $DisposableStack` shape
  // dispatch. Slice 1 handles `dispose` below.
  if (methodName === "defer" || methodName === "adopt" || methodName === "use") {
    return compileNativeDisposableStackAnyCallbackMethod(ctx, fctx, propAccess, callExpr, methodName);
  }
  if (methodName !== "dispose") return undefined;
  if (callExpr.arguments.length !== 0) return undefined;

  const t = ensureDisposableStackTypes(ctx);
  const driver = reserveDisposableStackDisposeDriver(ctx);

  // Evaluate the receiver ONCE into an externref local — it is consumed twice
  // (the `ref.test` brand check and, on a hit, the driver call).
  const recvLocal = allocLocal(fctx, `__ds_anyrecv_${fctx.locals.length}`, EXTERNREF);
  const rt = compileExpression(ctx, fctx, propAccess.expression);
  if (rt !== null && rt.kind !== "externref") coerceType(ctx, fctx, rt, EXTERNREF);
  fctx.body.push({ op: "local.set", index: recvLocal });

  // if ref.test $DisposableStack(recv): native dispose ; else TypeError.
  // `ref.test (ref $DisposableStack)` is 0 for null and for a non-matching ref,
  // so a null/undefined or wrong-type receiver lands in the TypeError arm —
  // matching RequireInternalSlot without ever emitting the host import.
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.test", typeIdx: t.stackTypeIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: recvLocal },
      { op: "call", funcIdx: driver },
    ],
    else: buildThrowJsErrorInstrs(
      ctx,
      "TypeError",
      "DisposableStack.prototype.dispose requires a DisposableStack receiver",
      { flush: fctx },
    ),
  });

  // `dispose()` returns undefined. In a VALUE position (`assert.sameValue(
  // s.dispose(), undefined)` — returns-undefined.js) hand back the canonical
  // undefined value via `emitUndefined` so the caller's stack stays balanced AND
  // a subsequent `=== undefined` compares equal. A raw `ref.null.extern` is NOT
  // the undefined singleton under the #2106 regime (`x === undefined` checks the
  // singleton, not null), so `let u = s.dispose(); u === undefined` was false —
  // `emitUndefined` emits the singleton (standalone) / `__get_undefined` (host).
  // Statement position keeps the zero-cost VOID_RESULT.
  if (!ts.isExpressionStatement(callExpr.parent)) {
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }
  return VOID_RESULT;
}

/**
 * (#3237 Slice 2) The callback DisposableStack methods — `defer(cb)` /
 * `adopt(value, cb)` / `use(value)` — on an `any`/externref receiver. Same leak
 * as Slice 1's `dispose`: reaching `tryExternClassMethodOnAny`'s first-match
 * extern loop, an `any`-typed `stack.defer(fn)` / `stack.adopt(v, fn)` /
 * `stack.use(v)` would otherwise bind the `DisposableStack_defer` / `_adopt` /
 * `_use` HOST import — unsatisfiable standalone, so the module fails to
 * instantiate BEFORE dispose ever runs (this is the residual leak of the
 * dispose/defer test262 cluster the #3234 SuppressedError aggregation was a
 * prerequisite for).
 *
 * Dispatch on the RUNTIME shape instead: `ref.test $DisposableStack` on the
 * receiver. Match → the SAME native append (`defer`/`adopt`) / use substrate the
 * typed path uses. Miss (incl. null/undefined) → a clean TypeError
 * (RequireInternalSlot, §12.3.3.{2,4} step 1) — NEVER the host import, and never a
 * `ref.cast_null` trap (the append/use helpers cast externref→struct and would
 * trap on a non-stack non-null ref, so the brand test must gate them).
 *
 * The receiver and args are evaluated ONCE into externref locals BEFORE the guard
 * — preserving JS call-site evaluation order (arguments are evaluated before the
 * method body runs, so a non-stack receiver still evaluates its args). The
 * `defer`/`adopt` callbacks compile as native first-class WasmGC closures via the
 * standalone closure gate (#3235), so no `__make_callback` host bridge leaks.
 *
 * funcIdx-ordering (the crux, cf. the late-import shifter in index.ts): every
 * late import is registered FIRST (append/use helpers → `__new_ReferenceError`;
 * the object substrate → `__box_symbol`/`__extern_is_undefined`/`__extern_get`;
 * the guard TypeError → `__new_ReferenceError`/`__new_TypeError`), the guard
 * TypeError's `buildThrowJsErrorInstrs` performs the final `flushLateImportShifts`
 * against `fctx.body` (fixing the already-emitted receiver/arg eval), and only
 * THEN are the native helper funcIdxs re-fetched from `ctx.funcMap` (post-shift,
 * final) and baked into the nested `if` arms. No late import is registered after
 * that re-fetch, so the baked indices stay valid.
 */
function compileNativeDisposableStackAnyCallbackMethod(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  methodName: string,
): InnerResult {
  const t = ensureDisposableStackTypes(ctx);
  const args = callExpr.arguments;

  // Evaluate the receiver ONCE into an externref local (consumed by the brand
  // test AND, on a hit, the native op).
  const recvLocal = allocLocal(fctx, `__ds_anyrecv_${fctx.locals.length}`, EXTERNREF);
  const rt = compileExpression(ctx, fctx, propAccess.expression);
  if (rt !== null && rt.kind !== "externref") coerceType(ctx, fctx, rt, EXTERNREF);
  fctx.body.push({ op: "local.set", index: recvLocal });

  // `ref.test (ref $DisposableStack)` is 0 for null and for a non-matching ref, so
  // a null/undefined/wrong-type receiver lands in the TypeError arm — matching
  // RequireInternalSlot without ever emitting the host import.
  const brandTest = (): Instr[] => [
    { op: "local.get", index: recvLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: t.stackTypeIdx },
  ];
  const guardMsg = `DisposableStack.prototype.${methodName} requires a DisposableStack receiver`;

  if (methodName === "defer") {
    ensureDisposableStackAppend(ctx); // register the helper + its late imports
    // Eval callback → cbLocal (after receiver — call-site order).
    const cbLocal = allocLocal(fctx, `__ds_cb_${fctx.locals.length}`, EXTERNREF);
    if (args[0]) compileArgAsExternref(ctx, fctx, args[0]);
    else fctx.body.push({ op: "ref.null.extern" });
    fctx.body.push({ op: "local.set", index: cbLocal });
    // Guard TypeError registers the last late import + flushes fctx; fetch the
    // append funcIdx AFTER so the bake is post-shift.
    const elseThrow = buildThrowJsErrorInstrs(ctx, "TypeError", guardMsg, { flush: fctx });
    const appendIdx = ctx.funcMap.get("__disposablestack_append")!;
    fctx.body.push(...brandTest());
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: recvLocal },
        { op: "local.get", index: cbLocal },
        { op: "ref.null.extern" }, // value = null
        { op: "i32.const", value: ENTRY_KIND_DEFER },
        { op: "call", funcIdx: appendIdx },
      ],
      else: elseThrow,
    });
    // `defer()` returns undefined (VOID in statement position; the canonical
    // undefined value via `emitUndefined` in value position — so `=== undefined`
    // compares equal, matching Slice 1 `dispose`). The guarded `if` is already in
    // `fctx.body`, so any late-import shift `emitUndefined` triggers correctly
    // updates the `appendIdx` baked in its `then` arm.
    if (!ts.isExpressionStatement(callExpr.parent)) {
      emitUndefined(ctx, fctx);
      return { kind: "externref" };
    }
    return VOID_RESULT;
  }

  if (methodName === "adopt") {
    ensureDisposableStackAppend(ctx);
    // adopt(value, onDispose) — eval value then onDispose; return value.
    const valueLocal = allocLocal(fctx, `__ds_val_${fctx.locals.length}`, EXTERNREF);
    if (args[0]) compileArgAsExternref(ctx, fctx, args[0]);
    else fctx.body.push({ op: "ref.null.extern" });
    fctx.body.push({ op: "local.set", index: valueLocal });
    const cbLocal = allocLocal(fctx, `__ds_cb_${fctx.locals.length}`, EXTERNREF);
    if (args[1]) compileArgAsExternref(ctx, fctx, args[1]);
    else fctx.body.push({ op: "ref.null.extern" });
    fctx.body.push({ op: "local.set", index: cbLocal });
    const elseThrow = buildThrowJsErrorInstrs(ctx, "TypeError", guardMsg, { flush: fctx });
    const appendIdx = ctx.funcMap.get("__disposablestack_append")!;
    fctx.body.push(...brandTest());
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: recvLocal },
        { op: "local.get", index: cbLocal },
        { op: "local.get", index: valueLocal },
        { op: "i32.const", value: ENTRY_KIND_ADOPT },
        { op: "call", funcIdx: appendIdx },
      ],
      else: elseThrow,
    });
    // adopt returns the value (§12.3.3.4 step 5). The throw arm is unreachable, so
    // the post-`if` `value` is the sole result on both statement/value positions.
    fctx.body.push({ op: "local.get", index: valueLocal });
    return { kind: "externref" };
  }

  // methodName === "use": value[Symbol.dispose] member-lookup disposer (§12.3.3.3).
  return compileNativeDisposableStackAnyUse(ctx, fctx, propAccess, callExpr, recvLocal, brandTest, guardMsg);
}

/**
 * (#3237 Slice 2) `DisposableStack.prototype.use(value)` on an `any` receiver —
 * the typed-path use logic (`compileNativeDisposableStackUse`) wrapped in the
 * `ref.test $DisposableStack` brand guard. Steps (§12.3.3.3): RequireInternalSlot
 * (the brand test — a non-stack `this` throws TypeError, matching step 1's
 * distinction from the disposed ReferenceError), then disposed-throw + the
 * GetDisposeMethod(value, @@dispose) read + conditional append, all inside the
 * hit arm. The value arg is evaluated up front (call-site order) into a local so
 * the miss/TypeError arm still evaluates it. Returns the value.
 */
function compileNativeDisposableStackAnyUse(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  recvLocal: number,
  brandTest: () => Instr[],
  guardMsg: string,
): InnerResult {
  void propAccess;
  const args = callExpr.arguments;
  const valueLocal = allocLocal(fctx, `__ds_val_${fctx.locals.length}`, EXTERNREF);
  const methodLocal = allocLocal(fctx, `__ds_method_${fctx.locals.length}`, EXTERNREF);

  // Eval value → valueLocal (after receiver — call-site order).
  if (args[0]) compileArgAsExternref(ctx, fctx, args[0]);
  else fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "local.set", index: valueLocal });

  // Register every late import BEFORE the final flush: the append/check helpers
  // (→ `__new_ReferenceError`), the object substrate (`__extern_get`), and
  // `__box_symbol`/`__extern_is_undefined`.
  ensureDisposableStackAppend(ctx);
  ensureDisposableStackCheckActive(ctx);
  ensureObjectRuntime(ctx);
  ensureLateImport(ctx, "__box_symbol", [I32], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [I32]);
  // The guard TypeError registers the final late import (`__new_TypeError`) and
  // performs the flush against fctx.body; fetch every helper funcIdx AFTER.
  const elseThrow = buildThrowJsErrorInstrs(ctx, "TypeError", guardMsg, { flush: fctx });
  const appendIdx = ctx.funcMap.get("__disposablestack_append")!;
  const checkIdx = ctx.funcMap.get("__disposablestack_check_active")!;
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const boxSymIdx = ctx.funcMap.get("__box_symbol");
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  if (externGetIdx === undefined || boxSymIdx === undefined || isUndefinedIdx === undefined) {
    // Substrate unavailable (should not happen once ensureObjectRuntime ran) —
    // keep the body balanced: value was evaluated for side effects; return it.
    fctx.body.push({ op: "local.get", index: valueLocal });
    return { kind: "externref" };
  }

  // Regime-independent "is null OR undefined" for a value held in `localIdx`
  // (mirrors the typed use path — cover both the boxed-undefined and the
  // undefined-singleton regimes).
  const nullishOf = (localIdx: number): Instr[] => [
    { op: "local.get", index: localIdx },
    { op: "ref.is_null" },
    { op: "local.get", index: localIdx },
    { op: "call", funcIdx: isUndefinedIdx },
    { op: "i32.or" },
  ];

  // Hit arm: disposed-throw check, then GetDisposeMethod + conditional append.
  const hit: Instr[] = [];
  hit.push({ op: "local.get", index: recvLocal });
  hit.push({ op: "call", funcIdx: checkIdx });

  // if !nullish(value): method = __extern_get(value, __box_symbol(13)); validate; append.
  const nonNullishBody: Instr[] = [];
  nonNullishBody.push({ op: "local.get", index: valueLocal });
  nonNullishBody.push({ op: "i32.const", value: SYMBOL_DISPOSE_ID });
  nonNullishBody.push({ op: "call", funcIdx: boxSymIdx });
  nonNullishBody.push({ op: "call", funcIdx: externGetIdx });
  nonNullishBody.push({ op: "local.set", index: methodLocal });
  nonNullishBody.push(...nullishOf(methodLocal));
  nonNullishBody.push({
    op: "if",
    blockType: { kind: "empty" },
    then: buildThrowJsErrorInstrs(ctx, "TypeError", "DisposableStack.prototype.use: value is not disposable", {
      flush: fctx,
    }),
    else: [],
  });
  nonNullishBody.push({ op: "local.get", index: recvLocal });
  nonNullishBody.push({ op: "local.get", index: methodLocal });
  nonNullishBody.push({ op: "local.get", index: valueLocal });
  nonNullishBody.push({ op: "i32.const", value: ENTRY_KIND_USE });
  nonNullishBody.push({ op: "call", funcIdx: appendIdx });

  hit.push(...nullishOf(valueLocal));
  hit.push({ op: "i32.eqz" });
  hit.push({ op: "if", blockType: { kind: "empty" }, then: nonNullishBody, else: [] });

  fctx.body.push(...brandTest());
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: hit, else: elseThrow });

  // Return value.
  fctx.body.push({ op: "local.get", index: valueLocal });
  return { kind: "externref" };
}

/**
 * (#3237 Slice 1) Read `.disposed` on a DYNAMIC (`any`/`unknown`/union) receiver
 * that may carry a native `$DisposableStack`. The compile-time className arm
 * (`tryCompileNativeDisposableStackDisposedGet`, gated on the nominal symbol)
 * cannot fire when the runner hoists `var stack = new DisposableStack()` to
 * `let stack: any`, so `stack.disposed` fell to the generic dynamic reader — a
 * `__extern_get` MISS on the non-`$Object` native struct → always
 * `undefined`/false, i.e. silently wrong AFTER `dispose()` (breaks
 * `sets-state-to-disposed.js`).
 *
 * Runtime `ref.test $DisposableStack` dispatch instead: a match reads the struct
 * `disposed` flag (boxed as a boolean externref, matching the `any`-context value
 * contract); a miss falls to the same generic `__extern_get` read the receiver
 * would otherwise have taken — so a user object's own `.disposed` property (an
 * `$Object` field) is preserved. Gated `nativeStrings`; caller additionally
 * requires a dynamic receiver + a registered `DisposableStack` extern class.
 */
export function tryCompileNativeDisposableStackAnyDisposedGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
): InnerResult | undefined {
  if (!ctx.nativeStrings) return undefined;
  const t = ensureDisposableStackTypes(ctx);
  // `__extern_get` + the boxing helpers live in the native object runtime.
  ensureObjectRuntime(ctx);

  // Evaluate the receiver ONCE into an externref local (consumed by the brand
  // test AND, on a miss, the generic fallback read).
  const recvLocal = allocLocal(fctx, `__ds_dget_${fctx.locals.length}`, EXTERNREF);
  const rt = compileExpression(ctx, fctx, receiver);
  if (rt !== null && rt.kind !== "externref") coerceType(ctx, fctx, rt, EXTERNREF);
  fctx.body.push({ op: "local.set", index: recvLocal });

  // Register the boxing + dynamic-read helpers AFTER the receiver's own imports
  // settle, then flush late-import index shifts against this body before baking
  // the funcIdxs (mirrors the `use()` path).
  const boxBoolIdx = ensureLateImport(ctx, "__box_boolean", [I32], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  flushLateImportShifts(ctx, fctx);
  const externGetIdx = ctx.funcMap.get("__extern_get");
  if (boxBoolIdx === undefined || externGetIdx === undefined) {
    // Substrate unavailable — hand back `undefined` (null externref) rather than
    // an unbalanced body. (Should not happen once ensureObjectRuntime ran.)
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
  addStringConstantGlobal(ctx, "disposed");

  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.test", typeIdx: t.stackTypeIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: EXTERNREF },
    then: [
      // Native DisposableStack → box the i32 disposed flag as a boolean externref.
      { op: "local.get", index: recvLocal },
      ...externToStack(ctx),
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 0 },
      { op: "call", funcIdx: boxBoolIdx },
    ],
    else: [
      // Not a DisposableStack → the generic dynamic property read (`$Object`
      // sidecar), so a user object's own `.disposed` property still resolves.
      { op: "local.get", index: recvLocal },
      ...stringConstantExternrefInstrs(ctx, "disposed"),
      { op: "call", funcIdx: externGetIdx },
    ],
  });
  return { kind: "externref" };
}

/**
 * (#3231) Intercept a `DisposableStack.prototype.*` method call in standalone /
 * `nativeStrings` mode. Handles `dispose` / `defer` / `adopt` / `move`. Returns
 * the result ValType/sentinel when handled, else `undefined` (host fallthrough —
 * e.g. `use`, Phase 1b). The receiver and args are compiled here.
 */
export function tryCompileNativeDisposableStackMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): InnerResult | undefined {
  if (!ctx.nativeStrings) return undefined;
  const methodName = propAccess.name.text;
  const args = callExpr.arguments;
  ensureDisposableStackTypes(ctx);

  if (methodName === "dispose") {
    const driver = reserveDisposableStackDisposeDriver(ctx);
    compileExpression(ctx, fctx, propAccess.expression); // stack externref
    fctx.body.push({ op: "call", funcIdx: driver });
    return VOID_RESULT;
  }

  if (methodName === "move") {
    const moveIdx = ensureDisposableStackMove(ctx);
    compileExpression(ctx, fctx, propAccess.expression); // stack externref
    fctx.body.push({ op: "call", funcIdx: moveIdx });
    return EXTERNREF;
  }

  if (methodName === "defer") {
    const appendIdx = ensureDisposableStackAppend(ctx);
    // Eval order: receiver, then onDispose(arg0). Buffer via locals so the
    // append arg order (stack, cb, value, kind) is independent of eval order.
    const stackLocal = allocLocal(fctx, `__ds_stack_${fctx.locals.length}`, EXTERNREF);
    compileExpression(ctx, fctx, propAccess.expression);
    fctx.body.push({ op: "local.set", index: stackLocal });
    const cbLocal = allocLocal(fctx, `__ds_cb_${fctx.locals.length}`, EXTERNREF);
    if (args[0]) compileArgAsExternref(ctx, fctx, args[0]);
    else fctx.body.push({ op: "ref.null.extern" });
    fctx.body.push({ op: "local.set", index: cbLocal });
    fctx.body.push({ op: "local.get", index: stackLocal });
    fctx.body.push({ op: "local.get", index: cbLocal });
    fctx.body.push({ op: "ref.null.extern" }); // value = null
    fctx.body.push({ op: "i32.const", value: ENTRY_KIND_DEFER });
    fctx.body.push({ op: "call", funcIdx: appendIdx });
    return VOID_RESULT;
  }

  if (methodName === "adopt") {
    const appendIdx = ensureDisposableStackAppend(ctx);
    // adopt(value, onDispose) — eval value then onDispose; return value.
    const stackLocal = allocLocal(fctx, `__ds_stack_${fctx.locals.length}`, EXTERNREF);
    compileExpression(ctx, fctx, propAccess.expression);
    fctx.body.push({ op: "local.set", index: stackLocal });
    const valueLocal = allocLocal(fctx, `__ds_val_${fctx.locals.length}`, EXTERNREF);
    if (args[0]) compileArgAsExternref(ctx, fctx, args[0]);
    else fctx.body.push({ op: "ref.null.extern" });
    fctx.body.push({ op: "local.set", index: valueLocal });
    const cbLocal = allocLocal(fctx, `__ds_cb_${fctx.locals.length}`, EXTERNREF);
    if (args[1]) compileArgAsExternref(ctx, fctx, args[1]);
    else fctx.body.push({ op: "ref.null.extern" });
    fctx.body.push({ op: "local.set", index: cbLocal });
    fctx.body.push({ op: "local.get", index: stackLocal });
    fctx.body.push({ op: "local.get", index: cbLocal });
    fctx.body.push({ op: "local.get", index: valueLocal });
    fctx.body.push({ op: "i32.const", value: ENTRY_KIND_ADOPT });
    fctx.body.push({ op: "call", funcIdx: appendIdx });
    fctx.body.push({ op: "local.get", index: valueLocal }); // return value
    return EXTERNREF;
  }

  if (methodName === "use") {
    return compileNativeDisposableStackUse(ctx, fctx, propAccess, args);
  }

  return undefined;
}

/** Well-known-symbol id for `Symbol.dispose` (property-access.ts registry). */
const SYMBOL_DISPOSE_ID = 13;

/**
 * (#3231 Phase 1b) `DisposableStack.prototype.use(value)` — the one method whose
 * disposer is discovered by a RUNTIME member lookup on an arbitrary receiver
 * (§ CreateDisposableResource → GetDisposeMethod → GetMethod(V, @@dispose)),
 * rather than a caller-supplied `onDispose`. Spec order (§12.3.3.3):
 *
 *   1. RequireInternalSlot + disposed-throw (ReferenceError) — ALWAYS first,
 *      even for `use(null)` on a disposed stack (test `throws-if-disposed`).
 *   2. If value is null/undefined → return value, no resource added
 *      (AddDisposableResource step 1.a; tests `allows-null-value`/`returns-value`).
 *   3. Else GetMethod(value, @@dispose): read `value[Symbol.dispose]` ONCE (an
 *      accessor is invoked exactly once — test `gets-value-…-property-once`) via
 *      the native `$Object` dynamic reader `__extern_get(value, __box_symbol(13))`.
 *      A non-object receiver reads back undefined (miss), so it lands in the same
 *      TypeError arm as an object missing the method — matching the spec's two
 *      distinct TypeError sources with one observable result.
 *   4. If the method is nullish → TypeError (tests `throws-if-value-not-object`,
 *      `throws-if-value-missing-Symbol.dispose`, `…-property-is-null`).
 *   5. Append entry{cb: method, value, kind: USE}; the dispose loop later runs
 *      `__call_fn_method_0(value, method)` (method-bound `this`). Return value.
 *
 * Gated `ctx.nativeStrings` (the caller's gate). The value is read via the same
 * native `$Object`/`__box_symbol` substrate the object-literal writer uses
 * (`literals.ts`), so a `{ [Symbol.dispose]() {} }` resource — always represented
 * as a native `$Object` under a `$Symbol` key — is found host-free.
 */
function compileNativeDisposableStackUse(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  args: ts.NodeArray<ts.Expression> | readonly ts.Expression[],
): InnerResult {
  const appendIdx = ensureDisposableStackAppend(ctx);
  const checkIdx = ensureDisposableStackCheckActive(ctx);
  // Ensure the native object runtime is registered so `__extern_get` and
  // `__box_symbol` exist for the reads below.
  ensureObjectRuntime(ctx);

  const stackLocal = allocLocal(fctx, `__ds_stack_${fctx.locals.length}`, EXTERNREF);
  const valueLocal = allocLocal(fctx, `__ds_val_${fctx.locals.length}`, EXTERNREF);
  const methodLocal = allocLocal(fctx, `__ds_method_${fctx.locals.length}`, EXTERNREF);

  // Eval receiver → stackLocal; disposed-throw check FIRST (spec steps 2–3).
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.set", index: stackLocal });
  fctx.body.push({ op: "local.get", index: stackLocal });
  fctx.body.push({ op: "call", funcIdx: checkIdx });

  // Eval value → valueLocal.
  if (args[0]) compileArgAsExternref(ctx, fctx, args[0]);
  else fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "local.set", index: valueLocal });

  // Resolve the runtime helpers (registered by ensureObjectRuntime). `__box_symbol`
  // + `__extern_is_undefined` are ensured as (native, in standalone) late imports;
  // flush index shifts against fctx before baking the funcIdxs.
  const boxSymIdx = ensureLateImport(ctx, "__box_symbol", [{ kind: "i32" }], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");

  // The substrate should always exist once ensureObjectRuntime ran; if not, keep
  // the stack consistent (value evaluated for its side effects) and return value
  // rather than emit an unbalanced body.
  if (boxSymIdx === undefined || externGetIdx === undefined || isUndefinedIdx === undefined) {
    fctx.body.push({ op: "local.get", index: valueLocal });
    return EXTERNREF;
  }

  // Regime-independent "is null OR undefined" for a value held in `localIdx`,
  // leaving an i32 on the stack. `__extern_is_nullish` exists only under the
  // undefined-singleton regime (object-runtime.ts, #2106 S1); combine the always-
  // present `ref.is_null` (JS null / ref.null.extern) with `__extern_is_undefined`
  // (the boxed/singleton undefined) so both regimes are covered.
  const nullishOf = (localIdx: number): Instr[] => [
    { op: "local.get", index: localIdx },
    { op: "ref.is_null" },
    { op: "local.get", index: localIdx },
    { op: "call", funcIdx: isUndefinedIdx },
    { op: "i32.or" },
  ];
  const typeErr = (msg: string): Instr[] => buildThrowJsErrorInstrs(ctx, "TypeError", msg, { flush: fctx });

  // if !nullish(value): read method, validate, append.
  const nonNullishBody: Instr[] = [];
  // method = __extern_get(value, __box_symbol(SYMBOL_DISPOSE_ID)) — read ONCE.
  nonNullishBody.push({ op: "local.get", index: valueLocal });
  nonNullishBody.push({ op: "i32.const", value: SYMBOL_DISPOSE_ID });
  nonNullishBody.push({ op: "call", funcIdx: boxSymIdx });
  nonNullishBody.push({ op: "call", funcIdx: externGetIdx });
  nonNullishBody.push({ op: "local.set", index: methodLocal });
  // if nullish(method): TypeError (non-object receiver OR missing/null @@dispose).
  nonNullishBody.push(...nullishOf(methodLocal));
  nonNullishBody.push({
    op: "if",
    blockType: { kind: "empty" },
    then: typeErr("DisposableStack.prototype.use: value is not disposable"),
    else: [],
  });
  // append entry{cb: method, value, kind: USE}
  nonNullishBody.push({ op: "local.get", index: stackLocal });
  nonNullishBody.push({ op: "local.get", index: methodLocal });
  nonNullishBody.push({ op: "local.get", index: valueLocal });
  nonNullishBody.push({ op: "i32.const", value: ENTRY_KIND_USE });
  nonNullishBody.push({ op: "call", funcIdx: appendIdx });

  fctx.body.push(...nullishOf(valueLocal));
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: nonNullishBody, else: [] });

  // Return value.
  fctx.body.push({ op: "local.get", index: valueLocal });
  return EXTERNREF;
}

/**
 * (#3231) Intercept the `DisposableStack.prototype.disposed` accessor in
 * standalone / `nativeStrings` mode → the struct's `disposed` i32 flag (0/1).
 * Receiver is compiled here. Returns i32 when handled, else `undefined`.
 */
export function tryCompileNativeDisposableStackDisposedGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
): InnerResult | undefined {
  if (!ctx.nativeStrings) return undefined;
  const t = ensureDisposableStackTypes(ctx);
  const recvType = compileExpression(ctx, fctx, receiver);
  if (recvType === null) return undefined;
  if (recvType.kind === "externref") {
    fctx.body.push(...externToStack(ctx));
  } else if ((recvType.kind === "ref" || recvType.kind === "ref_null") && recvType.typeIdx !== t.stackTypeIdx) {
    return undefined;
  }
  // struct.get disposed (fieldIdx 0) — a null receiver here would trap; the
  // getter is only reached on a real DisposableStack instance (brand-typed).
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 0 });
  return { kind: "i32" } as ValType;
}
