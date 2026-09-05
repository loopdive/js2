// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5324) A lifted frame's hoisted function declarations are lexically its own.
//
// `nestedFuncDeclNeedsShadow` / `shadowNestedFuncName` (#4456) deliberately
// shadow an outer same-named registration when a frame hoists its own
// `function f`, so the nested declaration gets its own Wasm slot instead of
// aliasing the outer's. The shadow is undone by `endNestedFunctionNameScope`,
// and `compileFunctionBody` opens a matching scope around every
// FunctionDeclaration body.
//
// A LIFTED frame — an arrow or function expression compiled through
// `compileLiftedClosureBody` → `prepareLiftedFrameDeclarations` →
// `hoistFunctionDeclarations` — took the shadow and NEVER popped it, so
// `ctx.funcMap` / `ctx.funcMapOwnerDecl` stayed bound to that frame's private
// function for the rest of the compile. Two measured consequences:
//
//  1. After the frame closes, an outer `f(...)` call in a DIFFERENT frame
//     resolves to the frame-local function (`pick(1, 2)` returned the inner
//     `pick(x)`'s result).
//
//  2. In a MULTI-SOURCE graph the driver compiles the accumulated
//     `__module_init` during the FIRST source's pass — before the entry
//     source's own top-level bodies. `compileDeclarations` then resolves the
//     top-level `function f`'s slot through `funcByName`, which is name-keyed
//     on both of its channels (a last-wins `ctx.mod.functions` scan by
//     `fn.name`, and the #4133 `ctx.funcMap` override), and both point at the
//     hijacker. The outer body is emitted into the nested function; when the
//     arities differ the emitted `local.get <n>` exceeds the nested signature
//     and codegen reports `stack-balance invariant (entry)`. That is a
//     whole-module compile failure (redux `applyMiddleware.spec.ts`, 0/5).
//
// Kept in its own module rather than inline so `compileLiftedClosureBody` — a
// budgeted god-function — gains two call sites instead of the rationale.

import type { CodegenContext } from "../context/types.js";
import {
  beginNestedFunctionNameScope,
  endNestedFunctionNameScope,
  type NestedFunctionNameScope,
} from "../nested-function-name-scope.js";

/**
 * Open the name scope for one lifted frame body. Cheap (an integer read), so it
 * is safe to call unconditionally — a frame that shadows nothing pops nothing.
 *
 * Must be called BEFORE the frame hoists its declarations, and paired with
 * {@link closeLiftedFrameNameScope} at every exit from the body compile.
 */
export function openLiftedFrameNameScope(ctx: CodegenContext): NestedFunctionNameScope {
  return beginNestedFunctionNameScope(ctx);
}

/** Restore every registration the lifted frame shadowed. See the module note. */
export function closeLiftedFrameNameScope(ctx: CodegenContext, scope: NestedFunctionNameScope): void {
  endNestedFunctionNameScope(ctx, scope);
}
