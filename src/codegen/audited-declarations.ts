// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { compileDeclarations as compileDeclarationsImpl } from "./declarations.js";

/** Record the physical direct-declaration route before any declaration preflight can return. */
export function compileDeclarations(
  ...args: Parameters<typeof compileDeclarationsImpl>
): ReturnType<typeof compileDeclarationsImpl> {
  const [ctx, sourceFile] = args;
  ctx.irBodyRouteAuditSession?.recordRoot("compileDeclarations", sourceFile.fileName, sourceFile);
  return compileDeclarationsImpl(...args);
}
