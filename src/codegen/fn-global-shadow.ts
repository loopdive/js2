// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4630) `globalThis.<fn> = …` must SHADOW a top-level function declaration
 * for subsequent bare reads and calls.
 *
 * Per §9.1.1.4 / §16.1.7, a script's top-level `function F(){}` IS a property
 * of the global object, so `globalThis.F = replacement` rebinds what a bare
 * `F` resolves to. Standalone, the write landed on the native globalThis
 * `$Object` singleton while bare `F` reads kept the static compiled binding —
 * the two never aliased. The test262 asyncHelpers self-test family is exactly
 * this shape (`globalThis.$DONE = function (x) {…}` then the harness's own
 * `$DONE(error)` calls), so every reassignment was silently ignored and the
 * original `$DONE` printed the async verdict.
 *
 * Mechanism — an "override slot" per shadowed name:
 *  - a PRE-SCAN collects every name assigned via `globalThis.<name> =` /
 *    `globalThis["<name>"] =` that is also a top-level function declaration;
 *  - the WRITE arm (assignment.ts) additionally copies the just-written
 *    property value from the singleton into a mutable externref module global
 *    (the slot);
 *  - bare READS compile to `slot ?? <static closure>`;
 *  - bare CALLS compile to `__apply_closure(slot ?? <static closure>, null,
 *    argsVec)`.
 * A never-reassigned module keeps every static lowering byte-identical: the
 * arms fire only for scanned names, and the scan is empty for ordinary code.
 * State lives in module-local WeakMaps so no CodegenContext shape change is
 * needed.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

const shadowNamesByCtx = new WeakMap<CodegenContext, Set<string>>();
const slotsByCtx = new WeakMap<CodegenContext, Map<string, number>>();
let readSuppression = 0;

/** Collect `globalThis.<name> =` assignment targets in `sourceFile` into ctx state (additive across sources). */
export function scanGlobalThisFnShadows(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  if (!(ctx.standalone || ctx.wasi)) return;
  let names = shadowNamesByCtx.get(ctx);
  const walk = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
    ) {
      const recv = ts.isPropertyAccessExpression(node.left) ? node.left.expression : node.left.expression;
      if (ts.isIdentifier(recv) && recv.text === "globalThis") {
        let prop: string | undefined;
        if (ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.name)) prop = node.left.name.text;
        else if (ts.isElementAccessExpression(node.left) && ts.isStringLiteral(node.left.argumentExpression)) {
          prop = node.left.argumentExpression.text;
        }
        if (prop !== undefined) {
          if (!names) {
            names = new Set();
            shadowNamesByCtx.set(ctx, names);
          }
          names.add(prop);
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
}

/** Is `name` a scanned `globalThis.<name> =` target that also names a top-level function? */
export function isShadowedTopLevelFn(ctx: CodegenContext, name: string): boolean {
  if (readSuppression > 0) return false;
  const names = shadowNamesByCtx.get(ctx);
  return names !== undefined && names.has(name) && ctx.topLevelFunctionNames.has(name) && ctx.funcMap.has(name);
}

/** Get-or-mint the mutable externref override slot for `name`. */
export function fnShadowSlot(ctx: CodegenContext, name: string): number {
  let slots = slotsByCtx.get(ctx);
  if (!slots) {
    slots = new Map();
    slotsByCtx.set(ctx, slots);
  }
  const existing = slots.get(name);
  if (existing !== undefined) return existing;
  const idx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: `__fnshadow_${name}`,
    type: { kind: "externref" },
    mutable: true,
    init: [{ op: "ref.null.extern" }],
  });
  slots.set(name, idx);
  return idx;
}

/** Run `emit` with the shadow READ arm suppressed (for compiling the static fallback). */
export function withShadowReadSuppressed<T>(emit: () => T): T {
  readSuppression++;
  try {
    return emit();
  } finally {
    readSuppression--;
  }
}
