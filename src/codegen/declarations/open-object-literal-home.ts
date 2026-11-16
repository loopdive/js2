// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Where legacy and the IR keep an object literal open (`$Object`, built with
 * `__new_plain_object`) rather than as a closed struct. Legacy's widening
 * pre-pass asks `isStandaloneOpenObjectLiteral`; the selector reads the slot
 * that pass produced (`ir-open-object-binding.ts`), so the two never disagree.
 */

import { ts } from "../../ts-api.js";
import { openObjectLiteralFields } from "../../shared/object-literal-fields.js";
import type { CodegenContext } from "../context/types.js";

/**
 * The lane whose IR lowers an open carrier: standalone with the externref
 * dynamic carrier. The gc lane keeps declining until its own A/B lands.
 */
export function irOpenObjectCarrierAvailable(ctx: CodegenContext): boolean {
  return ctx.targetProfile.target === "standalone" && !ctx.fast;
}

/**
 * (#7352 O1) The home decision for a script `var` object literal: on the lane
 * above, a top-level script `var` initialised with a data-only literal
 * (`openObjectLiteralFields`) is the open `$Object`, not a closed struct.
 */
export function isStandaloneOpenObjectLiteral(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  const list = decl.parent;
  return (
    irOpenObjectCarrierAvailable(ctx) &&
    decl.initializer !== undefined &&
    openObjectLiteralFields(decl.initializer) !== null &&
    ts.isVariableDeclarationList(list) &&
    (list.flags & ts.NodeFlags.BlockScoped) === 0 &&
    ts.isVariableStatement(list.parent) &&
    ts.isSourceFile(list.parent.parent) &&
    !ts.isExternalModule(list.parent.parent)
  );
}
