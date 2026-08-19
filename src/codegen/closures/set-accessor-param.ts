// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * A SET ACCESSOR's parameter is a DYNAMIC boundary, whatever the checker says.
 *
 * The value arrives from `__extern_set` → `__call_accessor_set` →
 * `__call_fn_method_1` as a runtime `externref`, and that dispatcher coerces it
 * to the closure's declared parameter ValType with an UNGUARDED `ref.cast`.
 *
 * For an accessor PAIR the declared type is not something the author wrote:
 * TypeScript takes the property's type from the GETTER's return and requires the
 * setter's parameter to match it. So
 *
 * ```js
 * var o = { set foo(v) { … }, get foo() { return "G"; } };
 * o.foo = 1;      // `v` inferred `string` → ref.cast to $AnyString → trap
 * ```
 *
 * was an UNCATCHABLE `RuntimeError: illegal cast` on a plain ES5 object literal.
 *
 * Four controls, one module each, are what identify it rather than the stored
 * closures:
 *
 * | shape                                    | result |
 * | ---------------------------------------- | ------ |
 * | setter alone (`v` is `any`)              | works  |
 * | get + set on DIFFERENT names             | works  |
 * | same name, getter body is `return;`      | works  |
 * | same name, getter returns a value        | TRAPS  |
 *
 * and the descriptor readback is clean throughout —
 * `gOPD(o,"foo").get.length === 0`, `.set.length === 1` — so the `$PropEntry`
 * slots always held the right functions.
 *
 * Answering `externref` keeps that call boundary dynamic, which is the same rule
 * and the same reason as `computeClosureWrapperSig`'s unannotated-JS-default arm
 * and its unbound-declaration arm.
 */
import { ts } from "../../ts-api.js";

/** Is `arrow` a set accessor, whose parameters must stay `externref`? */
export function setAccessorParamIsDynamic(arrow: ts.ArrowFunction | ts.FunctionExpression): boolean {
  return ts.isSetAccessorDeclaration(arrow as unknown as ts.Node);
}

/** The dynamic parameter ValType a set accessor's formals take. */
export const EXTERNREF_PARAM = { kind: "externref" } as const;
