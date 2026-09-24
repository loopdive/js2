// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#1058) `ctx.funcMap` is keyed by bare name, so two modules that each declare
// a top-level `function visitNodes` share one entry. #4133 re-binds each
// source's own slots before that source's bodies compile, but the graph-wide
// `__module_init` is compiled during only the first/last source's turn. A
// function expression in a module-level initializer therefore resolved its
// callees against another module's binding. The TypeScript parser's
// `forEachChildTable` is that shape: each `forEachChildInX` called
// visitorPublic's exported `visitNodes` instead of parser.ts's private one, so
// the binder never visited a child node.
//
// A direct call whose callee the checker resolves to a top-level function
// declaration binds `funcMap[name]` to that declaration's own slot for the
// duration of the call's compilation. Every name-keyed re-read inside the call
// path then sees the right function; the previous binding is restored after.

import type { ts as TsNs } from "../../ts-api.js";
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { sourceFunctionHandleForDeclaration } from "../program-abi-source-callable-planning.js";

export function withDeclarationBoundCallee<R>(ctx: CodegenContext, expr: TsNs.CallExpression, compile: () => R): R {
  const callee = expr.expression;
  if (!ts.isIdentifier(callee)) return compile();
  const current = ctx.funcMap.get(callee.text);
  if (current === undefined) return compile();
  const declaration = ctx.oracle.aliasedValueDeclarationOf(callee);
  if (declaration !== undefined && isForeignFunctionShadow(ctx, callee.text, declaration, current)) {
    return withWithheldForeignCallee(ctx, callee.text, current, compile);
  }
  if (
    declaration === undefined ||
    !ts.isFunctionDeclaration(declaration) ||
    declaration.body === undefined ||
    !ts.isSourceFile(declaration.parent)
  ) {
    return compile();
  }
  const own = sourceFunctionHandleForDeclaration(ctx, declaration);
  if (own === undefined || own === current) return compile();
  const name = callee.text;
  // The call-site inliner is keyed by the same bare name, so its entry holds
  // the OTHER module's body. Withhold it while rebound; the call stays direct.
  const inline = ctx.inlinableFunctions.get(name);
  ctx.inlinableFunctions.delete(name);
  ctx.funcMap.set(name, own);
  try {
    return compile();
  } finally {
    // A late-import batch during the call shifts every defined-function index
    // by the same amount; carry that shift onto the restored binding.
    const shifted = ctx.funcMap.get(name);
    ctx.funcMap.set(name, current + (shifted === undefined ? 0 : shifted - own));
    if (inline !== undefined) ctx.inlinableFunctions.set(name, inline);
  }
}

// (#6669) The inverse collision: the callee resolves to a module-level
// VARIABLE (`const oe = Object.getPrototypeOf` in styled-components) while
// `funcMap[name]` holds ANOTHER module's top-level `function oe` (stylis). No
// declaration of this name is a function in the calling module, so #4133's
// per-source re-binding never touches it, and the call compiled as a direct
// `call $oe` to stylis's 4-arg (lifted 11-param) body — a wasm-opt
// "call param types must match" error in styled-components' hoist-statics
// helper. Proven foreign only when the funcMap handle belongs to a source
// FunctionDeclaration in a DIFFERENT file and the variable has module storage
// holding its real value; an Identifier initializer may be a genuine alias of
// that function, so it keeps the historical direct call.
function isForeignFunctionShadow(
  ctx: CodegenContext,
  name: string,
  declaration: TsNs.Declaration,
  current: number,
): boolean {
  if (!ts.isVariableDeclaration(declaration)) return false;
  if (declaration.initializer !== undefined && ts.isIdentifier(declaration.initializer)) return false;
  const statement = declaration.parent?.parent;
  if (statement === undefined || !ts.isVariableStatement(statement) || !ts.isSourceFile(statement.parent)) return false;
  if (!ctx.moduleGlobals.has(name)) return false;
  const owner = ctx.sourceFunctionDeclarationByHandle.get(current);
  return owner !== undefined && owner.getSourceFile() !== statement.parent;
}

function withWithheldForeignCallee<R>(ctx: CodegenContext, name: string, current: number, compile: () => R): R {
  // Source-function handles are stable-regime ids (#1916 S3) that no late
  // import shifts, so restoring the exact value is sound.
  const inline = ctx.inlinableFunctions.get(name);
  ctx.inlinableFunctions.delete(name);
  ctx.funcMap.delete(name);
  try {
    return compile();
  } finally {
    ctx.funcMap.set(name, current);
    if (inline !== undefined) ctx.inlinableFunctions.set(name, inline);
  }
}
