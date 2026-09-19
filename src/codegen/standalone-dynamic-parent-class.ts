// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// standalone-dynamic-parent-class.ts — (#6640, #5383 S64) `class S extends
// <linked-provider class>` under `--target standalone` / `wasi`.
//
// ## The defect
//
// `class-bodies.ts::collectClassDeclaration`'s heritage loop wires a real
// parent only for an `Identifier`/`ClassExpression` heritage that resolves to a
// LOCAL class declaration. A PROPERTY-ACCESS heritage into a linked provider
// namespace — `class AvoidGettersDate extends Temporal.PlainDate {}`, the shape
// every test262 `Temporal/*/compare/use-internal-slots.js` and
// `subclassing-ignored.js` row uses — fell into an arm that only marked
// `ctx.classDynamicUnresolvedHeritageSet` (#6623). The subclass compiled as a
// fully independent ROOT struct: `super(...)` never reached the provider's
// constructor (no internal slots), no inherited method/getter dispatch
// (`one.toString()` → `"[object Object]"`, `one.year` → `undefined`), and
// `one instanceof Temporal.PlainDate` was `false`. The JS-host lane has had the
// analogous capability since #4534 (`hasDynamicHostParent` /
// `__call_dynamic_class_parent_<N>`); standalone had NOTHING.
//
// ## The mechanism — `this` IS the parent-constructed object
//
// Such a class becomes EXTERNREF-BACKED (`ctx.classExternrefBackedSet`), the
// same representation `class Sub extends Error` already uses on this lane, and
// its `super(...)` (explicit, or the synthesized derived constructor) lowers to
// the EXISTING dynamic `__native_construct_<N>` driver (#3981) applied to the
// heritage EXPRESSION evaluated at runtime. That driver already has an arm for
// a provider-owned class value — it asks the peer's
// `__js2wasm_link_callable_kind` for [[Construct]] and forwards to
// `__js2wasm_link_construct` (#5383 S2f R12), which runs the provider's own
// `<Name>_new` (#5383 S2g). So `this` is not a consumer-side imitation of a
// provider instance: it IS the provider-minted struct, with the provider's
// internal fields installed by the provider's own constructor.
//
// Everything downstream then works by construction rather than by
// re-implementation: an inherited read or method call on that receiver misses
// the consumer's own ladder and reaches the established link `memberGet` /
// `methodCall` terminals, exactly as a direct `new NS.Base()` instance already
// did; and a value handed BACK to the provider (`Temporal.PlainDate.compare(one,
// two)`) brand-checks as a real instance because it is one.
//
// ## Deliberate scope, and what is NOT claimed
//
//  - PROPERTY/ELEMENT-ACCESS heritage only. An unresolved IDENTIFIER heritage
//    (`class MySubclass extends construct {}`, where `construct` is a function
//    PARAMETER — test262's `checkSubclassConstructorUndefined` shape) shares the
//    other arm with EVERY `extends <builtin>` spelling, whose representation is
//    already owned by `classBuiltinParentMap`. Widening there is a separate,
//    measurable change; it is recorded as the residual in #6640.
//  - LINK CONSUMERS only (`peerNamespaces(ctx)` non-empty). A standalone module
//    with no linked provider emits byte-identical output, which is what keeps
//    the whole non-linked corpus — including the provider modules themselves —
//    out of this change's blast radius.
//  - The subclass's OWN declared instance fields/methods are not installed on
//    the parent-minted object (the same bound `class Sub extends Error` has
//    carried since #1366a). `instanceof <the subclass itself>` and
//    `Object.getPrototypeOf(instance) === Sub.prototype` consequently answer
//    `false` where the root-struct representation answered `true`; both are
//    recorded in #6640, and neither is reachable without a heritage clause that
//    had no compiled meaning at all before this change.
import ts from "typescript";
import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { MAX_DYNAMIC_CONSTRUCT_ARITY, reserveNativeConstructDriver } from "./native-construct.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { isStandaloneLinkConsumer } from "./standalone-link-boundary.js";

/**
 * Is `baseExpr` a heritage expression this module can construct through the
 * link boundary?
 *
 * Property/element access only, and only in a standalone/WASI module that
 * actually consumes a wasm provider — see the scope note above.
 */
export function isLinkedDynamicParentHeritage(ctx: CodegenContext, baseExpr: ts.Expression): boolean {
  if (!ctx.standalone && !ctx.wasi) return false;
  if (!ts.isPropertyAccessExpression(baseExpr) && !ts.isElementAccessExpression(baseExpr)) return false;
  return isStandaloneLinkConsumer(ctx);
}

/**
 * Emit `self = __native_construct_<argCount>(<heritage value>, null, …args)`
 * and store it into `selfLocal`.
 *
 * `pushArgs` is the caller's argument emission (each callee-pushed value must
 * be an externref): the explicit-`super(...)` site compiles the argument
 * expressions, the synthesized derived constructor forwards its `__arg{i}`
 * parameters. Returns false — emitting nothing — when the driver cannot be
 * reserved, so the caller keeps its previous (null-instance) lowering rather
 * than producing a half-built body.
 */
export function emitLinkedDynamicParentConstruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
  argCount: number,
  pushArgs: () => void,
  compileHeritage: (expr: ts.Expression) => void,
): boolean {
  const heritage = ctx.classLinkedDynamicParentExpr.get(className);
  if (heritage === undefined || argCount > MAX_DYNAMIC_CONSTRUCT_ARITY) return false;
  const driverIdx = reserveNativeConstructDriver(ctx, argCount, stringConstantExternrefInstrs(ctx, "prototype"));
  if (driverIdx === undefined) return false;
  compileHeritage(heritage);
  // Null NewTarget-prototype: the driver's boundary arm lets the PROVIDER pick
  // the prototype its own constructor would, which is the whole point — a
  // consumer-side prototype would detach the instance from the provider's
  // method table.
  fctx.body.push({ op: "ref.null.extern" } as Instr);
  pushArgs();
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(`__native_construct_${argCount}`) ?? driverIdx });
  return true;
}
