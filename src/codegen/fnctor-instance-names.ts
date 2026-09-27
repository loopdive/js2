// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
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
