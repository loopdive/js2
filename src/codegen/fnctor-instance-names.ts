// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import type { FnctorEscapeGateResult } from "./fnctor-escape-gate.js";

const siteNamesByGate = new WeakMap<FnctorEscapeGateResult, ReadonlySet<string>>();

/**
 * (#1058) Is `name` a function constructor that some `new F()` site in the
 * program constructs?
 *
 * `resolveWasmType` routes a type named like a fnctor to the fnctor instance
 * representation, keyed by bare name. `funcConstructorMap` only learns a name
 * when codegen first reaches one of its `new` sites, so a same-named type
 * resolved earlier got a struct, and the same type resolved later got
 * externref. TypeScript's checker hits this: `interface NodeLinks` (types.ts)
 * and `function NodeLinks` (checker.ts, built by `new (NodeLinks as any)()`)
 * share a name, and a nested function reserved with a `NodeLinks` struct
 * parameter compiled against an externref one. The escape gate resolves every
 * `new` site before codegen, so asking it too makes the answer the same for
 * the whole compile.
 */
export function isConstructedFnctorName(ctx: CodegenContext, name: string): boolean {
  if (ctx.funcConstructorMap.has(name)) return true;
  const gate = ctx.fnctorEscapeGate;
  if (gate === undefined) return false;
  let names = siteNamesByGate.get(gate);
  if (names === undefined) {
    names = new Set([...gate.siteCtorName.values(), ...gate.ctorDeclByName.keys()]);
    siteNamesByGate.set(gate, names);
  }
  return names.has(name);
}

/**
 * (#6938) Is `tsType` the INSTANCE type of a function constructor ("fnctor")?
 *
 * True when the type's symbol names a constructed fnctor, or its value
 * declaration is a function declaration / function expression /
 * `var F = function () {}` — and the type is not itself callable (the function
 * VALUE type keeps its closure-wrapper resolution). Class names are excluded:
 * a class owns its struct.
 *
 * The checker's instance shape (ctor fields PLUS prototype methods) has no
 * subtype relation to the runtime `$__fnctor_<Name>` struct (#1712), so such a
 * type must never be lowered to — or registered as — a checker-shape struct.
 * `resolveWasmType` and `ensureStructForType` share this predicate so the
 * lowering and registration sites cannot drift apart.
 */
export function isFnctorInstanceType(ctx: CodegenContext, tsType: ts.Type): boolean {
  const sym = tsType.symbol;
  if (sym?.name !== undefined && ctx.classSet.has(sym.name)) return false;
  const fnDecl = sym?.valueDeclaration;
  const isFnCtorType =
    (sym?.name !== undefined && isConstructedFnctorName(ctx, sym.name)) ||
    (!!fnDecl &&
      (ts.isFunctionDeclaration(fnDecl) ||
        ts.isFunctionExpression(fnDecl) ||
        (ts.isVariableDeclaration(fnDecl) && !!fnDecl.initializer && ts.isFunctionExpression(fnDecl.initializer))));
  return isFnCtorType && tsType.getCallSignatures().length === 0;
}
