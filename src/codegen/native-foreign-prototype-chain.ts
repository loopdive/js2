// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../ir/types.js";
import { jsValueBoundary, type CodegenContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";

const SAME_IDENTITY = "__boundary_object_same_identity";

/** Opaque JS references need an identity primitive, never a host semantic walk. */
export function prepareForeignPrototypeIdentity(ctx: CodegenContext): void {
  if (!jsValueBoundary(ctx) || ctx.strictNoHostImports) return;
  ensureLateImport(ctx, SAME_IDENTITY, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, null);
}

/** Params are prototype/value; the native algorithm owns every hop and result. */
export function foreignPrototypeChainArm(ctx: CodegenContext, getProtoIdx: number, cur: number): Instr[] {
  const same = ctx.funcMap.get(SAME_IDENTITY);
  const admitted = ctx.funcMap.get("__boundary_object_is_admitted");
  if (same === undefined || admitted === undefined) return [];
  return [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: admitted },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "local.set", index: cur },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: cur },
                { op: "call", funcIdx: getProtoIdx },
                { op: "local.tee", index: cur },
                { op: "ref.is_null" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: 0 },
                { op: "local.get", index: cur },
                { op: "call", funcIdx: same },
                { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "i32.const", value: 0 },
        { op: "return" },
      ],
    },
  ];
}

/** Foreign [[Get]] is authoritative even when `prototype` is inherited or a Proxy traps it. */
export function foreignCallablePrototypeArm(
  ctx: CodegenContext,
  getIdx: number,
  target: number,
  prototype: number,
  tail: () => Instr[],
): Instr[] {
  const admitted = ctx.funcMap.get("__boundary_object_is_admitted");
  const isObject = ctx.funcMap.get("__typeof_object");
  const isFunction = ctx.funcMap.get("__typeof_function");
  if (admitted === undefined || isObject === undefined || isFunction === undefined) return [];
  return [
    { op: "local.get", index: target },
    { op: "call", funcIdx: admitted },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: target },
        ...stringConstantExternrefInstrs(ctx, "prototype"),
        { op: "call", funcIdx: getIdx },
        { op: "local.set", index: prototype },
        { op: "local.get", index: prototype },
        { op: "call", funcIdx: isObject },
        { op: "local.get", index: prototype },
        { op: "call", funcIdx: isFunction },
        { op: "i32.or" },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 2 }, { op: "return" }] },
        ...tail(),
      ],
    },
  ];
}
