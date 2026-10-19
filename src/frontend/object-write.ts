// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ts } from "../ts-api.js";
import type { IrFunctionBuilder } from "../ir/builder.js";
import type { IrValueId } from "../ir/core/nodes.js";
import { sourcePropertyWriteFailure } from "./source-strictness.js";

/** Carry the lexical source rule into neutral IR before the AST is discarded. */
export function emitSourceObjectSet(
  context: { readonly builder: IrFunctionBuilder; readonly resolver?: { inferModuleStrict?(): boolean } },
  receiver: IrValueId,
  name: string,
  value: IrValueId,
  cause: ts.Node,
): void {
  context.builder.emitObjectSet(
    receiver,
    name,
    value,
    sourcePropertyWriteFailure(cause, context.resolver?.inferModuleStrict?.()),
  );
}
