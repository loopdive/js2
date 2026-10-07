// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// async-frame-binding-continuity.ts — bindings whose storage the async-frame
// spill analysis does not see, kept alive across suspensions (#4618).
//
// The `$AsyncFrame` spill set is computed from params and var/let/const/catch
// bindings; every resume-function local starts fresh on each re-entry. Two
// binding storages fall outside that model and were silently lost across an
// `await`, both reduced from React's own `await act(...)` unit tests:
//
//  1. a binding the function-body hoist already CELL-BOXED before activation
//     (a function declaration hoisted inside a block captures it);
//  2. the local a SCOPED (name-colliding) class declaration binds its class
//     value to.

import { forEachChild, ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import { isNestedFunctionScope } from "./async-cps-ast.js";
import { getLocalType } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

/**
 * (1) The frame spill field type for `name` when the activating function has
 * already cell-boxed it, or `undefined`. The caller initializes the field from
 * that live cell at frame construction: a default (null) cell field silently
 * dropped every write (`React = require('react')` inside the harness's
 * `try { … }`), and the hoisted component read `null`.
 */
export function liveBoxedCaptureSpillType(
  activatingFctx: FunctionContext | undefined,
  name: string,
  liveType: ValType | undefined,
): ValType | undefined {
  if (activatingFctx?.boxedCaptures?.has(name) !== true || liveType === undefined) return undefined;
  if (liveType.kind !== "ref" && liveType.kind !== "ref_null") return undefined;
  return { kind: "ref_null", typeIdx: liveType.typeIdx };
}

/**
 * (2) A nested `class Foo {}` whose name collides with a class in another
 * scope is compiled under a per-site synthetic identity, and its statement
 * binds the class VALUE to a same-named LOCAL (statements.ts, the
 * ClassDeclaration arm). Inside a resume function that local is written by the
 * state that runs the declaration and read as a fresh (null) local by every
 * later state: React's lifted tests each declare `class Component`, and the
 * second one's `root.render(createElement(Component))` after an `await act()`
 * handed ReactDOM a null element type (React error #130).
 *
 * The bound value is the class's singleton class-object GLOBAL, which survives
 * suspension by construction, so the resume prologue re-reads it into the
 * local on every entry. Before the declaration has run the global is still
 * null — the value the fresh local held — so no state observes a value a
 * straight-line execution would not.
 */
export function emitScopedClassLocalRebinds(
  ctx: CodegenContext,
  resumeFctx: FunctionContext,
  decl: ts.FunctionLikeDeclaration | undefined,
): void {
  const body = decl?.body;
  if (body === undefined) return;
  const visit = (node: ts.Node): void => {
    if (isNestedFunctionScope(node)) return;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const scoped = ts.isClassDeclaration(node) && node.name ? ctx.anonClassExprNames.get(node) : undefined;
      const globalIdx = scoped === undefined ? undefined : ctx.classObjectGlobals?.get(scoped);
      const localIdx = node.name === undefined ? undefined : resumeFctx.localMap.get(node.name.text);
      if (
        globalIdx !== undefined &&
        localIdx !== undefined &&
        getLocalType(resumeFctx, localIdx)?.kind === "externref"
      ) {
        resumeFctx.body.push({ op: "global.get", index: globalIdx });
        resumeFctx.body.push({ op: "local.set", index: localIdx });
      }
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(body, visit);
}
