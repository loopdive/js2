// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrTerminator, IrValueId } from "./nodes.js";

/** Canonical SSA operands at a control-flow exit. */
export function collectTerminatorUses(t: IrTerminator): readonly IrValueId[] {
  switch (t.kind) {
    case "return":
      return t.values;
    case "br":
      return t.branch.args;
    case "br_if":
      return [t.condition, ...t.ifTrue.args, ...t.ifFalse.args];
    case "unreachable":
      return [];
  }
}
