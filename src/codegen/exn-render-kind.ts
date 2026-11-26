// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7453) The error KIND of a thrown payload, for a JS-side harness that must
 * tell an Error object from any other thrown value.
 *
 * A natively-thrown payload is a WasmGC ref the host cannot inspect, so the
 * test262 runtime-negative verdict took the kind from the module's own
 * `String(payload)` (`__exn_render_*`) up to the first `": "` — and then
 * `throw "TypeError: x"`, or an object whose `toString` returns that text, read
 * as a TypeError. `__exn_render_kind(payload: externref) -> i32` answers what
 * the harness reads off a host value (`name`, `constructor.name`) through the
 * render buffer `__exn_render_char` reads:
 *
 *   - `$Error_struct`         → its name (§20.5.3.4 step 3: the `name` field
 *                               when it is a string, else "Error")
 *   - a nominal instance      → its constructor: the `$__fnctor_F` struct of
 *                               a `new F()`, or a class's struct
 *   - an open `$Object`       → `[[Get]](o, "constructor").name` through the
 *                               module's own `__extern_get` (the harness's
 *                               `new Test262Error()` is one, its prototype
 *                               carrying the `toString`)
 *   - anything else (a string, a number, null), or no string name → -1: no kind
 *
 * Published only under the `exceptionKindExport` harness opt-in.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { storeAndReturnLen } from "./exn-render-lite.js";
import { COLD_TAIL_SUFFIX } from "./fnctor-cold-tail.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js";
import { addFuncType } from "./registry/types.js";

const FNCTOR_PREFIX = "__fnctor_";

/** The nominal instance structs and their constructors' names: every `new F()` layout, then every class. */
function constructorKinds(ctx: CodegenContext): { typeIdx: number; name: string }[] {
  const kinds: { typeIdx: number; name: string }[] = [];
  for (const [structName, typeIdx] of ctx.structMap)
    if (structName.startsWith(FNCTOR_PREFIX) && !structName.endsWith(COLD_TAIL_SUFFIX))
      kinds.push({ typeIdx, name: structName.slice(FNCTOR_PREFIX.length) });
  for (const [typeIdx, structName] of ctx.typeIdxToStructName)
    if (typeIdx !== ctx.errorStructTypeIdx && ctx.classSet.has(structName)) kinds.push({ typeIdx, name: structName });
  return kinds;
}

/**
 * §20.5.3.4 steps 3–4 on the `$Error_struct` ref on the stack: its `name` field
 * when that is a native string, else "Error". `tmp` is an `anyref` local.
 */
export function errorStructNameInstrs(ctx: CodegenContext, errStructIdx: number, tmp: number): Instr[] {
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  return [
    { op: "struct.get", typeIdx: errStructIdx, fieldIdx: 2 }, // $name (externref)
    { op: "any.convert_extern" },
    { op: "local.tee", index: tmp },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: [
        { op: "local.get", index: tmp },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
      ],
      else: nativeStringLiteralInstrs(ctx, "Error"),
    },
  ];
}

/** `[[Get]](o, "constructor").name` of the `$Object` payload, when the module has the object runtime. */
function objectConstructorNameArm(ctx: CodegenContext, store: Instr[]): Instr[] {
  const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  const externGetIdx = ctx.funcMap.get("__extern_get");
  if (objectTypeIdx === undefined || externGetIdx === undefined) return [];
  const get = (key: string): Instr[] => [
    ...nativeStringLiteralInstrs(ctx, key),
    { op: "extern.convert_any" },
    { op: "call", funcIdx: externGetIdx },
  ];
  return [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        ...get("constructor"),
        ...get("name"),
        { op: "any.convert_extern" },
        { op: "local.tee", index: 1 },
        { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "local.get", index: 1 }, { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx }, ...store],
        },
      ],
    },
  ];
}

/**
 * The `__exn_render_kind` body. Built BEFORE any export function is minted
 * (the index-shift-safety contract of `emitExceptionRenderExports`): it only
 * interns literal globals.
 */
export function exnRenderKindBody(
  ctx: CodegenContext,
  bufGlobalIdx: number,
  flattenIdx: number,
  flatTypeIdx: number,
): Instr[] {
  const payload: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }];
  const kindArm = (typeIdx: number, nameInstrs: Instr[]): Instr[] => [
    ...payload,
    { op: "ref.test", typeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...nameInstrs, ...storeAndReturnLen(flattenIdx, bufGlobalIdx, flatTypeIdx)],
    },
  ];
  const errStructIdx = ctx.errorStructTypeIdx;
  const body: Instr[] =
    errStructIdx < 0
      ? []
      : kindArm(errStructIdx, [
          ...payload,
          { op: "ref.cast", typeIdx: errStructIdx },
          ...errorStructNameInstrs(ctx, errStructIdx, 1),
        ]);
  for (const { typeIdx, name } of constructorKinds(ctx))
    body.push(...kindArm(typeIdx, nativeStringLiteralInstrs(ctx, name)));
  body.push(...objectConstructorNameArm(ctx, storeAndReturnLen(flattenIdx, bufGlobalIdx, flatTypeIdx)));
  body.push({ op: "i32.const", value: -1 });
  return body;
}

/** Mint and export `__exn_render_kind` with a body from `exnRenderKindBody`. */
export function pushExnRenderKindExport(ctx: CodegenContext, body: Instr[]): void {
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$exn_render_prepare_type");
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__exn_render_kind", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__exn_render_kind",
    typeIdx,
    locals: [{ name: "tmp", type: { kind: "anyref" } }],
    body,
    exported: true,
  } as WasmFunction);
  ctx.mod.exports.push({ name: "__exn_render_kind", desc: { kind: "func", index: funcIdx } });
}
