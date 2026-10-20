// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ensureAnyValueType } from "./any-helpers.js";
import { jsValueBoundary, type CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
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
  if (ctx.standalone && ctx.nativeStrings && ctx.targetProfile.environment === "none") {
    ensureNativeDynamicBoundaryTag(ctx);
  }
}

/**
 * (#7098) A closure the host calls back — `el.addEventListener("click", f)`, a
 * user `declare function` taking a callback — returns through the
 * `__call_fn_*` bridge as an externref the JS runtime must read. A void
 * closure answers the `$undefined` singleton and a Boolean one a native box;
 * neither is recognisable from JS without the module's own probes, so the
 * runtime presented both as an empty null-prototype object. Export the
 * existing tag probe and Boolean typeof/unbox pair (no new helper, no new
 * semantics) wherever that bridge meets a JS value boundary. Standalone and
 * WASI have no JS caller and keep their bytes.
 */
export function exposeClosureResultProbes(ctx: CodegenContext): void {
  if (!ctx.nativeStrings || ctx.strictNoHostImports || !jsValueBoundary(ctx)) return; // standalone/WASI: no JS caller
  if (ctx.anyValueTypeIdx < 0 || !ctx.mod.exports.some((entry) => entry.name.startsWith("__call_fn_"))) return;
  ensureNativeDynamicBoundaryTag(ctx);
  for (const name of ["__typeof_boolean", "__unbox_boolean"]) {
    const funcIdx = ctx.funcMap.get(name);
    if (funcIdx === undefined) continue;
    const func = definedFuncAt(ctx, funcIdx);
    if (func) func.exported = true;
    if (!ctx.mod.exports.some((entry) => entry.name === name))
      ctx.mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
  }
}
