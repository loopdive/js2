// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6701 — native standalone body for `splice` on a DYNAMIC (`any`/externref)
 * Array receiver.
 *
 * `splice` was the last Array producer with no `$__vec_base` arm in the
 * closed-method dispatcher (#6447 named it; #6683 pinned it as the residual).
 * Under `--target standalone`
 *
 *     function id(v) { return v; }
 *     id([1, 2, 3]).splice(0, 2);      // answered null
 *
 * because the call fell to the open-`$Object` bottom arm, which answers
 * nothing for a vec brand. Unlike `slice`, `splice` MUTATES the receiver's
 * length, so it runs on the full array-like substrate: `__extern_set` (which
 * grows a `__vec_<k>` / `$ObjVec` on an index store at or past the end and
 * truncates on a `length` store), `__extern_has_idx` and `__delete_property`
 * (the #4394 generic mutators' substrate). Emitted at RESERVE time like the
 * rest of the `__arrprod_*` family; standalone-only.
 *
 * Deliberate under-approximations (as for #6683's `slice`):
 *   - ArraySpeciesCreate is a plain `$ObjVec`.
 *   - A HOLE inside the deleted range is copied into the result as
 *     `undefined`; holes in the MOVED range are preserved (HasProperty /
 *     DeletePropertyOrThrow, §23.1.3.31 steps 11–12).
 *   - ToIntegerOrInfinity of an argument skips ToPrimitive on an object.
 */
import type { Instr, ValType } from "../ir/types.js";
import {
  arrayCreateLengthCheck,
  clampRelative,
  integerArg,
  requireObjectCoercible,
  resolveSliceDeps,
} from "./array-slice-native.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";
import { addStringConstantGlobal } from "./registry/imports.js";

const F64: ValType = { kind: "f64" };
const EXTERNREF: ValType = { kind: "externref" };

// Param / local slots of `__arrprod_splice(recv, args)`.
const RECV = 0;
const ARGS = 1;
const LEN = 2;
const START = 3;
const DC = 4;
const ITEMS = 5;
const K = 6;
const TMP = 7;
const ARGC = 8;
const ARG = 9;
const OUT = 10;

const get = (i: number): Instr => ({ op: "local.get", index: i });
const set = (i: number): Instr => ({ op: "local.set", index: i });
const f64 = (value: number): Instr => ({ op: "f64.const", value });

/** `while (cond) { body }` — `cond` leaves an i32 "keep going" flag. */
function whileLoop(cond: Instr[], body: Instr[]): Instr {
  return {
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [...cond, { op: "i32.eqz" }, { op: "br_if", depth: 1 }, ...body, { op: "br", depth: 0 }],
      },
    ],
  };
}

/** `K += delta` */
function stepK(delta: number): Instr[] {
  return [get(K), f64(delta), { op: "f64.add" }, set(K)];
}

/**
 * Reserve (or fetch) `__arrprod_splice(recv: externref, args: externref) ->
 * externref` — §23.1.3.31 — where `args` is a `$ObjVec` of the call's
 * arguments. Returns `undefined` outside standalone or when the substrate is
 * unavailable, in which case the dispatcher keeps its previous behaviour.
 */
export function ensureNativeArraySplice(ctx: CodegenContext): number | undefined {
  if (!ctx.standalone) return undefined;
  const existing = ctx.funcMap.get("__arrprod_splice");
  if (existing !== undefined) return existing;
  const deps = resolveSliceDeps(ctx);
  const hasIdx = ctx.funcMap.get("__extern_has_idx");
  const del = ctx.funcMap.get("__delete_property");
  if (deps === undefined || hasIdx === undefined || del === undefined) return undefined;
  addStringConstantGlobal(ctx, "length");
  // Every Set in §23.1.3.31 is Set(O, P, V, true): a failed store (a read-only
  // or setter-less `length`) is a TypeError, not a silent no-op.
  const setStrict = ctx.funcMap.get("__extern_set_strict") ?? deps.externSet;
  const boxed = (idx: Instr[]): Instr[] => [...idx, { op: "call", funcIdx: deps.boxNumber }];
  // Move O[from] to O[to], or delete O[to] when `from` is absent (steps 11.b / 12.b).
  const moveOrDelete = (from: Instr[], to: Instr[]): Instr[] => [
    get(RECV),
    ...from,
    { op: "call", funcIdx: hasIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        get(RECV),
        ...boxed(to),
        get(RECV),
        ...from,
        { op: "call", funcIdx: deps.externGetIdx },
        { op: "call", funcIdx: setStrict },
      ],
      else: [get(RECV), ...boxed(to), { op: "call", funcIdx: del }, { op: "drop" }],
    },
  ];
  const lenMinusDc: Instr[] = [get(LEN), get(DC), { op: "f64.sub" }];

  const body: Instr[] = [
    ...requireObjectCoercible(ctx, deps, RECV, "splice"),
    get(RECV),
    { op: "call", funcIdx: deps.externLength },
    set(LEN),
    get(ARGS),
    { op: "call", funcIdx: deps.externLength },
    set(ARGC),
    // steps 3–6: actualStart
    ...integerArg(deps, ARGS, 0, TMP, ARG, [f64(0)], false),
    ...clampRelative(TMP, LEN),
    set(START),
    // steps 8–10: actualDeleteCount (no args ⇒ 0; start only ⇒ len − start)
    ...integerArg(deps, ARGS, 1, TMP, ARG, [get(LEN), get(START), { op: "f64.sub" }], false),
    f64(0),
    { op: "f64.max" },
    get(LEN),
    get(START),
    { op: "f64.sub" },
    { op: "f64.min" },
    set(DC),
    get(ARGC),
    f64(0),
    { op: "f64.eq" },
    { op: "if", blockType: { kind: "empty" }, then: [f64(0), set(DC)] },
    get(DC),
    ...arrayCreateLengthCheck(ctx),
    // itemCount = max(argc − 2, 0)
    get(ARGC),
    f64(2),
    { op: "f64.sub" },
    f64(0),
    { op: "f64.max" },
    set(ITEMS),
    // step 8: len + itemCount − deleteCount > 2^53 − 1 ⇒ TypeError (before any
    // shift — the tail move would otherwise walk ~2^53 indices)
    ...lenMinusDc,
    get(ITEMS),
    { op: "f64.add" },
    f64(9007199254740991),
    { op: "f64.gt" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(ctx, "TypeError", "Array.prototype.splice: result length exceeds 2^53 - 1"),
    },
    // step 11: A = the deleted elements
    { op: "call", funcIdx: deps.objVecNew },
    set(OUT),
    f64(0),
    set(K),
    whileLoop(
      [get(K), get(DC), { op: "f64.lt" }],
      [
        get(OUT),
        get(RECV),
        get(START),
        get(K),
        { op: "f64.add" },
        { op: "call", funcIdx: deps.externGetIdx },
        { op: "call", funcIdx: deps.objVecPush },
        ...stepK(1),
      ],
    ),
    get(ITEMS),
    get(DC),
    { op: "f64.lt" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // step 12.a/b: shift the tail left, then delete the vacated end
        get(START),
        set(K),
        whileLoop(
          [get(K), ...lenMinusDc, { op: "f64.lt" }],
          [...moveOrDelete([get(K), get(DC), { op: "f64.add" }], [get(K), get(ITEMS), { op: "f64.add" }]), ...stepK(1)],
        ),
        get(LEN),
        set(K),
        whileLoop(
          [get(K), ...lenMinusDc, get(ITEMS), { op: "f64.add" }, { op: "f64.gt" }],
          [
            get(RECV),
            ...boxed([get(K), f64(1), { op: "f64.sub" }]),
            { op: "call", funcIdx: del },
            { op: "drop" },
            ...stepK(-1),
          ],
        ),
      ],
      else: [
        get(ITEMS),
        get(DC),
        { op: "f64.gt" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // step 13: shift the tail right, from the end
            ...lenMinusDc,
            set(K),
            whileLoop(
              [get(K), get(START), { op: "f64.gt" }],
              [
                ...moveOrDelete(
                  [get(K), get(DC), { op: "f64.add" }, f64(1), { op: "f64.sub" }],
                  [get(K), get(ITEMS), { op: "f64.add" }, f64(1), { op: "f64.sub" }],
                ),
                ...stepK(-1),
              ],
            ),
          ],
        },
      ],
    },
    // step 15: write the items
    f64(0),
    set(K),
    whileLoop(
      [get(K), get(ITEMS), { op: "f64.lt" }],
      [
        get(RECV),
        ...boxed([get(START), get(K), { op: "f64.add" }]),
        get(ARGS),
        get(K),
        f64(2),
        { op: "f64.add" },
        { op: "call", funcIdx: deps.externGetIdx },
        { op: "call", funcIdx: setStrict },
        ...stepK(1),
      ],
    ),
    // step 16: length = len − deleteCount + itemCount
    get(RECV),
    ...stringConstantExternrefInstrs(ctx, "length"),
    ...boxed([...lenMinusDc, get(ITEMS), { op: "f64.add" }]),
    { op: "call", funcIdx: setStrict },
    get(OUT),
  ];
  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [EXTERNREF]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__arrprod_splice", funcIdx);
  const locals: ValType[] = [F64, F64, F64, F64, F64, F64, F64, EXTERNREF, EXTERNREF];
  pushDefinedFunc(ctx, funcIdx, {
    name: "__arrprod_splice",
    typeIdx,
    locals: locals.map((type, i) => ({ name: `l${i}`, type })),
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * The reflective `Array.prototype.splice` VALUE (`obj.splice =
 * Array.prototype.splice; obj.splice(0, 1)`, `[].splice.call(o, …)`) refused
 * with "not yet callable as a value". In standalone it takes the packed-args
 * vec ABI (`(self, this, argsVec)`, like `push`/`concat`) so every inserted
 * item reaches the body, which is `__arrprod_splice(this, argsVec)`.
 */
export function isArraySpliceVariadicMember(ctx: CodegenContext, member: string): boolean {
  return member === "splice" && ctx.standalone;
}

/** Body of that closure; `undefined` (nothing emitted) when the helper is unavailable. */
export function emitArraySpliceProtoMemberBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
): ValType | undefined {
  if (!isArraySpliceVariadicMember(ctx, member) || fctx.params.length < 3) return undefined;
  const spliceIdx = ensureNativeArraySplice(ctx);
  if (spliceIdx === undefined) return undefined;
  fctx.body.push(get(1), get(2), { op: "extern.convert_any" }, { op: "call", funcIdx: spliceIdx });
  return EXTERNREF;
}
