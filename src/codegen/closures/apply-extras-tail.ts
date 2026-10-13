// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6959 review) The over-application TAIL carrier between `__apply_closure`
 * and the ordinary `__call_fn_method_<N>` dispatchers (standalone/wasi only).
 *
 * ## The gap this closes
 *
 * `__apply_closure` routes `n > 8` actual arguments into an ORDINARY closure
 * (declared arity <= 8) through the highest ordinary dispatcher,
 * `__call_fn_method_<top>` with `top <= 8`. That dispatcher's signature holds
 * exactly `top` argument slots, and its #820l setup rebuilds `__extras_argv`
 * from those slots alone — so every actual argument past `top` was dropped:
 *
 *     fn = function () { return arguments.length; };   // 9 args → 8
 *     fn = function () { return arguments[8]; };        // 9 args → undefined
 *
 * ## The mechanism
 *
 * `__apply_closure` slices `args[top..n)` into a vec, stores it in the
 * `__apply_extras_tail` global and calls the dispatcher immediately — the
 * slice is built BEFORE the global is written, so a getter on an array-like
 * carrier that re-enters the bridge cannot observe or clobber it. The
 * dispatcher consumes the global in its FIRST instructions (read into a local,
 * reset to null), before any arm can run user code or decline, so a tail can
 * never leak into a later, unrelated dispatcher call. Each ordinary entry then
 * appends the tail to the extras it built (`arguments`), and a rest entry with
 * an externref element appends it to the rest vec. `__argc` already carries
 * the exact count `n` (seeded by the bridge), and the dispatcher clamps it to
 * the callee's formals, so `arguments.length` is `formals + (top - formals) +
 * (n - top) = n`.
 *
 * Only dispatchers that can be the bridge's ordinary top carry the tail
 * (`5 <= N <= 8`: 0..5 are always minted together, so the top is never below
 * 5), and only when the bridge is reserved — every other module, and the
 * gc/host lane, stays byte-identical. Indices are re-resolved by NAME at every
 * emission: a cached global index goes stale when a late string-constant
 * import shifts the module-global range (see `fixupModuleGlobalIndices`).
 */
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { addFuncType, getArrTypeIdxFromVec } from "../registry/types.js";

const TAIL_GLOBAL = "__apply_extras_tail";
const VEC_CONCAT = "__apply_vec_concat";
const ARGS_SLICE = "__apply_args_slice";

/**
 * Dispatcher arities emitted WITH tail support, and the `$vec_externref` the
 * extras carrier uses, per module. The vec type is INJECTED by the dispatcher
 * (it already holds it) rather than imported, so this leaf stays out of the
 * codegen import SCC.
 */
const tailState = new WeakMap<CodegenContext, { arities: Set<number>; vecTypeIdx: number }>();

function tailGlobalIdx(ctx: CodegenContext): number | undefined {
  const local = ctx.mod.globals.findIndex((g) => g.name === TAIL_GLOBAL);
  return local < 0 ? undefined : ctx.numImportGlobals + local;
}

/** `(ref null vec, ref null vec) -> ref null vec`: `a ++ b`, either side may be null. */
function ensureVecConcat(ctx: CodegenContext, vecTypeIdx: number): void {
  if (ctx.funcMap.has(VEC_CONCAT)) return;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const vec: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
  const typeIdx = addFuncType(ctx, [vec, vec], [vec], `$${VEC_CONCAT}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  const [a, b, lenA, lenB, arr] = [0, 1, 2, 3, 4];
  const copy = (dst: Instr[], src: number, len: number): Instr[] => [
    { op: "local.get", index: arr },
    { op: "ref.as_non_null" },
    ...dst,
    { op: "local.get", index: src },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: len },
    { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
  ];
  pushDefinedFunc(ctx, funcIdx, {
    name: VEC_CONCAT,
    typeIdx,
    locals: [
      { name: "__len_a", type: { kind: "i32" } },
      { name: "__len_b", type: { kind: "i32" } },
      { name: "__arr", type: { kind: "ref_null", typeIdx: arrTypeIdx } },
    ],
    body: [
      { op: "local.get", index: b },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: a }, { op: "return" }] },
      { op: "local.get", index: a },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: b }, { op: "return" }] },
      { op: "local.get", index: a },
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: lenA },
      { op: "local.get", index: b },
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: lenB },
      { op: "local.get", index: lenA },
      { op: "local.get", index: lenB },
      { op: "i32.add" },
      { op: "array.new_default", typeIdx: arrTypeIdx },
      { op: "local.set", index: arr },
      ...copy([{ op: "i32.const", value: 0 }], a, lenA),
      ...copy([{ op: "local.get", index: lenA }], b, lenB),
      { op: "local.get", index: lenA },
      { op: "local.get", index: lenB },
      { op: "i32.add" },
      { op: "local.get", index: arr },
      { op: "ref.as_non_null" },
      { op: "struct.new", typeIdx: vecTypeIdx },
    ],
    exported: false,
  });
  ctx.funcMap.set(VEC_CONCAT, funcIdx);
}

/**
 * Dispatcher side: called once per `__call_fn_method_<arity>` emission.
 * Returns `undefined` (nothing changes) unless this dispatcher may be the
 * bridge's ordinary top. `tailLocal` must be a fresh local the caller appends
 * with {@link ApplyTailDispatch.local}.
 */
export interface ApplyTailDispatch {
  readonly local: { name: string; type: ValType };
  /** First body instructions: consume the global into the local. */
  prologue(): Instr[];
  /** After the #820l setup: `__extras_argv ++= tail`. */
  appendExtras(extrasGlobalIdx: number): Instr[];
  /** Append the tail to a materialized externref-element rest vec, or leave it. */
  appendRest(restInstrs: Instr[], restVecTypeIdx: number | undefined): Instr[];
}

export function applyTailDispatch(
  ctx: CodegenContext,
  arity: number,
  minHostArity: number,
  tailLocal: number,
  vecTypeIdx: number,
): ApplyTailDispatch | undefined {
  if (ctx.applyClosureReserved !== true || minHostArity !== 0 || arity < 5 || arity > 8) return undefined;
  if (!ctx.standalone && !ctx.wasi) return undefined;
  if (tailGlobalIdx(ctx) === undefined) {
    ctx.mod.globals.push({
      name: TAIL_GLOBAL,
      type: { kind: "ref_null", typeIdx: vecTypeIdx },
      mutable: true,
      init: [{ op: "ref.null", typeIdx: vecTypeIdx }],
    });
  }
  ensureVecConcat(ctx, vecTypeIdx);
  let state = tailState.get(ctx);
  if (!state) tailState.set(ctx, (state = { arities: new Set(), vecTypeIdx }));
  state.arities.add(arity);
  const concat = (): Instr => ({ op: "call", funcIdx: ctx.funcMap.get(VEC_CONCAT)! });
  return {
    local: { name: "__apply_tail", type: { kind: "ref_null", typeIdx: vecTypeIdx } },
    prologue: () => [
      { op: "global.get", index: tailGlobalIdx(ctx)! },
      { op: "local.set", index: tailLocal },
      { op: "ref.null", typeIdx: vecTypeIdx },
      { op: "global.set", index: tailGlobalIdx(ctx)! },
    ],
    appendExtras: (extrasGlobalIdx) => [
      { op: "local.get", index: tailLocal },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "global.get", index: extrasGlobalIdx },
          { op: "local.get", index: tailLocal },
          concat(),
          { op: "global.set", index: extrasGlobalIdx },
        ],
      },
    ],
    appendRest: (restInstrs, restVecTypeIdx) => {
      if (restVecTypeIdx !== vecTypeIdx) return restInstrs;
      const last = restInstrs[restInstrs.length - 1];
      const boxed = last?.op === "extern.convert_any";
      const vecInstrs = boxed ? restInstrs.slice(0, -1) : restInstrs;
      return [
        ...vecInstrs,
        { op: "local.get", index: tailLocal },
        concat(),
        { op: "ref.as_non_null" },
        ...(boxed ? ([{ op: "extern.convert_any" }] satisfies Instr[]) : []),
      ];
    },
  };
}

/** `(externref args, i32 start, i32 end) -> ref null vec` — `args[start..end)`. */
function ensureArgsSlice(ctx: CodegenContext, vecTypeIdx: number, getIdx: number): number {
  const existing = ctx.funcMap.get(ARGS_SLICE);
  if (existing !== undefined) return existing;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const typeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "i32" }, { kind: "i32" }],
    [{ kind: "ref_null", typeIdx: vecTypeIdx }],
    `$${ARGS_SLICE}_type`,
  );
  const funcIdx = mintDefinedFunc(ctx);
  const [args, start, end, count, i, arr] = [0, 1, 2, 3, 4, 5];
  pushDefinedFunc(ctx, funcIdx, {
    name: ARGS_SLICE,
    typeIdx,
    locals: [
      { name: "__count", type: { kind: "i32" } },
      { name: "__i", type: { kind: "i32" } },
      { name: "__arr", type: { kind: "ref_null", typeIdx: arrTypeIdx } },
    ],
    body: [
      { op: "local.get", index: end },
      { op: "local.get", index: start },
      { op: "i32.sub" },
      { op: "local.tee", index: count },
      { op: "array.new_default", typeIdx: arrTypeIdx },
      { op: "local.set", index: arr },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: i },
              { op: "local.get", index: count },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: arr },
              { op: "ref.as_non_null" },
              { op: "local.get", index: i },
              { op: "local.get", index: args },
              { op: "local.get", index: start },
              { op: "local.get", index: i },
              { op: "i32.add" },
              { op: "f64.convert_i32_s" },
              { op: "call", funcIdx: getIdx },
              { op: "array.set", typeIdx: arrTypeIdx },
              { op: "local.get", index: i },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: i },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: count },
      { op: "local.get", index: arr },
      { op: "ref.as_non_null" },
      { op: "struct.new", typeIdx: vecTypeIdx },
    ],
    exported: false,
  });
  ctx.funcMap.set(ARGS_SLICE, funcIdx);
  return funcIdx;
}

/**
 * Bridge side: splice the tail store immediately BEFORE the final
 * `call __call_fn_method_<dispatcherArity>` of `__apply_closure`'s n > 8
 * ordinary arm (its operands are already on the stack). Returns `arm`
 * unchanged when that dispatcher was emitted without tail support or no
 * generic reader exists.
 */
export function withApplyTail(
  ctx: CodegenContext,
  arm: Instr[],
  dispatcherArity: number,
  argsLocal: number,
  countLocal: number,
): Instr[] {
  const state = tailState.get(ctx);
  if (state?.arities.has(dispatcherArity) !== true || arm[arm.length - 1]?.op !== "call") return arm;
  const getIdx = ctx.funcMap.get("__extern_get_idx");
  const globalIdx = tailGlobalIdx(ctx);
  if (getIdx === undefined || globalIdx === undefined) return arm;
  const sliceIdx = ensureArgsSlice(ctx, state.vecTypeIdx, getIdx);
  return [
    ...arm.slice(0, -1),
    { op: "local.get", index: argsLocal },
    { op: "i32.const", value: dispatcherArity },
    { op: "local.get", index: countLocal },
    { op: "call", funcIdx: sliceIdx },
    { op: "global.set", index: globalIdx },
    arm[arm.length - 1]!,
  ];
}
