// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { coerceType } from "../shared.js";

/** The packed argument ABI preserves the optional start/end positions. */
export function isArrayFillVariadicMember(ctx: CodegenContext, member: string): boolean {
  return member === "fill" && (ctx.standalone || ctx.wasi);
}

/** Generic first-class Array.prototype.fill; no receiver replacement or copy. */
export function emitArrayFillProtoMemberBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
  services: {
    readonly clampRelative: typeof import("../array-slice-native.js").clampRelative;
    readonly requireObjectCoercible: typeof import("../array-slice-native.js").requireObjectCoercible;
    readonly resolveSliceDeps: typeof import("../array-slice-native.js").resolveSliceDeps;
  },
): ValType | undefined {
  const { clampRelative, requireObjectCoercible, resolveSliceDeps } = services;
  if (!isArrayFillVariadicMember(ctx, member)) return undefined;
  const deps = resolveSliceDeps(ctx);
  if (!deps) throw new Error("Array.prototype.fill lacks its native object helpers");
  const strictSet = ctx.funcMap.get("__extern_set_strict");
  if (strictSet === undefined) throw new Error("Array.prototype.fill lacks strict indexed assignment");
  const ext: ValType = { kind: "externref" };
  const num: ValType = { kind: "f64" };
  const args = allocLocal(fctx, "__fill_args", ext);
  const length = allocLocal(fctx, "__fill_length", num);
  const temp = allocLocal(fctx, "__fill_relative", num);
  const start = allocLocal(fctx, "__fill_start", num);
  const end = allocLocal(fctx, "__fill_end", num);
  const value = allocLocal(fctx, "__fill_value", ext);
  const get = (index: number): Instr => ({ op: "local.get", index });
  const set = (index: number): Instr => ({ op: "local.set", index });
  const constant = (value: number): Instr => ({ op: "f64.const", value });
  fctx.body.push(get(2), { op: "extern.convert_any" }, set(args));
  fctx.body.push(...requireObjectCoercible(ctx, deps, 1, member));
  fctx.body.push(get(1), { op: "call", funcIdx: deps.externLength }, set(temp));
  // LengthOfArrayLike: NaN/negative -> 0, truncate and cap at MAX_SAFE_INTEGER.
  fctx.body.push(
    get(temp),
    get(temp),
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "val", type: num },
      then: [constant(0)],
      else: [
        get(temp),
        { op: "f64.trunc" },
        constant(0),
        { op: "f64.max" },
        constant(9007199254740991),
        { op: "f64.min" },
      ],
    },
    set(length),
  );

  const index = (position: number, destination: number, defaultValue: Instr[], defaultUndefined: boolean): void => {
    const present: Instr[] = [
      get(args),
      { op: "call", funcIdx: deps.externLength },
      constant(position),
      { op: "f64.gt" },
    ];
    if (defaultUndefined)
      present.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          get(args),
          constant(position),
          { op: "call", funcIdx: deps.externGetIdx },
          { op: "call", funcIdx: deps.externIsUndefined },
          { op: "i32.eqz" },
        ],
        else: [{ op: "i32.const", value: 0 }],
      });
    const parent = fctx.body;
    const conversion: Instr[] = [];
    fctx.body = conversion;
    try {
      fctx.body.push(get(args), constant(position), { op: "call", funcIdx: deps.externGetIdx });
      // Use the regular ToNumber engine, including observable object coercion
      // and throwing Symbol/BigInt conversion, not a primitive-only unbox.
      coerceType(ctx, fctx, ext, num);
      fctx.body.push(
        set(temp),
        get(temp),
        get(temp),
        { op: "f64.ne" },
        {
          op: "if",
          blockType: { kind: "val", type: num },
          then: [constant(0)],
          else: [get(temp), { op: "f64.trunc" }],
        },
      );
    } finally {
      fctx.body = parent;
    }
    fctx.body.push(
      ...present,
      {
        op: "if",
        blockType: { kind: "val", type: num },
        then: conversion,
        else: defaultValue,
      },
      ...clampRelative(temp, length),
      set(destination),
    );
  };
  index(1, start, [constant(0)], false);
  index(2, end, [get(length)], true);
  fctx.body.push(get(args), constant(0), { op: "call", funcIdx: deps.externGetIdx }, set(value));
  fctx.body.push(
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            get(start),
            get(end),
            { op: "f64.ge" },
            { op: "br_if", depth: 1 },
            get(1),
            get(start),
            { op: "call", funcIdx: deps.boxNumber },
            get(value),
            { op: "call", funcIdx: strictSet },
            get(start),
            constant(1),
            { op: "f64.add" },
            set(start),
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    get(1),
  );
  return ext;
}
