// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ensureAnyValueType } from "./any-helpers.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

/** Export the narrow tag probe that distinguishes native null and undefined. */
export function ensureNativeDynamicBoundaryTag(ctx: CodegenContext): void {
  ensureAnyValueType(ctx);
  const name = "__dynamic_boundary_tag";
  let funcIdx = ctx.funcMap.get(name);
  if (funcIdx === undefined && ctx.anyValueTypeIdx >= 0) {
    const anyTypeIdx = ctx.anyValueTypeIdx;
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], name);
    funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name,
      typeIdx,
      locals: [
        { name: "any", type: { kind: "anyref" } },
        { name: "tag", type: { kind: "i32" } },
      ],
      body: [
        { op: "local.get", index: 0 },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [{ op: "i32.const", value: 1 }],
          else: [
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "local.tee", index: 1 },
            { op: "ref.test", typeIdx: anyTypeIdx },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: [
                { op: "local.get", index: 1 },
                { op: "ref.cast", typeIdx: anyTypeIdx },
                { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
                { op: "local.tee", index: 2 },
                { op: "i32.const", value: 2 },
                { op: "i32.lt_u" },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "i32" } },
                  then: [{ op: "local.get", index: 2 }, { op: "i32.const", value: 1 }, { op: "i32.add" }],
                  else: [{ op: "i32.const", value: 0 }],
                },
              ],
              else: [{ op: "i32.const", value: 0 }],
            },
          ],
        },
      ],
      exported: true,
    });
    ctx.funcMap.set(name, funcIdx);
  }
  if (funcIdx !== undefined && !ctx.mod.exports.some((entry) => entry.name === name)) {
    ctx.mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
  }
}

/** Promise<void> needs only the tag probe on the exact standalone-native lane. */
export function prepareStandaloneNativePromiseUndefinedBoundary(ctx: CodegenContext): void {
  if (
    ctx.standalone &&
    ctx.nativeStrings &&
    ctx.targetProfile.semanticProviders === "native-first" &&
    ctx.targetProfile.environment === "none"
  ) {
    ensureNativeDynamicBoundaryTag(ctx);
  }
}
