// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";

const cache = new WeakMap<ts.Node, boolean>();
// (#2119) Separate cache for the inferModuleStrict=false path so the two
// strictness modes do not clobber each other's memoized result.
const cacheNoModule = new WeakMap<ts.Node, boolean>();

/** True when the prologue of `body` opens with a `"use strict"` directive. */
function hasUseStrictPrologue(statements: readonly ts.Statement[]): boolean {
  for (const s of statements) {
    // A Directive Prologue is a leading run of ExpressionStatements whose
    // expression is a string literal. The first non-directive statement ends it.
    if (ts.isExpressionStatement(s) && ts.isStringLiteralLike(s.expression)) {
      if (s.expression.text === "use strict") return true;
      continue;
    }
    break;
  }
  return false;
}

/**
 * Decide whether `fn`'s body is strict-mode code (ECMA-262 §11.2.2).
 *
 * Strict applies when any of these hold:
 *  - the function body itself opens with a `"use strict"` directive,
 *  - an enclosing function body or the SourceFile opens with `"use strict"`,
 *  - the function is a class element or lives anywhere inside a class
 *    (ClassDeclaration / ClassExpression bodies are always strict).
 *
 * ES-module strictness (§11.2.2: Module code is always strict) IS inferred when
 * `inferModuleStrict` is true (the default) — from the **genuine** module signal
 * `externalModuleIndicator` (set by TypeScript when the source has a top-level
 * `import`/`export`), or an ESM `impliedNodeFormat`. Real module input (TS/ES
 * modules — the product's actual input) thus gets an unmapped `arguments`
 * object (#2119).
 *
 * CAVEAT — the synthetic test wrapper. The test262 harness's `wrapTest` injects
 * a top-level `export function test()` entry point, which makes TypeScript flag
 * *every* wrapped source as a module (`externalModuleIndicator` is set even for
 * a sloppy `noStrict` script). Inferring module-strictness from that synthetic
 * export would wrongly unmap `arguments` for the 14 `language/arguments-object/
 * mapped/*` (and async/yield `noStrict`) tests that assert *mapped* behaviour.
 * So the harness passes `inferModuleStrict=false` for non-module-goal (script)
 * tests, and leaves it true for genuine module tests. With the flag false this
 * function ignores the module signal and the source's true sloppy strictness is
 * honoured. `"use strict"` prologues and class context still force strict.
 *
 * This drives the mapped-vs-unmapped `arguments` split: strict functions get
 * an *unmapped* arguments object, so writes to `arguments[i]` must not flow
 * back into the named parameter (#779e).
 */
export function isStrictFunction(
  fn: ts.FunctionLikeDeclaration,
  // (#2119) When false, do NOT infer module-strictness from a top-level
  // import/export. The test262 harness passes false for script tests so its
  // synthetic `export function test()` wrapper does not unmap sloppy
  // (`noStrict`) `arguments`. An explicit `"use strict"` prologue or class
  // context still forces strict regardless. Defaults to true (module input is
  // strict per the spec). The cache is keyed per-flag so both modes coexist.
  inferModuleStrict = true,
): boolean {
  const flagCache = inferModuleStrict ? cache : cacheNoModule;
  const cached = flagCache.get(fn);
  if (cached !== undefined) return cached;

  let result = false;

  // 1. The function's own directive prologue.
  if (fn.body && ts.isBlock(fn.body) && hasUseStrictPrologue(fn.body.statements)) {
    result = true;
  }

  // 2. Walk enclosing scopes for a class context or an outer "use strict".
  if (!result) {
    for (let node: ts.Node | undefined = fn.parent; node; node = node.parent) {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        result = true;
        break;
      }
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
        if (node.body && ts.isBlock(node.body) && hasUseStrictPrologue(node.body.statements)) {
          result = true;
          break;
        }
      }
      if (ts.isSourceFile(node)) {
        // (#2119) Module code is always strict. Key only on the genuine module
        // signal (a real top-level import/export, or ESM impliedNodeFormat) —
        // NOT scriptKind — so test262 sloppy `.js` cases compiled as `test.ts`
        // (no import/export) stay sloppy/mapped.
        if (hasUseStrictPrologue(node.statements) || (inferModuleStrict && isModuleSourceFile(node))) {
          result = true;
        }
        break;
      }
    }
  }

  flagCache.set(fn, result);
  return result;
}

/**
 * (#2119) True iff `sf` is genuine module code — it carries a top-level
 * `import`/`export` (TypeScript sets the internal `externalModuleIndicator`),
 * or its implied node format is ESM. Deliberately ignores `scriptKind`: a
 * sloppy `.js` source compiled under a `.ts` filename has `scriptKind: TS` but
 * no module markers, and must stay sloppy.
 */
function isModuleSourceFile(sf: ts.SourceFile): boolean {
  const internal = sf as ts.SourceFile & { externalModuleIndicator?: ts.Node };
  if (internal.externalModuleIndicator !== undefined) return true;
  if (sf.impliedNodeFormat === ts.ModuleKind.ESNext) return true;
  return false;
}
