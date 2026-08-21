// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { compileFunctionBody as compileFunctionBodyImpl } from "./function-body.js";

export { dumpFrameBreach, registerInlinableFunction } from "./function-body.js";

/** Record entry before signature resolution, poison guards, or any other direct-body preflight. */
export function compileFunctionBody(
  ...args: Parameters<typeof compileFunctionBodyImpl>
): ReturnType<typeof compileFunctionBodyImpl> {
  const [ctx, declaration, func] = args;
  ctx.irBodyRouteAuditSession?.recordRoot("compileFunctionBody", func.name, declaration);
  return compileFunctionBodyImpl(...args);
}
