// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2984 slice "ctor-carrier own props") Seed the standalone reified
 * builtin-CONSTRUCTOR carrier object with its §17/§20 own data properties
 * (`length`, `name`, `prototype`).
 *
 * ## Why this exists — the measured gap
 *
 * test262's `propertyHelper.js verifyProperty(obj, key, desc)` receives its
 * receiver as an **untyped harness parameter**, so EVERY descriptor query it
 * makes is a RUNTIME one: `Function.prototype.call.bind(Object.prototype.
 * hasOwnProperty)(obj, key)`, `Object.getOwnPropertyDescriptor(obj, key)`,
 * `for (k in obj)`, `obj[key] = …`, `delete obj[key]`. None of the compiler's
 * SYNTACTIC builtin-descriptor synthesis (#2984 Phase 2/3,
 * `builtin-static-gopd.ts`) can fire there — those all key on a
 * compile-time-resolvable receiver expression.
 *
 * Measured on `origin/main` @ `bb5b414a05b6d0` (standalone lane, real
 * `runTest262File`) through a `function ho(a,b){return Object.prototype.
 * hasOwnProperty.call(a,b);}` any-param indirection:
 *
 * | receiver kind                                                      | `ho(X,k)` | why                                      |
 * | ------------------------------------------------------------------ | --------- | ---------------------------------------- |
 * | native METHOD/STATIC closure (`Math.abs`, `Array.prototype.flat`)  | **true**  | #2896 `__builtinfn_*` reflective natives |
 * | builtin CTOR (`WeakMap`, `Map`, `RangeError`)                      | false     | carrier is an EMPTY `$Object`            |
 * | native proto (`Date.prototype`)                                    | false     | `$NativeProto`, not `$Object`            |
 * | plain object literal                                               | false     | lowers to a typed struct                 |
 *
 * The ctor row is the one this module closes, and it is the CHEAP one: #3006 /
 * #2907 already give every ctor in scope a genuine, identity-stable **`$Object`
 * carrier** (`emitBuiltinConstructorIdentity` / `emitBuiltinNamespaceObject`).
 * The `$Object` runtime ALREADY honours per-property attributes on every
 * dynamic path — probe-verified on main with a `Object.defineProperty(Math,
 * "zz", {value:1,writable:false,enumerable:false,configurable:true})` witness:
 * runtime `hasOwnProperty` true, runtime gOPD returns the full correct triple,
 * `for-in` skips it, a non-writable write does not stick, and `verifyProperty`
 * passes end-to-end for both `configurable:true` and `configurable:false`. So
 * the carriers were simply EMPTY; nothing about the MOP itself was missing.
 *
 * We therefore install the three spec own data properties at carrier
 * materialization time via the existing native `__defineProperty_value`,
 * exactly as `emitGeneratorPrototypeSingleton` (#3236 S1, array-object-proto.ts)
 * installs `next`/`return`/`throw` on `%GeneratorPrototype%`.
 *
 * ## Attributes (ECMA-262)
 *
 * - `length` — §20.2.4.1 `{ [[Writable]]: false, [[Enumerable]]: false,
 *   [[Configurable]]: true }`, value = the ctor's declared arity.
 * - `name` — §20.2.4.2, same attributes, value = the ctor's name string.
 * - `prototype` — §20.x per-ctor `{ [[Writable]]: false, [[Enumerable]]: false,
 *   [[Configurable]]: false }`, value = the `$NativeProto` object, i.e. the
 *   SAME value the syntactic `<Ctor>.prototype` read yields
 *   (`emitLazyNativeProtoGet`), so descriptor-vs-read identity holds.
 *
 * Insert order is spec own-key order for a function object (`length`, `name`,
 * `prototype`), so `Object.getOwnPropertyNames(<Ctor>)` reports them in the
 * conforming order.
 *
 * ## Scope / safety
 *
 * - **Standalone only.** Every call site is already `ctx.standalone`-gated and
 *   this module re-checks; gc/wasi emits stay byte-identical.
 * - **Additive only.** The carriers had ZERO own properties before, so no
 *   previously-observable read changes: a dynamic `X["name"]` went from
 *   `undefined` to the spec value, `Object.keys(X)` stays `[]` (all three are
 *   non-enumerable), and every SYNTACTIC `X.name` / `X.length` / `X.prototype`
 *   read is intercepted upstream by the existing compile-time folds and never
 *   reaches the carrier.
 * - Ctors with no `$NativeProto` brand simply skip `prototype` (the other two
 *   still land) — declining is always safe.
 */
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { withSpeculativeCompile } from "./context/speculative.js";
import { BUILTIN_CTOR_ARITY, NUMBER_CONSTANT_VALUES, tryEnsureNativeProtoBrand } from "./builtin-value-read.js";
import { ensureStandaloneBuiltinStaticMethodClosure } from "./property-access.js";
import { pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import { pushMarkBuiltinCarrierCallable } from "./builtin-callable-brand.js";
import { emitLazyNativeProtoGet } from "./native-proto.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

/**
 * Spec `length` for ctors that DO get a runtime carrier but are absent from the
 * shared `BUILTIN_CTOR_ARITY` table (which is keyed off `BUILTIN_CTOR_NAMES`).
 * Kept local rather than widening the shared table, because that table also
 * drives the `<Builtin>.length` / gOPD compile-time folds — widening it would
 * change reads outside this slice's measured set.
 */
const EXTRA_CTOR_ARITY: Record<string, number> = { AggregateError: 2 };

/**
 * Host descriptor-flag value bit decoded by `__defineProperty_value`
 * (bit 0 = writable, bit 1 = enumerable, bit 2 = configurable; omitted
 * attributes default to false per CompletePropertyDescriptor §6.2.6.4).
 */
const HOST_FLAG_CONFIGURABLE = 0x04;
const HOST_FLAG_WRITABLE = 0x01;

/**
 * (#4234) Per-ctor NUMERIC own data constants to seed alongside
 * `length`/`name`/`prototype`.
 *
 * `Number`'s eight §15.7.3 value constants are `{ [[Writable]]: false,
 * [[Enumerable]]: false, [[Configurable]]: false }` — flag word `0`, the same
 * encoding `prototype` already uses below.
 *
 * Values come from `NUMBER_CONSTANT_VALUES`, the SAME table the syntactic
 * `Number.MAX_VALUE` → `f64.const` fold and the reflective `Number["MAX_VALUE"]`
 * fold read (`builtin-value-read.ts`). Sharing it is the point: a descriptor
 * whose `value` disagreed with what the direct read returns would be worse than
 * no descriptor at all, and `verifyNotWritable` checks exactly that pair
 * (`gOPD(...).writable === false`, then `Number.MAX_VALUE` unchanged after a
 * write attempt).
 *
 * Deliberately Number-only for now. `Math`'s eight constants have identical
 * spec attributes (§15.8.1) and would seed through the same code, but `Math`
 * takes the namespace-carrier call site and is outside this slice's measured
 * set — see the issue's "Not done" section.
 */
const CTOR_NUMERIC_CONSTANTS: Record<string, Record<string, number>> = {
  Number: NUMBER_CONSTANT_VALUES,
};

/**
 * (#2875 wave-4 lane F) Per-ctor STATIC METHOD names to seed alongside
 * `length`/`name`/`prototype`, `{ [[Writable]]: true, [[Enumerable]]: false,
 * [[Configurable]]: true }` (§17 — the attributes every builtin function-valued
 * own property carries).
 *
 * `builtin-static-gopd.ts` already synthesizes exactly this descriptor for a
 * SYNTACTIC `gOPD(String, "fromCharCode")`, and measured on this branch's base
 * it answers `{value: <function>, w:true, e:false, c:true}` — but
 * `String.hasOwnProperty("fromCharCode")` answered **`false`** on the very same
 * build, because presence goes through the runtime carrier and the carrier had
 * only `length`/`name`/`prototype`. A descriptor that exists while
 * `hasOwnProperty` says the property does not is worse than either answer alone;
 * seeding closes that disagreement, and the value is the SAME per-(builtin,
 * method) singleton both the descriptor and a plain `String.fromCharCode` read
 * yield (`ensureStandaloneBuiltinStaticMethodClosure`).
 *
 * **String-only, deliberately.** Seeding materializes one singleton closure per
 * listed method at carrier-init time, so widening this to every entry of
 * `BUILTIN_STATIC_METHOD_ARITY` would pull in ~30 closures for `Math` and ~24
 * for `Object` on any module that merely mentions the identifier as a value —
 * the #4232 §5 cost-regression shape this file's header already warns about.
 * `String` has three, and is the only receiver with a measured row
 * (`built-ins/String/fromCharCode/S15.5.3.2_A1`). Same reasoning as #4234's
 * Number-only constants above; widening needs its own cost measurement.
 */
const CTOR_STATIC_METHODS: Record<string, readonly string[]> = {
  String: ["fromCharCode", "fromCodePoint", "raw"],
};

/**
 * Emit — into `fctx.body`, which the caller has already swapped to the
 * carrier's lazy-init body — the `__defineProperty_value` calls that install
 * `length` / `name` / `prototype` on the carrier object held in `objLocal`.
 *
 * No-op (nothing pushed) when the target is not a constructor, when the module
 * is not standalone, or when the object runtime is unavailable. Stack-neutral.
 */
export function pushBuiltinCtorOwnPropSeed(
  ctx: CodegenContext,
  fctx: FunctionContext,
  builtinName: string,
  objLocal: number,
): void {
  if (!ctx.standalone) return;
  const arity = BUILTIN_CTOR_ARITY[builtinName] ?? EXTRA_CTOR_ARITY[builtinName];
  if (arity === undefined) return;

  // (#4120) The carrier is a CONSTRUCTOR (it has a spec arity — `Math`/`JSON`/
  // `Reflect` returned above, and `typeof Math === "object"` is correct), so it
  // has [[Call]] and `typeof` must answer `"function"`. Brand it BEFORE the
  // own-property seed so the mark lands even if `__defineProperty_value` is
  // unavailable and the seed below declines.
  pushMarkBuiltinCarrierCallable(ctx, fctx, objLocal);

  const defineIdx = ctx.funcMap.get("__defineProperty_value");
  if (defineIdx === undefined) return;

  // `__box_number` is a late import; the caller registered the OUTER body in
  // `ctx.liveBodies` before swapping `fctx.body`, so a shift here walks both.
  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  if (boxIdx === undefined) return;
  flushLateImportShifts(ctx, fctx);

  // §20.2.4.1 `length` — { w:false, e:false, c:true }.
  fctx.body.push({ op: "local.get", index: objLocal });
  addStringConstantGlobal(ctx, "length");
  for (const instr of stringConstantExternrefInstrs(ctx, "length")) fctx.body.push(instr);
  fctx.body.push({ op: "f64.const", value: arity });
  fctx.body.push({ op: "call", funcIdx: boxIdx });
  fctx.body.push({ op: "f64.const", value: HOST_FLAG_CONFIGURABLE });
  fctx.body.push({ op: "call", funcIdx: defineIdx });
  fctx.body.push({ op: "drop" }); // helper returns the target; discard

  // §20.2.4.2 `name` — { w:false, e:false, c:true }.
  fctx.body.push({ op: "local.get", index: objLocal });
  addStringConstantGlobal(ctx, "name");
  for (const instr of stringConstantExternrefInstrs(ctx, "name")) fctx.body.push(instr);
  addStringConstantGlobal(ctx, builtinName);
  for (const instr of stringConstantExternrefInstrs(ctx, builtinName)) fctx.body.push(instr);
  fctx.body.push({ op: "f64.const", value: HOST_FLAG_CONFIGURABLE });
  fctx.body.push({ op: "call", funcIdx: defineIdx });
  fctx.body.push({ op: "drop" });

  // (#4234) Numeric value constants — { w:false, e:false, c:false }, flag word
  // 0. Seeded in declaration order so `getOwnPropertyNames` reports them after
  // `length`/`name` and before `prototype`, which is the spec own-key order for
  // `Number` (`length`, `name`, `prototype` are the function-object keys; the
  // §15.7.3 constants follow in table order). Only presence and attributes are
  // observable to the failing tests, but keeping insertion deterministic means
  // a future key-order test sees a stable answer.
  for (const [constName, constValue] of Object.entries(CTOR_NUMERIC_CONSTANTS[builtinName] ?? {})) {
    fctx.body.push({ op: "local.get", index: objLocal });
    addStringConstantGlobal(ctx, constName);
    for (const instr of stringConstantExternrefInstrs(ctx, constName)) fctx.body.push(instr);
    fctx.body.push({ op: "f64.const", value: constValue });
    fctx.body.push({ op: "call", funcIdx: boxIdx });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "call", funcIdx: defineIdx });
    fctx.body.push({ op: "drop" });
  }

  // `prototype` — { w:false, e:false, c:false }, value = the `$NativeProto`
  // singleton (identical to the syntactic `<Ctor>.prototype` read). Ctors with
  // no registered brand keep only `length`/`name`.
  const brand = tryEnsureNativeProtoBrand(ctx, builtinName);
  if (brand !== undefined) {
    // Speculative: `emitLazyNativeProtoGet` may decline, and it can allocate
    // locals / late imports before doing so. A raw `body.length = mark` would undo
    // only the body and strand those — hence the #1919 transactional helper, which
    // rolls back body + locals + imports + errors together. On decline the body is
    // left exactly as it was after `name` (stack-neutral).
    withSpeculativeCompile(ctx, fctx, () => {
      fctx.body.push({ op: "local.get", index: objLocal });
      addStringConstantGlobal(ctx, "prototype");
      for (const instr of stringConstantExternrefInstrs(ctx, "prototype")) fctx.body.push(instr);
      if (!emitLazyNativeProtoGet(ctx, fctx, brand)) return { commit: false, value: undefined };
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "call", funcIdx: defineIdx });
      fctx.body.push({ op: "drop" });
      return { commit: true, value: undefined };
    });
  }

  // (#2875 w4-F) Static METHODS — { w:true, e:false, c:true }, value = the
  // per-(builtin, method) singleton. Seeded LAST so `getOwnPropertyNames`
  // reports `length, name, prototype, fromCharCode, …`, the creation order a
  // conforming host reports. Each is speculative: the closure may decline (no
  // wired body / missing prerequisite), and declining must leave the body
  // stack-neutral rather than stranding a half-pushed define call.
  for (const method of CTOR_STATIC_METHODS[builtinName] ?? []) {
    withSpeculativeCompile(ctx, fctx, () => {
      const closure = ensureStandaloneBuiltinStaticMethodClosure(ctx, builtinName, method);
      if (!closure) return { commit: false, value: undefined };
      fctx.body.push({ op: "local.get", index: objLocal });
      addStringConstantGlobal(ctx, method);
      for (const instr of stringConstantExternrefInstrs(ctx, method)) fctx.body.push(instr);
      fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, closure));
      fctx.body.push({ op: "extern.convert_any" });
      fctx.body.push({ op: "f64.const", value: HOST_FLAG_WRITABLE | HOST_FLAG_CONFIGURABLE });
      fctx.body.push({ op: "call", funcIdx: defineIdx });
      fctx.body.push({ op: "drop" });
      return { commit: true, value: undefined };
    });
  }
}
