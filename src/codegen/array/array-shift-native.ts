// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7081) Native standalone bodies for `shift` / `unshift` on a DYNAMIC
 * (`any`/externref) Array receiver.
 *
 * ```js
 * const paths = path.split("/");   // `any` in an untyped module
 * if (paths[0] === "") paths.shift();
 * ```
 *
 * hono's `splitPath` is exactly this, and under `--target standalone` the
 * `shift` was a silent no-op: `push`/`pop` (#2927), `splice` (#6701) and the
 * producers (#6447) have `$__vec_base` arms in the closed-method dispatcher,
 * but `shift`/`unshift` fell to the open-`$Object` bottom arm, which answers
 * `undefined` for a vec brand and mutates nothing. `["", "hello"]` stayed two
 * elements, so every route path split one segment too many.
 *
 * Both run on the same array-like substrate as `__arrprod_splice` —
 * `__extern_length`, `__extern_get_idx`, `__extern_has_idx`, `__extern_set`
 * (strict when available) and `__delete_property` — so they serve a concrete
 * `__vec_<k>` and the `$ObjVec` carrier alike, and holes in the moved range are
 * preserved (HasProperty / DeletePropertyOrThrow). Emitted at RESERVE time like
 * the rest of the `__arrprod_*` family; standalone-only.
 *
 * - `shift()` — §23.1.3.27: `len = 0` sets `length = 0` and answers
 *   `undefined`; otherwise `first = O[0]`, every later index moves down one,
 *   the last index is deleted, `length = len − 1`, and `first` is answered.
 * - `unshift(...items)` — §23.1.3.36: with items, `len + argCount > 2^53 − 1`
 *   is a TypeError, the elements move up by `argCount` from the end, the items
 *   are written at `0..argCount−1`; `length = len + argCount` is always set and
 *   answered.
 */
import type { Instr, ValType } from "../../ir/types.js";
import { undefinedExternInstrs } from "../any-helpers.js";
import { requireObjectCoercible, resolveSliceDeps, type SliceDeps } from "../array-slice-native.js";
import type { CodegenContext } from "../context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { buildThrowJsErrorInstrs } from "../js-errors.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { addStringConstantGlobal } from "../registry/imports.js";
import { addFuncType } from "../registry/types.js";

const F64: ValType = { kind: "f64" };
const EXTERNREF: ValType = { kind: "externref" };

/** Method names this module serves, for the dispatcher's producer gate. */
export const NATIVE_SHIFT_METHODS: ReadonlySet<string> = new Set(["shift", "unshift"]);

/** `shift` takes no argument; `unshift` is variadic. */
export function isNativeShiftForm(methodName: string, arity: number): boolean {
  return methodName === "shift" ? arity === 0 : arity >= 0;
}

// Param / local slots shared by both bodies: `(recv, args)` then locals.
const RECV = 0;
const ARGS = 1;
const LEN = 2;
const K = 3;
const ARGC = 4;
const FIRST = 5;

const get = (i: number): Instr => ({ op: "local.get", index: i });
const set = (i: number): Instr => ({ op: "local.set", index: i });
const f64 = (value: number): Instr => ({ op: "f64.const", value });

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

interface MoveDeps extends SliceDeps {
  hasIdx: number;
  del: number;
  setStrict: number;
}

/** Move O[from] to O[to], or delete O[to] when `from` is absent. */
function moveOrDelete(deps: MoveDeps, from: Instr[], to: Instr[]): Instr[] {
  const boxedTo: Instr[] = [...to, { op: "call", funcIdx: deps.boxNumber }];
  return [
    get(RECV),
    ...from,
    { op: "call", funcIdx: deps.hasIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        get(RECV),
        ...boxedTo,
        get(RECV),
        ...from,
        { op: "call", funcIdx: deps.externGetIdx },
        { op: "call", funcIdx: deps.setStrict },
      ],
      else: [get(RECV), ...boxedTo, { op: "call", funcIdx: deps.del }, { op: "drop" }],
    },
  ];
}

function setLength(ctx: CodegenContext, deps: MoveDeps, value: Instr[]): Instr[] {
  return [
    get(RECV),
    ...stringConstantExternrefInstrs(ctx, "length"),
    ...value,
    { op: "call", funcIdx: deps.boxNumber },
    { op: "call", funcIdx: deps.setStrict },
  ];
}

function buildShiftBody(ctx: CodegenContext, deps: MoveDeps): Instr[] {
  return [
    ...requireObjectCoercible(ctx, deps, RECV, "shift"),
    get(RECV),
    { op: "call", funcIdx: deps.externLength },
    set(LEN),
    get(LEN),
    f64(0),
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...setLength(ctx, deps, [f64(0)]),
        ...(undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }]),
        { op: "return" },
      ],
    },
    get(RECV),
    f64(0),
    { op: "call", funcIdx: deps.externGetIdx },
    set(FIRST),
    f64(1),
    set(K),
    whileLoop(
      [get(K), get(LEN), { op: "f64.lt" }],
      [...moveOrDelete(deps, [get(K)], [get(K), f64(1), { op: "f64.sub" }]), get(K), f64(1), { op: "f64.add" }, set(K)],
    ),
    get(RECV),
    get(LEN),
    f64(1),
    { op: "f64.sub" },
    { op: "call", funcIdx: deps.boxNumber },
    { op: "call", funcIdx: deps.del },
    { op: "drop" },
    ...setLength(ctx, deps, [get(LEN), f64(1), { op: "f64.sub" }]),
    get(FIRST),
  ];
}

function buildUnshiftBody(ctx: CodegenContext, deps: MoveDeps): Instr[] {
  return [
    ...requireObjectCoercible(ctx, deps, RECV, "unshift"),
    get(RECV),
    { op: "call", funcIdx: deps.externLength },
    set(LEN),
    get(ARGS),
    { op: "call", funcIdx: deps.externLength },
    set(ARGC),
    get(ARGC),
    f64(0),
    { op: "f64.gt" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        get(LEN),
        get(ARGC),
        { op: "f64.add" },
        f64(9007199254740991),
        { op: "f64.gt" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: buildThrowJsErrorInstrs(ctx, "TypeError", "Array.prototype.unshift: result length exceeds 2^53 - 1"),
        },
        get(LEN),
        set(K),
        whileLoop(
          [get(K), f64(0), { op: "f64.gt" }],
          [
            ...moveOrDelete(
              deps,
              [get(K), f64(1), { op: "f64.sub" }],
              [get(K), get(ARGC), { op: "f64.add" }, f64(1), { op: "f64.sub" }],
            ),
            get(K),
            f64(1),
            { op: "f64.sub" },
            set(K),
          ],
        ),
        f64(0),
        set(K),
        whileLoop(
          [get(K), get(ARGC), { op: "f64.lt" }],
          [
            get(RECV),
            get(K),
            { op: "call", funcIdx: deps.boxNumber },
            get(ARGS),
            get(K),
            { op: "call", funcIdx: deps.externGetIdx },
            { op: "call", funcIdx: deps.setStrict },
            get(K),
            f64(1),
            { op: "f64.add" },
            set(K),
          ],
        ),
      ],
    },
    ...setLength(ctx, deps, [get(LEN), get(ARGC), { op: "f64.add" }]),
    get(LEN),
    get(ARGC),
    { op: "f64.add" },
    { op: "call", funcIdx: deps.boxNumber },
  ];
}

/**
 * Reserve (or fetch) `__arrprod_shift` / `__arrprod_unshift(recv: externref,
 * args: externref) -> externref`. `undefined` outside standalone or when the
 * substrate is unavailable — the dispatcher then keeps its previous behaviour.
 */
export function ensureNativeArrayShift(ctx: CodegenContext, methodName: string): number | undefined {
  if (!ctx.standalone || !NATIVE_SHIFT_METHODS.has(methodName)) return undefined;
  const name = `__arrprod_${methodName}`;
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  const slice = resolveSliceDeps(ctx);
  const hasIdx = ctx.funcMap.get("__extern_has_idx");
  const del = ctx.funcMap.get("__delete_property");
  if (slice === undefined || hasIdx === undefined || del === undefined) return undefined;
  addStringConstantGlobal(ctx, "length");
  const deps: MoveDeps = {
    ...slice,
    hasIdx,
    del,
    setStrict: ctx.funcMap.get("__extern_set_strict") ?? slice.externSet,
  };
  const body = methodName === "shift" ? buildShiftBody(ctx, deps) : buildUnshiftBody(ctx, deps);
  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [EXTERNREF]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  const locals: ValType[] = [F64, F64, F64, EXTERNREF];
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: locals.map((type, i) => ({ name: `l${i}`, type })),
    body,
    exported: false,
  });
  return funcIdx;
}
