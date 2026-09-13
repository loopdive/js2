// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5383 S2b) Make a user METHOD reachable on a standalone externref-backed
 * subclass instance through a DYNAMIC receiver.
 *
 * ## The gap (measured, 2026-09-08)
 *
 * `class B extends Array { d(i) { return this[i]; } }` under `--target
 * standalone`, `hostBridge: "off"`:
 *
 * | receiver spelling                        | `o.d(0)` |
 * | ---------------------------------------- | -------- |
 * | `var x = new B(1); x.d(0)`               | 5 — statically dispatched to `$B_d` |
 * | `function f(o) { return o.d(0); } f(b)`  | **null** |
 * | `new B(1).d(0)`                          | **null** |
 *
 * A statically-typed receiver compiles to a direct `call $B_d`. Anything the
 * checker cannot pin — a bare parameter, a call result of a union type — goes
 * out through the dynamic terminal (`__extern_method_call` / the
 * `__call_m_<name>` closed dispatcher), and those resolve a method by
 * INSTANCE IDENTITY: `ref.test` against each closed struct type, plus the open
 * `$Object` hash map. An externref-backed subclass instance is neither. Its
 * carrier is the parent's native value — a `$__vec_externref` for `extends
 * Array` — indistinguishable from a plain array, and the host lane's answer to
 * this (`__set_subclass_proto`, which installs `B.prototype` on the instance)
 * is a JS host import, so `emitSetSubclassProto` is a documented NO-OP on this
 * lane. There is nothing on the instance that says "B".
 *
 * The miss is SILENT — `null`, not a TypeError — which is why it survived: it
 * reads as a method that returned nothing. It is what stopped the standalone
 * `@js-temporal/polyfill` provider's `__module_init`: jsbi is
 * `class JSBI extends Array`, and its statics call methods on their
 * PARAMETERS (`static toNumber(i) { … i.__unsignedDigit(0) … }`). Every such
 * call answered `null`, so `JSBI.unaryMinus(x)` handed back `null` and the
 * next `JSBI.subtract(null, l)` threw `TypeError: Cannot access property on
 * null or undefined` — one null, five frames from where it was made.
 *
 * ## The fix, and why own properties rather than a prototype link
 *
 * At construction, install each declared instance method on the INSTANCE as an
 * own data property at §17 attributes (`{writable: true, enumerable: false,
 * configurable: true}`) — the same closure singleton, the same
 * `__defineProperty_value` native, and the same flags `class-proto-object.ts`
 * (#3976) uses for `C.prototype`. The dynamic terminals already consult the
 * carrier's own-property side table (#3537 vec bag / #3468 closure bag), so
 * every dynamic spelling starts resolving with `this` correctly bound.
 *
 * Three alternatives were MEASURED first, and each is a dead end today:
 *
 *   - **`Object.setPrototypeOf(instance, B.prototype)`** — one call per
 *     instance instead of N, and it would put the methods where the spec puts
 *     them. Probed: `Object.setPrototypeOf(a, p); a.m()` through a dynamic
 *     receiver answers `null` for a vec carrier. Standalone's dynamic member
 *     path does not consult an explicit `setPrototypeOf` link on a non-`$Object`
 *     carrier at all, so this fixes nothing until that link is honoured.
 *   - **`instance.__proto__ = B.prototype`** — same probe, same `null`.
 *   - **Leaning on `B.prototype` itself** — `emitStandaloneClassProtoObject`
 *     explicitly DECLINES for a class with a builtin parent, so `B.prototype`
 *     is still the legacy defaulted `$ClassName` struct here, not a real
 *     `$Object` the bag could inherit from.
 *
 * ## What this deliberately does NOT claim
 *
 * The methods become OWN properties of the instance, not inherited ones. So
 * `b.hasOwnProperty("d")` answers `true` where the spec says `false`, and
 * `delete b.d` removes it for that instance only. That is a real deviation and
 * it is the price of the carrier having no prototype channel; it is strictly
 * better than the status quo, where the method is not reachable at all. The
 * non-enumerable flag keeps the visible surface right for the two questions
 * that are actually asked — `Object.keys(b)` and `for (k in b)` still see only
 * the elements/fields (probed: `Object.keys` length unchanged). When the
 * standalone dynamic path learns to honour a carrier's prototype link, this
 * should be replaced by that link, not extended.
 *
 * ## Byte-neutrality
 *
 * Gated on `ctx.standalone || ctx.wasi` AND on the class being externref-backed
 * AND on it declaring at least one installable instance method. The JS-host /
 * `gc` lane never reaches here — it keeps `__set_subclass_proto`, which does
 * the equivalent job through the real prototype — and any standalone module
 * without such a class emits exactly its previous bytes.
 */
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { classMemberFuncKey } from "./class-member-keys.js";
import { emitClassMemberKeyOperand } from "./class-proto-accessors.js";
import { installableInstanceMethodNames, METHOD_FLAGS } from "./class-proto-object.js";
import { emitCachedMethodClosureAccess } from "./closures.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { externrefBackedOwnFieldBacking } from "./registry/error-types.js";

/**
 * Install `subName`'s declared instance methods as own data properties of the
 * instance held in `selfLocal` (an `externref` local). No-op — emitting
 * nothing at all — unless the standalone/WASI externref-backed shape above
 * applies.
 */
export function emitStandaloneSubclassMethodInstall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  selfLocal: number,
  subName: string,
): void {
  if (!(ctx.standalone || ctx.wasi)) return;
  if (!ctx.classExternrefBackedSet.has(subName)) return;
  // MEASURED exclusion, not a policy one: `__defineProperty_value` lands in the
  // #3537 vec bag / #3468 closure bag and on a native `$Object`, but NOT in an
  // `$Error_struct`'s `$props` side-slot, so an `extends Error` subclass gets
  // the installs and still answers "called value is not a function" on a
  // dynamic method call — 5.8 kB of machinery pulled into every such standalone
  // binary for no behaviour change. Skip it until the Error carrier's dynamic
  // member path reads `$props`, at which point deleting this line is the whole
  // fix.
  if (externrefBackedOwnFieldBacking(ctx, subName) === "error-struct") return;
  const methodNames = installableInstanceMethodNames(ctx, subName);
  if (methodNames.length === 0) return;
  const structTypeIdx = ctx.structMap.get(subName);
  if (structTypeIdx === undefined) return;
  ensureObjectRuntime(ctx);
  const defineIdx = ctx.funcMap.get("__defineProperty_value");
  if (defineIdx === undefined) return;

  // Everything below appends to `fctx.body` in receiver/key/value/flags order,
  // exactly as `emitStandaloneClassProtoObject` does for the prototype object.
  // A member whose key or closure singleton fails to materialize stops the
  // loop rather than leaving operands stranded on the stack.
  for (const name of methodNames) {
    const fullName = `${subName}_${name}`;
    const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName));
    if (funcIdx === undefined) break;
    fctx.body.push({ op: "local.get", index: selfLocal });
    if (!emitClassMemberKeyOperand(ctx, fctx, subName, name)) {
      fctx.body.push({ op: "drop" });
      break;
    }
    if (!emitCachedMethodClosureAccess(ctx, fctx, fullName, funcIdx, structTypeIdx)) {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
      break;
    }
    fctx.body.push({ op: "f64.const", value: METHOD_FLAGS });
    // `__defineProperty_value` returns the target; the install is for effect.
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__defineProperty_value") ?? defineIdx });
    fctx.body.push({ op: "drop" });
  }
}
