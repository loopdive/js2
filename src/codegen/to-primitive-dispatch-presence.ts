// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { addUnionImports } from "./registry/imports.js";
import { isSyntheticStructName } from "./emit-helpers.js";
import { ensureCurrentThisGlobal } from "./statements/nested-declarations.js";

function numericDispatchResult(type: ValType | null | undefined): boolean {
  return type?.kind === "f64" || type?.kind === "i32" || type?.kind === "i64";
}

/** Undefined means no closure arm claimed the field; false is a nonnumeric arm. */
function closureDispatchNeedsBoxing(
  ctx: CodegenContext,
  structName: string,
  field: { type: ValType },
): boolean | undefined {
  if (field.type.kind === "ref" || field.type.kind === "ref_null") {
    const info = ctx.closureInfoByTypeIdx.get(field.type.typeIdx);
    if (info?.paramTypes.length === 0) return numericDispatchResult(info.returnType);
  }
  if (field.type.kind === "eqref" || field.type.kind === "externref") {
    const candidates = (ctx.valueOfClosureTypes.get(structName) ?? [])
      .map((typeIdx) => ctx.closureInfoByTypeIdx.get(typeIdx))
      .filter((info) => info?.paramTypes.length === 0);
    if (candidates.length) {
      // The externref arm selects only the first tracked callable; eqref emits
      // all guarded candidates. Match the real dispatch's selection exactly.
      return (field.type.kind === "externref" ? candidates.slice(0, 1) : candidates).some((info) =>
        numericDispatchResult(info?.returnType),
      );
    }
    if (ctx.funcMap.has("__call_accessor_get") && ctx.funcMap.has("__typeof_function")) return false;
  }
  return undefined;
}

/**
 * Resolve genuine numeric-result demand before any dispatch type/function
 * indices are captured. Provider registration may shift the live index space.
 * This mirrors arm selection without emitting padding or retaining indices.
 */
export function ensureToPrimitiveDispatchBoxing(ctx: CodegenContext): void {
  if (ctx.funcMap.has("__box_number")) return;
  for (const [structName, fields] of ctx.structFields) {
    if (!ctx.structMap.has(structName) || isSyntheticStructName(structName)) continue;
    for (const methodName of ["toString", "valueOf"]) {
      const field = fields.find((candidate) => candidate.name === methodName);
      const closure =
        field && (ctx.standalone || ctx.toPrimitiveForkedStructs.has(structName))
          ? closureDispatchNeedsBoxing(ctx, structName, field)
          : undefined;
      if (closure !== undefined) {
        if (closure) {
          addUnionImports(ctx);
          return;
        }
        continue;
      }
      const index = ctx.funcMap.get(`${structName}_${methodName}`);
      const fn = index === undefined ? undefined : definedFuncAt(ctx, index);
      const signature = fn ? ctx.mod.types[fn.typeIdx] : undefined;
      if (signature?.kind !== "func" || !numericDispatchResult(signature.results[0])) continue;
      // Match zeroArgCallPadInstrs' refusal for uninhabitable declared params.
      if (
        signature.params
          .slice(1)
          .some((type) => !["f64", "i32", "i64", "externref", "anyref", "eqref", "ref_null"].includes(type.kind))
      )
        continue;
      addUnionImports(ctx);
      return;
    }
  }
}

export function toPrimitivePresenceName(name: "__call_valueOf" | "__call_toString"): string {
  return `${name}_with_presence`;
}

/** Set only inside a callable arm, never merely on a nominal receiver match. */
export function markToPrimitiveDispatchCall(): Instr[] {
  return [
    { op: "i32.const", value: 1 },
    { op: "local.set", index: 7 },
  ];
}

interface DispatchFrame {
  readonly locals: WasmFunction["locals"];
  readonly currentThisGlobalIdx: number;
}

/** Called at the original current-this reservation site, before body building. */
export function captureToPrimitiveDispatchFrame(ctx: CodegenContext, hasClosureEntry: boolean): DispatchFrame {
  const locals: WasmFunction["locals"] = [
    { name: "__any", type: { kind: "anyref" } },
    { name: hasClosureEntry ? "__closure" : "__closure_unused", type: { kind: "eqref" } },
    { name: "__prev_this", type: { kind: "externref" } },
    { name: "__tp_result", type: { kind: "externref" } },
    { name: "__tp_funcref", type: { kind: "funcref" } },
    { name: "__tp_callable", type: { kind: "externref" } },
    // Per invocation: a nested coercion cannot change its caller's presence.
    { name: "__tp_matched", type: { kind: "i32" } },
  ];
  return { locals, currentThisGlobalIdx: ensureCurrentThisGlobal(ctx) };
}

/**
 * The private ABI returns (matched, value). A real null/undefined result is
 * independent of no-match. The public one-result ABI remains available to
 * existing host callers and discards only the separate presence result.
 */
export function publishToPrimitiveMethodDispatcher(
  ctx: CodegenContext,
  exportName: "__call_valueOf" | "__call_toString",
  publicTypeIdx: number,
  frame: DispatchFrame,
  dispatch: Instr[],
): void {
  const privateName = toPrimitivePresenceName(exportName);
  const privateTypeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }],
    [{ kind: "i32" }, { kind: "externref" }],
    "$call_toPrim_presence_type",
  );
  const privateIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, privateIdx, {
    name: privateName,
    typeIdx: privateTypeIdx,
    locals: frame.locals,
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 1 },
      // Keep the original receiver installation and normal-return restoration.
      { op: "global.get", index: frame.currentThisGlobalIdx },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 0 },
      { op: "global.set", index: frame.currentThisGlobalIdx },
      ...dispatch,
      { op: "local.set", index: 4 },
      { op: "local.get", index: 3 },
      { op: "global.set", index: frame.currentThisGlobalIdx },
      { op: "local.get", index: 7 },
      { op: "local.get", index: 4 },
    ],
    exported: false,
  });
  ctx.funcMap.set(privateName, privateIdx);

  const publicIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, publicIdx, {
    name: exportName,
    typeIdx: publicTypeIdx,
    locals: [{ name: "__tp_result", type: { kind: "externref" } }],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: privateIdx },
      { op: "local.set", index: 1 },
      { op: "drop" },
      { op: "local.get", index: 1 },
    ],
    exported: true,
  });
  ctx.mod.exports.push({ name: exportName, desc: { kind: "func", index: publicIdx } });
  ctx.funcMap.set(exportName, publicIdx);
}
