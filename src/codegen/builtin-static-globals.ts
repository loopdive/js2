// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1888 S6 — demand-driven built-in namespace values for standalone.
 *
 * This is intentionally a small static-global surface, not a `globalThis`
 * emulator. Each supported built-in static method is compiled to a cached
 * Wasm closure, and each supported namespace (`Array`, `Object`) is a lazy
 * `$Object` singleton populated only with those supported properties.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { emitCachedFuncClosureAccess } from "./closures.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";

const SUPPORTED_STATIC_PROPS: ReadonlyMap<string, readonly string[]> = new Map([
  ["Array", ["isArray"]],
  ["Object", ["keys"]],
]);

export function isSupportedBuiltinNamespace(name: string): boolean {
  return SUPPORTED_STATIC_PROPS.has(name);
}

export function isSupportedBuiltinStaticProperty(builtinName: string, propName: string): boolean {
  return SUPPORTED_STATIC_PROPS.get(builtinName)?.includes(propName) ?? false;
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isTypeAssertionExpression(expr)
  ) {
    expr = ts.isParenthesizedExpression(expr)
      ? expr.expression
      : ts.isAsExpression(expr)
        ? expr.expression
        : ts.isNonNullExpression(expr)
          ? expr.expression
          : (expr as ts.TypeAssertion).expression;
  }
  return expr;
}

export function resolveBuiltinNamespaceValueName(ctx: CodegenContext, expr: ts.Expression): string | undefined {
  const unwrapped = unwrapExpression(expr);
  if (!ts.isIdentifier(unwrapped)) return undefined;
  if (isSupportedBuiltinNamespace(unwrapped.text)) return unwrapped.text;

  const sym = ctx.checker.getSymbolAtLocation(unwrapped);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
  const init = unwrapExpression(decl.initializer);
  if (ts.isIdentifier(init) && isSupportedBuiltinNamespace(init.text)) return init.text;
  return undefined;
}

function hiddenName(builtinName: string, propName: string): string {
  return `__builtin_static_${builtinName}_${propName}`;
}

function ensureArrayIsArrayFunc(ctx: CodegenContext): number {
  const name = hiddenName("Array", "isArray");
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$builtin_Array_isArray_type");
  const vecTypeIdxs = Array.from(new Set(ctx.vecTypeMap.values()));

  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];

  if (vecTypeIdxs.length === 0) {
    body.push({ op: "i32.const", value: 0 });
  } else {
    for (let i = 0; i < vecTypeIdxs.length; i++) {
      body.push({ op: "local.get", index: 1 } as Instr);
      body.push({ op: "ref.test", typeIdx: vecTypeIdxs[i]! } as Instr);
      if (i > 0) body.push({ op: "i32.or" } as Instr);
    }
  }

  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name,
    typeIdx,
    locals: [{ name: "any", type: { kind: "anyref" } }],
    body,
    exported: false,
  } as WasmFunction);
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}

function ensureObjectKeysFunc(ctx: CodegenContext): number {
  const name = hiddenName("Object", "keys");
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  ensureObjectRuntime(ctx);
  const objectKeysIdx = ctx.funcMap.get("__object_keys")!;
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$builtin_Object_keys_type");
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name,
    typeIdx,
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: objectKeysIdx },
    ],
    exported: false,
  } as WasmFunction);
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}

function ensureBuiltinStaticFunc(ctx: CodegenContext, builtinName: string, propName: string): number | undefined {
  if (builtinName === "Array" && propName === "isArray") return ensureArrayIsArrayFunc(ctx);
  if (builtinName === "Object" && propName === "keys") return ensureObjectKeysFunc(ctx);
  return undefined;
}

export function emitBuiltinStaticMethodValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  builtinName: string,
  propName: string,
): ValType | null {
  const funcIdx = ensureBuiltinStaticFunc(ctx, builtinName, propName);
  if (funcIdx === undefined) return null;
  return emitCachedFuncClosureAccess(ctx, fctx, hiddenName(builtinName, propName), funcIdx);
}

function coerceTopToExternref(fctx: FunctionContext, valueType: ValType | null): void {
  if (!valueType || valueType.kind === "externref") return;
  if (valueType.kind === "ref" || valueType.kind === "ref_null") {
    fctx.body.push({ op: "extern.convert_any" } as Instr);
  }
}

export function emitBuiltinNamespaceObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  builtinName: string,
): ValType | null {
  const props = SUPPORTED_STATIC_PROPS.get(builtinName);
  if (!props) return null;

  ensureObjectRuntime(ctx);
  const newObjectIdx = ctx.funcMap.get("__new_plain_object")!;
  const setIdx = ctx.funcMap.get("__extern_set")!;

  let globalIdx = ctx.builtinObjectGlobals.get(builtinName);
  if (globalIdx === undefined) {
    globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: `__builtin_${builtinName}`,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.builtinObjectGlobals.set(builtinName, globalIdx);
  }

  const objLocal = allocLocal(fctx, `__builtin_${builtinName}_obj_${fctx.locals.length}`, { kind: "externref" });
  const initBody: Instr[] = [
    { op: "call", funcIdx: newObjectIdx },
    { op: "local.set", index: objLocal },
  ];

  const savedBody = fctx.body;
  fctx.body = initBody;
  // (#2182) `savedBody` is the outer body, detached for the duration of the
  // swap. `emitBuiltinStaticMethodValue` below can trigger a late import (e.g.
  // a host builtin), and `shiftLateImportIndices` only walks `fctx.body` (=
  // initBody here) plus the registered body sets — NOT this raw local. Register
  // it in `liveBodies` so any `call` funcIdx already accumulated in the outer
  // body is shifted too; otherwise a late import here would over-shift it.
  ctx.liveBodies.add(savedBody);
  try {
    for (const prop of props) {
      fctx.body.push({ op: "local.get", index: objLocal });
      addStringConstantGlobal(ctx, prop);
      fctx.body.push(...stringConstantExternrefInstrs(ctx, prop));
      const valueType = emitBuiltinStaticMethodValue(ctx, fctx, builtinName, prop);
      coerceTopToExternref(fctx, valueType);
      fctx.body.push({ op: "call", funcIdx: setIdx });
    }
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "global.set", index: globalIdx });
  } finally {
    fctx.body = savedBody;
    ctx.liveBodies.delete(savedBody);
  }

  fctx.body.push({ op: "global.get", index: globalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: initBody, else: [] });
  fctx.body.push({ op: "global.get", index: globalIdx });
  return { kind: "externref" };
}
