// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The constructor names an `$Error_struct` can carry: the builtin Error constructors and the user-declared ones
 * lowered to the same struct. A leaf module (types only), so a reader of the struct (`exn-render-kind.ts`) asks it
 * without joining `error-types.ts`'s import cycle.
 */
import type { CodegenContext } from "../context/types.js";

/**
 * The 8 built-in JS Error constructors that Phase 1 supports as Wasm-native
 * struct construction in WASI mode. Order matches the order in which test262
 * tests typically reference them.
 */
export const WASI_ERROR_NAMES = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  "AggregateError",
] as const;

export type WasiErrorName = (typeof WASI_ERROR_NAMES)[number];

/**
 * (#3614) User-declared constructors that this compiler lowers to an
 * `$Error_struct` (rather than to a plain fnctor instance), and whose
 * `.constructor` back-pointer must therefore be answered by the
 * `$Error_struct` reader in `fillExternGetErrorProps`.
 *
 * Today this is exactly `Test262Error` — `emitStandaloneTest262Error` (#2902)
 * is the only non-builtin `__new_<Name>` an `$Error_struct` is minted for. It
 * is a list rather than a literal so a future `$Error_struct`-lowered user
 * constructor only has to be added here.
 */
const USER_ERROR_CTOR_IDENTITY_NAMES = ["Test262Error"] as const;

/**
 * Does `fillExternGetErrorProps` build the `constructor` arm for user error
 * constructor `name`? When this module mints `$Error_struct` instances for it
 * — and (#6723 D4) always in a wasm-consumed standalone PROVIDER, which must
 * also answer for instances its CONSUMER minted: the linked consumer lowers
 * `new Test262Error(…)` to its own `$Error_struct` (a canonical type, so this
 * arm sees it), and the provider's function value is the constructor both
 * modules name.
 */
function userErrorCtorArmApplies(ctx: CodegenContext, name: string): boolean {
  return ctx.funcMap.has(`__new_${name}`) || ctx.exportsConsumedByWasm === true;
}

/** The user error constructors whose instances this module reads as `$Error_struct`s (`userErrorCtorArmApplies`). */
export function userErrorCtorNames(ctx: CodegenContext): string[] {
  return USER_ERROR_CTOR_IDENTITY_NAMES.filter((name) => userErrorCtorArmApplies(ctx, name));
}
