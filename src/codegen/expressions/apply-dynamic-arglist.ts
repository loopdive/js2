// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4526) Two receiver/argument-list facts for identifier `.call`/`.apply`
// reflective calls (`calls.ts` Case 1 and the compiled-apply bridge arm).
//
// 1. `f.apply(thisArg, list)` where `list` is a RUNTIME value (an identifier,
//    a rest vector, `[...] as any`) has no static element count. The
//    direct-call arms below the bridge only spread an array LITERAL; every
//    other shape fell through to their "no args array" branch and called `f`
//    with ZERO arguments and no receiver. Redux's `bindActionCreator`
//    (`actionCreator.apply(this, args)`) is the canonical victim.
//
// 2. The bare-name registries (`funcMap`, `closureMap`) are graph-wide. A
//    parameter named `actionCreator` in one module must not be reinterpreted as
//    a same-named function DECLARATION nested inside another module's test
//    body. The direct-call path already scopes this (#4133/#4456,
//    `isOutOfScopeNestedBinding`); the reflective `.call`/`.apply` path read
//    the registries by name alone.

import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

/**
 * True when the graph-wide `funcMap`/`closureMap` entry for `name` belongs to a
 * function declaration other than the one this identifier actually binds.
 * `valueDeclaration` is the checker's binding for the read. Only a parameter,
 * binding element or variable can disown the entry: imports, declarations and
 * unknown bindings — and names with no recorded owning declaration — keep the
 * existing by-name lookup.
 */
export function mappedFunctionIsForeign(
  ctx: CodegenContext,
  name: string,
  valueDeclaration: ts.Declaration | undefined,
): boolean {
  const owner = ctx.funcMapOwnerDecl.get(name) ?? ctx.topLevelFunctionDeclarations.get(name);
  if (owner === undefined || valueDeclaration === undefined) return false;
  return (
    ts.isParameter(valueDeclaration) ||
    ts.isBindingElement(valueDeclaration) ||
    ts.isVariableDeclaration(valueDeclaration)
  );
}
