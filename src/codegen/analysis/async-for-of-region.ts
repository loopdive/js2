// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6847) Helpers for the async CFG `forOf` region (`lowerRegionBody` /
// `planTryCatchCfg` in async-cps.ts) — hono `parseSigned`'s shape:
//
//   for (const [key, value] of Object.entries(…)) {
//     if (bad) { continue; }
//     const ok = await verify(…);
//     out[key] = ok ? value : false;
//   }

// Leaf module on purpose: only `ts-api` and type imports, so it stays outside
// the codegen import cycle (#6797 ratchet).
import type { ts as TsNs } from "../../ts-api.js";
import { ts } from "../../ts-api.js";
import type { FunctionContext } from "../context/types.js";

function forEachBoundName(pattern: TsNs.BindingPattern, visit: (name: string) => void): void {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name)) visit(element.name.text);
    else forEachBoundName(element.name, visit);
  }
}

/**
 * `if (cond) continue;` / `if (cond) { continue; }` (unlabeled, no else) — the
 * guard-clause idiom. As a TOP-LEVEL statement of a for-of body it lowers to a
 * conditional whose false arm is the rest of the body, so the `continue` never
 * has to be compiled as a branch inside the resume machine: the conditional's
 * join IS the loop's increment state, which is exactly where `continue` goes.
 */
export function isLoopContinueGuard(stmt: TsNs.Statement): stmt is TsNs.IfStatement {
  if (!ts.isIfStatement(stmt) || stmt.elseStatement !== undefined) return false;
  const then = stmt.thenStatement;
  const only = ts.isBlock(then) ? (then.statements.length === 1 ? then.statements[0]! : undefined) : then;
  return only !== undefined && ts.isContinueStatement(only) && only.label === undefined;
}

/**
 * A destructuring head has just initialized every pattern name, and each
 * iteration re-binds before any body statement runs. Its TDZ flags are plain
 * resume-function locals that reset on every re-entry, so a read compiled
 * into a LATER state would throw "x is not defined" — drop them.
 */
export function releaseForOfHeadTdzFlags(fctx: FunctionContext, binding: TsNs.BindingPattern): void {
  forEachBoundName(binding, (name) => fctx.tdzFlagLocals?.delete(name));
}
