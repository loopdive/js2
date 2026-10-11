// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4526) The consumer-side twin of `objectLiteralForcesHostPath`'s
// runtime-computed-key arm.
//
// A literal such as
//
//     return { subscribe(o) { … }, [$$observable]() { return this; } };
//
// whose computed key is not statically resolvable is built as an OPEN object
// (`_hasRuntimeComputedKey`): the key is only known when the literal runs. The
// checker types it as a MIXED shape, `{ subscribe(o): …; [x: number]: … }`,
// which `resolveWasmType` used to lower to a closed struct holding only
// `subscribe`. Every binding, parameter or return slot of that type then took a
// struct SNAPSHOT of the open object — and the runtime-keyed member vanished
// (Redux's `store[$$observable]()[$$observable]` read `undefined`).
//
// The literal's own type therefore resolves to externref in lockstep with the
// value side, so the open object flows dynamically end to end. Interfaces and
// declared mixed index types are untouched: only an anonymous object-literal
// type whose declaring literal really took the runtime-key path qualifies.

import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

/** `literals.ts`'s `_hasRuntimeComputedKey`, injected by the caller: importing
 *  it here would pull this leaf into the codegen import cycle (#6797). */
export type RuntimeComputedKeyProbe = (ctx: CodegenContext, expr: ts.ObjectLiteralExpression) => boolean;

export function typeIsRuntimeKeyedObjectLiteral(
  ctx: CodegenContext,
  tsType: ts.Type,
  hasRuntimeComputedKey: RuntimeComputedKeyProbe,
): boolean {
  const symbol = tsType.symbol;
  if (!symbol || (symbol.flags & ts.SymbolFlags.ObjectLiteral) === 0) return false;
  // The runtime key surfaces as an index signature (string or number, by the
  // checker's reading of the key expression's type).
  if (tsType.getStringIndexType() === undefined && tsType.getNumberIndexType() === undefined) return false;
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isObjectLiteralExpression(declaration) && hasRuntimeComputedKey(ctx, declaration)) return true;
  }
  return false;
}
