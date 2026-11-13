// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7335 (lever D) — what is left of the uses proof for #7280's dynamic-home
 * carrier: a member store into it is `dyn.member_set`, which is told its
 * writer's code strictness. (#7339) The own-property test arm this module also
 * held is the statics table's two test rows now (`object-statics.ts`), proved
 * per file instead of per binding.
 */

import { ts } from "../ts-api.js";

/** The write sits in `<module-init>` or a top-level function, the code whose strictness lowering is told. */
export function writerKnowsItsStrictness(node: ts.Node): boolean {
  const owner = ts.findAncestor(node.parent, ts.isFunctionLike);
  return owner === undefined || (ts.isFunctionDeclaration(owner) && ts.isSourceFile(owner.parent));
}
