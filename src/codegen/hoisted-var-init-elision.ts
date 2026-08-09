// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Target-aware gate for omitting a hoisted externref var's entry undefined.
 *
 * The checker proof covers only source reads. Standalone/WASI retain their
 * explicit undefined representation, and a later concrete-ref retype cannot
 * accept the externref local's default null under every runtime regime.
 */
import type { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { hoistedVarRetypesToConcreteRef } from "./statements/variables.js";

export function canElideHoistedVarUndefined(ctx: CodegenContext, declaration: ts.VariableDeclaration): boolean {
  return (
    process.env.JS2WASM_ELIDE_DEAD_VAR_UNDEFINED !== "0" &&
    !ctx.standalone &&
    !ctx.wasi &&
    ctx.varInitElision.canElideUndefinedInit(declaration) &&
    !hoistedVarRetypesToConcreteRef(ctx, declaration)
  );
}
