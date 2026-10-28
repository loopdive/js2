// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7128 S1) Legacy's answer for the IR open-object carrier: does legacy keep a
 * `var <id> = {}` binding as an open `$Object`? The selector asks rather than
 * re-deriving it, so an IR unit and a legacy unit can never disagree on the
 * binding's store.
 */

import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { resolveSpillLocalValType } from "./statements/variables.js";
import { widenedVarKeyFromDecl } from "./widened-var-key.js";

/**
 * The lane whose IR lowers an open carrier: standalone with the externref
 * dynamic carrier. The gc lane keeps declining until its own A/B lands.
 */
function irOpenObjectCarrierAvailable(ctx: CodegenContext): boolean {
  return ctx.targetProfile.target === "standalone" && !ctx.fast;
}

/** An externref slot whose `{}` legacy builds with `__new_plain_object` — no widened struct. */
function irOpenObjectBinding(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(decl.name)) return false;
  const key = widenedVarKeyFromDecl(decl.name);
  return (
    !ctx.widenedTypeProperties.has(key) &&
    !ctx.widenedVarStructMap.has(key) &&
    resolveSpillLocalValType(ctx, decl)?.kind === "externref"
  );
}

/** The selector's `isOpenObjectBinding` option: present only where the IR lowers an open carrier. */
export function irOpenObjectSelectionOption(ctx: CodegenContext): {
  readonly isOpenObjectBinding?: (decl: ts.VariableDeclaration) => boolean;
} {
  return irOpenObjectCarrierAvailable(ctx) ? { isOpenObjectBinding: (decl) => irOpenObjectBinding(ctx, decl) } : {};
}
