// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";

/** Preserve fixed-arity receiver-first call admission while scanning every argument. */
export function scanFixedDynamicMethodArguments(
  call: ts.CallExpression,
  expectsDynamic: boolean,
  arity: number,
  isDynamic: (expression: ts.Expression) => boolean,
  scan: (expression: ts.Expression, expectsDynamic: boolean) => boolean,
): boolean {
  if (!expectsDynamic || call.arguments.length !== arity) return false;
  for (const argument of call.arguments) {
    if (ts.isSpreadElement(argument) || !scan(argument, isDynamic(argument))) return false;
  }
  return true;
}
