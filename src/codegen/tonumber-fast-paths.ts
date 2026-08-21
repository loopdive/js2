// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) Two independent fast paths for the standalone `externref → f64`
 * ToNumber lowering in `type-coercion.ts` — the single choke point every
 * `any`-typed numeric operand passes through. Both are **default ON** since the
 * tuned-set flip; `=0` on either flag restores the pre-#4157 emission.
 *
 * ## What the site emits today
 *
 *     <value: externref>
 *     global.get $str_"number"          ;; the ToPrimitive hint
 *     call $__to_primitive              ;; §7.1.1 ToPrimitive(v, number)
 *     call $__unbox_number              ;; §7.1.4 ToNumber(primitive)
 *
 * A disassembly of the standalone acorn build counts **1,092 static sites** of
 * exactly that pair, and the `cast-convert` profile bucket is 6.07 % of parse.
 * The pair is redundant in the overwhelmingly common case: `__to_primitive`
 * early-outs on a value that is ALREADY a primitive (`ref.i31`, `$BoxedNumber`,
 * native string, null) and hands it straight to `__unbox_number`, which then
 * re-discriminates the very same shape it was just handed.
 *
 * ## Slice A — `JS2WASM_FUSED_TONUMBER`: one call instead of two
 *
 * A fused `__to_number(externref) -> f64` that answers the three shapes whose
 * composition is decidable WITHOUT running any user code, and delegates every
 * other shape to the unchanged pair. See {@link buildFusedToNumberBody} for the
 * arm-by-arm equivalence argument. The saving at the SITE is the hint
 * `global.get` plus one call; the saving INSIDE is the second dispatch.
 *
 * ## Slice B — `JS2WASM_SMI_FASTPATH`: no call at all when the value is an i31
 *
 * `__box_number` has represented small integers as unboxed `ref.i31` since
 * #3673, and the #4157 census measured **99.31 % of 556,923 boxes per acorn
 * parse** taking that path. So the check — not the representation — is what is
 * missing at the consumer end: a `ref.test i31` at the coercion site turns the
 * whole ToNumber into `i31.get_s; f64.convert_i32_s`, with the existing chain as
 * the `else` arm.
 *
 * The two flags are orthogonal and compose: with both on, the SMI guard's slow
 * arm is the fused call.
 *
 * ## What is deliberately NOT here
 *
 * This module does the operand half only, which is op-agnostic and therefore
 * correct for arithmetic and comparison alike.
 *
 * The other half — keep an i32 result in i32 and re-box it with `ref.i31` —
 * was specced for the BINARY-OP site (`binary-ops-typed-dispatch.ts:626`, "both
 * operands externref"). **That arm is dead**: `compileBinaryExpression` compiles
 * both operands with a numeric hint, so the ToNumber is emitted inside each
 * operand's own compilation — at the very coercion site this module patches —
 * and all 1,617 arithmetic/relational dispatches in a standalone acorn compile
 * arrive `f64`/`f64`. The reachable half therefore lives at the BOXING site:
 * `smi-box-fast-path.ts`, same flag, with the measurement in the issue entry.
 */
import type { Instr, ValType, FuncHandle } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { addUnionImportsViaRegistry, ensureLateImport, flushLateImportShifts } from "./shared.js";
import { fusedToNumberEnabled, smiFastPathEnabled } from "./tonumber-fast-path-flags.js";
export { fusedToNumberEnabled, smiFastPathAllValues, smiFastPathEnabled } from "./tonumber-fast-path-flags.js";

/** The abstract `i31` heap type, as every other `ref.test`/`ref.cast` site spells it. */
const HEAP_I31 = -20;

/** The fused helper's name in `ctx.funcMap`. */
const FUSED_NAME = "__to_number";

/**
 * Which compiles reserved a fused helper, tracked HERE rather than as a
 * `CodegenContext` field: `context/types.ts` is a god-file under the #3102 LOC
 * gate, and a per-compile boolean that only this module reads has no business
 * widening the shared context type. A `WeakSet` keyed on the context is exact
 * (contexts are per-compile) and collects with it.
 */
const reservedIn = new WeakSet<CodegenContext>();

/**
 * Slice B needs a scratch local; Slice A does not. Several callers reach
 * `coerceType` with a DETACHED body-only shim rather than a real function
 * context — `ir/integration.ts`'s `emitToNumber` provider builds
 * `{ body: [], savedBodies: [] }` and says so in its comment ("this detached
 * buffer allocates no locals"). `allocTempLocal` reads `fctx.params.length +
 * fctx.locals.length`, so on such a shim it throws
 * `Cannot read properties of undefined (reading 'length')`, which the IR lane
 * converts into an `[IR-FALLBACK]` codegen error — measured: the whole acorn
 * compile produced no binary until this predicate was added.
 *
 * Declining is always safe: the site falls back to the fused call (Slice A) or
 * to the caller's own unchanged chain.
 */
function canAllocateLocals(fctx: FunctionContext): boolean {
  const f = fctx as unknown as { params?: unknown; locals?: unknown; localMap?: unknown };
  return Array.isArray(f.params) && Array.isArray(f.locals) && f.localMap instanceof Map;
}

/** `JS2WASM_TONUMBER_FAST_DEBUG=1` — per-compile site tallies, printed at exit. */
export const toNumberFastStats = { fusedSites: 0, smiSites: 0, declines: 0 };
let statsHookInstalled = false;
function note(bucket: "fusedSites" | "smiSites" | "declines"): void {
  if (process.env.JS2WASM_TONUMBER_FAST_DEBUG !== "1") return;
  toNumberFastStats[bucket]++;
  if (statsHookInstalled) return;
  statsHookInstalled = true;
  process.on("exit", () => {
    process.stderr.write(
      `[tonumber-fast] fused-call sites=${toNumberFastStats.fusedSites} ` +
        `smi-guarded sites=${toNumberFastStats.smiSites} declined=${toNumberFastStats.declines}\n`,
    );
  });
}

/**
 * The unchanged emission — `"number"` hint, `__to_primitive`, `__unbox_number`
 * — as an instruction array, so both fast paths can use it verbatim as their
 * slow arm. Byte-for-byte what `coerceType` emits inline today.
 */
function slowChainInstrs(ctx: CodegenContext, toPrimIdx: FuncHandle, unboxIdx: FuncHandle): Instr[] {
  return [
    ...stringConstantExternrefInstrs(ctx, "number"),
    { op: "call", funcIdx: toPrimIdx },
    { op: "call", funcIdx: unboxIdx },
  ];
}

/**
 * Register the dependencies both slices need and hand back their handles, or
 * `undefined` when this compile cannot support either fast path.
 *
 * The `__to_primitive` presence test is load-bearing, not defensive: in
 * standalone WITHOUT the native object runtime, `ensureLateImport` REFUSES the
 * `env::__to_primitive` host import and reports a #1806 compile error, and the
 * site's existing degenerate fallback is part of that error path. Taking it
 * over would change which diagnostic a broken program produces.
 */
function ensureDeps(
  ctx: CodegenContext,
  fctx: FunctionContext,
): { toPrimIdx: FuncHandle; unboxIdx: FuncHandle } | undefined {
  if (!ctx.funcMap.has("__to_primitive")) return undefined;
  const toPrimIdx = ensureLateImport(
    ctx,
    "__to_primitive",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  if (toPrimIdx === undefined) return undefined;
  addUnionImportsViaRegistry(ctx); // __unbox_number + ctx.nativeBoxNumberTypeIdx
  addStringConstantGlobal(ctx, "number");
  flushLateImportShifts(ctx, fctx);
  const unboxIdx = ctx.funcMap.get("__unbox_number");
  if (unboxIdx === undefined) return undefined;
  return { toPrimIdx, unboxIdx };
}

/**
 * Slice A's helper body.
 *
 * ## Why each fast arm is equivalent to the pair it replaces
 *
 * Read against `__to_primitive` (`object-runtime.ts`) and `__unbox_number`
 * (`registry/imports.ts`); both are the standalone NATIVE definitions, which is
 * why this whole module is gated on `ctx.standalone`.
 *
 * | value | `__to_primitive(v,"number")` | `__unbox_number(·)` | fused arm |
 * | --- | --- | --- | --- |
 * | `null` extern | step 1 `ref.is_null` ⇒ returns `v` | `ref.is_null` ⇒ `0` | `f64.const 0` |
 * | `ref.i31` | round-11 primitive early-out ⇒ returns `v` | i31 arm ⇒ `i31.get_s; f64.convert_i32_s` | same two instructions |
 * | `$BoxedNumber` | same early-out ⇒ returns `v` | struct arm ⇒ `struct.get 0` | same `struct.get` |
 * | anything else | (may run user `valueOf`/`toString`, may throw) | | **calls the pair, unchanged** |
 *
 * Crucially all three fast shapes are ones on which `__to_primitive` runs NO
 * user code and cannot throw — it early-outs before the `$Object` test — so
 * fusing cannot reorder, skip or duplicate an observable effect. Every shape
 * where ToPrimitive is observable (a `$Object` with `valueOf`/`toString`, a
 * class instance, an array, a wrapper with a `[[PrimitiveValue]]` slot, a
 * native string, the `$AnyValue` `undefined` singleton) is left to the original
 * pair, in the original order.
 *
 * The native-string case is a deliberate exclusion even though it is decidable:
 * its composition is `__str_to_number`, a full numeric-literal scanner, and
 * duplicating the shape test to save one call on a path that then runs a parse
 * loop buys nothing while adding a second place for §7.1.4.1 to drift.
 */
function buildFusedToNumberBody(ctx: CodegenContext, toPrimIdx: FuncHandle, unboxIdx: FuncHandle): Instr[] {
  const boxNumIdx = ctx.nativeBoxNumberTypeIdx;
  const L_ANY = 1;
  return [
    // ToNumber(null) === 0, via ToPrimitive's null pass-through.
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: 0 }, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: L_ANY },
    // Unboxed small int — 99.31 % of this workload's boxes (#4157 census).
    { op: "ref.test", typeIdx: HEAP_I31 },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_ANY },
        { op: "ref.cast", typeIdx: HEAP_I31 },
        { op: "i31.get_s" },
        { op: "f64.convert_i32_s" },
        { op: "return" },
      ],
    },
    ...(boxNumIdx >= 0
      ? ([
          { op: "local.get", index: L_ANY },
          { op: "ref.test", typeIdx: boxNumIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: L_ANY },
              { op: "ref.cast", typeIdx: boxNumIdx },
              { op: "struct.get", typeIdx: boxNumIdx, fieldIdx: 0 },
              { op: "return" },
            ],
          },
        ] satisfies Instr[])
      : []),
    // Everything ToPrimitive can OBSERVE goes down the original chain.
    { op: "local.get", index: 0 },
    ...slowChainInstrs(ctx, toPrimIdx, unboxIdx),
  ];
}

/**
 * Reserve (or fetch) `__to_number(externref) -> f64`.
 *
 * Reserve-then-fill, exactly like `reserveTypedMemberGetF64Dispatch` (#3673):
 * the deps are registered HERE so the finalize fill only READS `funcMap`. The
 * body is not built at reserve time because `__unbox_number`'s slot is minted
 * by the union-natives `registerNative`, which uses a raw
 * `numImportFuncs + functions.length` index rather than a stable handle — that
 * index is only final once every late import has landed.
 */
function reserveFusedToNumber(ctx: CodegenContext, fctx: FunctionContext): FuncHandle | undefined {
  const existing = ctx.funcMap.get(FUSED_NAME);
  if (existing !== undefined) return existing;
  if (ensureDeps(ctx, fctx) === undefined) return undefined;
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }], "$to_number_type");
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: FUSED_NAME,
    typeIdx,
    locals: [{ name: "$any", type: { kind: "anyref" } as ValType }],
    body: [{ op: "unreachable" }],
    exported: false,
  });
  ctx.funcMap.set(FUSED_NAME, funcIdx);
  reservedIn.add(ctx);
  return funcIdx;
}

/**
 * Reserve and return the exact callable providers selected by standalone
 * `externref -> f64` ToNumber lowering.
 *
 * Prepared-component sealing cannot infer these from `dyn.to_number`: with
 * fusion enabled the emitted site calls `__to_number` directly, while the
 * helper transitively calls `__to_primitive` and `__unbox_number`; with fusion
 * disabled the site calls the latter pair directly. Returning the handles
 * from this module keeps provider selection coupled to the canonical flag and
 * reservation policy instead of duplicating it in the IR integration layer.
 */
export function prepareStandaloneExternrefToNumberProviders(
  ctx: CodegenContext,
  fctx: FunctionContext,
):
  | {
      readonly toPrimitive: FuncHandle;
      readonly unboxNumber: FuncHandle;
      readonly fusedToNumber?: FuncHandle;
    }
  | undefined {
  if (!ctx.standalone) return undefined;
  const deps = ensureDeps(ctx, fctx);
  if (!deps) return undefined;
  if (!fusedToNumberEnabled()) {
    return { toPrimitive: deps.toPrimIdx, unboxNumber: deps.unboxIdx };
  }
  const fusedToNumber = reserveFusedToNumber(ctx, fctx);
  return fusedToNumber === undefined
    ? undefined
    : { toPrimitive: deps.toPrimIdx, unboxNumber: deps.unboxIdx, fusedToNumber };
}

/**
 * Fill the reserved `__to_number` at FINALIZE, when `__to_primitive` and
 * `__unbox_number` hold their final indices. No-op unless Slice A reserved one.
 */
export function fillFusedToNumber(ctx: CodegenContext): void {
  if (!reservedIn.has(ctx)) return;
  const funcIdx = ctx.funcMap.get(FUSED_NAME);
  const fn = funcIdx !== undefined ? definedFuncAt(ctx, funcIdx) : undefined;
  if (!fn) return;
  const toPrimIdx = ctx.funcMap.get("__to_primitive");
  const unboxIdx = ctx.funcMap.get("__unbox_number");
  if (toPrimIdx === undefined || unboxIdx === undefined) {
    // Unreachable in practice — reserve required both. Degrade to the same
    // answer the site's own dep-missing fallback produces rather than leaving
    // an `unreachable` body behind.
    fn.body = [{ op: "f64.const", value: Number.NaN }];
    return;
  }
  fn.body = buildFusedToNumberBody(ctx, toPrimIdx, unboxIdx);
}

/**
 * Emit the flag-selected fast path for a standalone `externref → f64` ToNumber
 * whose value is already on the stack. Returns `false` when the caller must
 * emit its own unchanged chain — which is ALWAYS the case with both flags off,
 * so the flag-off binary is byte-identical by construction (nothing below
 * mutates `ctx` before the flag test).
 */
export function tryEmitFastToNumber(
  ctx: CodegenContext,
  fctx: FunctionContext,
  hint: string,
  allocScratch?: () => number,
): boolean {
  const fused = fusedToNumberEnabled();
  const smi = smiFastPathEnabled() && (allocScratch !== undefined || canAllocateLocals(fctx));
  if (!smi && !fused) return false;
  // ToNumber is ToPrimitive with the NUMBER hint. A "string"/"default" hint is
  // a different abstract operation with a different method order (and, for
  // "default", `+`/`==` semantics) — never fused, never guarded.
  if (hint !== "number") return false;
  if (!ctx.standalone) return false;

  const deps = ensureDeps(ctx, fctx);
  if (deps === undefined) {
    note("declines");
    return false;
  }
  const { toPrimIdx, unboxIdx } = deps;

  // Slow arm: the fused call when Slice A is on, else the original chain.
  let slow: Instr[];
  if (fused) {
    const fusedIdx = reserveFusedToNumber(ctx, fctx);
    if (fusedIdx === undefined) {
      note("declines");
      return false;
    }
    slow = [{ op: "call", funcIdx: fusedIdx }];
  } else {
    slow = slowChainInstrs(ctx, toPrimIdx, unboxIdx);
  }

  if (!smi) {
    fctx.body.push(...slow);
    note("fusedSites");
    return true;
  }

  // Slice B. `ref.test` is the NON-nullable form (opcode 0xFB 0x14), so a null
  // externref answers 0 here and takes the slow arm — which returns 0 for null,
  // the same answer. No separate null test is needed, and `ref.cast` in the
  // then-arm therefore cannot see null.
  const tmp = allocScratch?.() ?? allocTempLocal(fctx, { kind: "externref" });
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.test", typeIdx: HEAP_I31 });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "f64" } as ValType },
    then: [
      { op: "local.get", index: tmp },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: HEAP_I31 },
      { op: "i31.get_s" },
      { op: "f64.convert_i32_s" },
    ],
    else: [{ op: "local.get", index: tmp }, ...slow],
  });
  if (!allocScratch) releaseTempLocal(fctx, tmp);
  note("smiSites");
  return true;
}
