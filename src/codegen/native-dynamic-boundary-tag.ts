// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ensureAnyHelpers, ensureAnyValueType } from "./any-helpers.js";
import { jsValueBoundary, type CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addUnionImports } from "./registry/imports.js";
import { ensureNativeStringBoundaryBridge } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";

/**
 * Emit the narrow JS/Wasm adapter for native `any`/`unknown` boundary values.
 *
 * JS primitives are converted to existing native carriers before invoking a
 * user export. Null and undefined need distinct `$AnyValue` carriers because a
 * bare JS externref cannot be classified as undefined by Wasm alone. The tag
 * classifier maps only those two boundary carriers back; all other values stay
 * under their ordinary string/number/boolean/bigint/object adapters.
 */
export function ensureNativeDynamicBoundaryBridge(ctx: CodegenContext): void {
  ensureNativeStringBoundaryBridge(ctx);
  addUnionImports(ctx);
  ensureAnyHelpers(ctx);

  for (const name of [
    "__box_number",
    "__box_boolean",
    "__box_bigint",
    "__typeof_number",
    "__unbox_number",
    "__typeof_boolean",
    "__unbox_boolean",
    "__typeof_bigint",
    "__to_bigint",
    "__any_box_null",
    "__any_box_undefined",
  ]) {
    const funcIdx = ctx.funcMap.get(name);
    if (funcIdx === undefined) continue;
    const func = definedFuncAt(ctx, funcIdx);
    if (func) func.exported = true;
    if (!ctx.mod.exports.some((entry) => entry.name === name)) {
      ctx.mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
    }
  }

  ensureNativeDynamicBoundaryTag(ctx);
}

/** Export the narrow tag probe that distinguishes native null and undefined. */
export function ensureNativeDynamicBoundaryTag(ctx: CodegenContext): void {
  ensureNativeBoundaryCarrierProbe(ctx);
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

/** Classify opaque GC references without invoking any JavaScript object trap. */
function ensureNativeBoundaryCarrierProbe(ctx: CodegenContext): void {
  if (!jsValueBoundary(ctx) || ctx.strictNoHostImports) return;
  const name = "__dynamic_boundary_is_gc";
  let index = ctx.funcMap.get(name);
  if (index === undefined) {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], name);
    index = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, index, {
      name,
      typeIdx,
      locals: [],
      exported: true,
      body: [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "ref.test", typeIdx: -19 }],
    });
    ctx.funcMap.set(name, index);
  }
  if (!ctx.mod.exports.some((entry) => entry.name === name)) {
    ctx.mod.exports.push({ name, desc: { kind: "func", index } });
  }
}

/** Promise<void> needs only the tag probe on the exact standalone-native lane. */
export function prepareStandaloneNativePromiseUndefinedBoundary(ctx: CodegenContext): void {
  if (ctx.standalone && ctx.nativeStrings && ctx.targetProfile.environment === "none") {
    ensureNativeDynamicBoundaryTag(ctx);
  }
}
