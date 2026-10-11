// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 H6) §23.1.3.4 `Array.prototype.copyWithin` on the standalone
 * array-like substrate — `__arrprod_copyWithin(recv, argsVec) -> recv`.
 *
 * `copyWithin` had no generic body in `--target standalone`: over any receiver
 * that is not a compiled vec, `Array.prototype.copyWithin.call(o, …)` threw
 * the "not yet callable as a value" TypeError. The two ES2015 rows that reach
 * it do so through a Proxy whose trap must run and whose abrupt completion
 * must propagate — `return-abrupt-from-has-start.js` (a `has` trap throws) and
 * `return-abrupt-from-delete-proxy-target.js` (a `deleteProperty` trap
 * throws) — and they were answered with that TypeError instead.
 *
 * The algorithm is the spec's, step for step, on the same natives as the
 * `slice`/`splice` producers (#6683/#6701): `__extern_length` (LengthOfArrayLike),
 * `__extern_has_idx` / `__extern_get_idx` (HasProperty / Get of `ToString(k)`),
 * `__extern_set_strict` (Set with `throw = true`) and `__delete_property`
 * (DeletePropertyOrThrow: a `false` result is the TypeError). Every key is the
 * canonical `ToString(k)` string, which is what a trap observes.
 *
 * Reached only through `array-proxy-receiver.ts` (a receiver that traces to a
 * Proxy VALUE); compiled vecs keep their typed lowering.
 */
import type { Instr, ValType } from "../../ir/types.js";
import {
  buildThrowJsErrorInstrs,
  clampRelative,
  integerArg,
  requireObjectCoercible,
  resolveSliceDeps,
} from "../helpers/core-delegates.js"; // (#6797) late-bound core
import type { CodegenContext } from "../context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { addFuncType } from "../registry/types.js";

const F64: ValType = { kind: "f64" };
const EXTERNREF: ValType = { kind: "externref" };
const HELPER = "__arrprod_copyWithin";

// Param / local slots.
const RECV = 0;
const ARGS = 1;
const LEN = 2;
const TO = 3;
const FROM = 4;
const FINAL = 5;
const COUNT = 6;
const DIR = 7;
const TMP = 8;
const ARG = 9;

const get = (i: number): Instr => ({ op: "local.get", index: i });
const set = (i: number): Instr => ({ op: "local.set", index: i });
const f64 = (value: number): Instr => ({ op: "f64.const", value });

/** Reserve (or fetch) the helper. `undefined` outside standalone or without the substrate. */
export function ensureNativeArrayCopyWithin(ctx: CodegenContext): number | undefined {
  if (!ctx.standalone) return undefined;
  const existing = ctx.funcMap.get(HELPER);
  if (existing !== undefined) return existing;
  const deps = resolveSliceDeps(ctx);
  const hasIdx = ctx.funcMap.get("__extern_has_idx");
  const del = ctx.funcMap.get("__delete_property");
  const toStr = ctx.funcMap.get("number_toString");
  if (deps === undefined || hasIdx === undefined || del === undefined || toStr === undefined) return undefined;
  const setStrict = ctx.funcMap.get("__extern_set_strict") ?? deps.externSet;
  const key = (local: number): Instr[] => [get(local), { op: "call", funcIdx: toStr }];

  const body: Instr[] = [
    ...requireObjectCoercible(ctx, deps, RECV, "copyWithin"),
    // step 2: len = LengthOfArrayLike(O)
    get(RECV),
    { op: "call", funcIdx: deps.externLength },
    set(LEN),
    // steps 3–4: to
    ...integerArg(deps, ARGS, 0, TMP, ARG, [f64(0)], false),
    ...clampRelative(TMP, LEN),
    set(TO),
    // steps 5–6: from
    ...integerArg(deps, ARGS, 1, TMP, ARG, [f64(0)], false),
    ...clampRelative(TMP, LEN),
    set(FROM),
    // steps 7–8: final (an absent or undefined `end` is len)
    ...integerArg(deps, ARGS, 2, TMP, ARG, [get(LEN)], true),
    ...clampRelative(TMP, LEN),
    set(FINAL),
    // step 9: count = min(final − from, len − to)
    get(FINAL),
    get(FROM),
    { op: "f64.sub" },
    get(LEN),
    get(TO),
    { op: "f64.sub" },
    { op: "f64.min" },
    set(COUNT),
    // steps 10–11: copy backwards when the ranges overlap with from < to
    f64(1),
    set(DIR),
    get(FROM),
    get(TO),
    { op: "f64.lt" },
    get(TO),
    get(FROM),
    get(COUNT),
    { op: "f64.add" },
    { op: "f64.lt" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        f64(-1),
        set(DIR),
        get(FROM),
        get(COUNT),
        { op: "f64.add" },
        f64(1),
        { op: "f64.sub" },
        set(FROM),
        get(TO),
        get(COUNT),
        { op: "f64.add" },
        f64(1),
        { op: "f64.sub" },
        set(TO),
      ],
    },
    // step 12: while count > 0
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            get(COUNT),
            f64(0),
            { op: "f64.gt" },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            get(RECV),
            get(FROM),
            { op: "call", funcIdx: hasIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // Set(O, toKey, Get(O, fromKey), true)
                get(RECV),
                ...key(TO),
                get(RECV),
                get(FROM),
                { op: "call", funcIdx: deps.externGetIdx },
                { op: "call", funcIdx: setStrict },
              ],
              else: [
                // DeletePropertyOrThrow(O, toKey)
                get(RECV),
                ...key(TO),
                { op: "call", funcIdx: del },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: buildThrowJsErrorInstrs(ctx, "TypeError", "Array.prototype.copyWithin: cannot delete property"),
                },
              ],
            },
            get(FROM),
            get(DIR),
            { op: "f64.add" },
            set(FROM),
            get(TO),
            get(DIR),
            { op: "f64.add" },
            set(TO),
            get(COUNT),
            f64(1),
            { op: "f64.sub" },
            set(COUNT),
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    get(RECV),
  ];
  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [EXTERNREF]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(HELPER, funcIdx);
  const locals: ValType[] = [F64, F64, F64, F64, F64, F64, F64, EXTERNREF];
  pushDefinedFunc(ctx, funcIdx, {
    name: HELPER,
    typeIdx,
    locals: locals.map((type, i) => ({ name: `l${i}`, type })),
    body,
    exported: false,
  });
  return funcIdx;
}
