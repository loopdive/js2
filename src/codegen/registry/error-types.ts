// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Wasm-native Error construction for standalone / WASI mode (#1104 Phase 1).
 *
 * In JS-host mode, `new Error("msg")` lowers to a `__new_Error` host import
 * that resolves to the JS `Error` constructor. In standalone mode (`--target
 * wasi`) there is no JS host, so the import is unsatisfied and the wasm
 * module fails to instantiate with `Import #N "env": module is not an object
 * or function`.
 *
 * Phase 1 scope (this module): replace the `__new_<ErrorName>` host imports
 * with internal Wasm functions that build a WasmGC `$Error_struct` and return
 * it as externref. This unblocks instantiation and lets `throw new Error(...)`
 * (which already coerces the value to externref via the existing exception
 * tag) work in standalone mode.
 *
 * **Out of scope for Phase 1** (deferred to follow-up phases):
 *   - Property access for `err.message` / `err.name` — still routes through
 *     the JS-host `__extern_get` import.
 *   - `error instanceof TypeError` — still routes through the JS-host
 *     `__instanceof` import. The `$tag` field on `$Error_struct` is populated
 *     here so a future Phase 3 can drive ref.test/struct.get-based instanceof.
 *   - Stack traces — `error.stack` returns undefined (option 1 from the issue).
 *
 * The struct shape is intentionally minimal:
 *
 * ```
 * (type $Error_struct (struct
 *   (field $tag       i32)               ;; from BUILTIN_TYPE_TAGS
 *   (field $message   (mut externref))   ;; the constructor argument
 *   (field $name      externref)         ;; "Error" / "TypeError" / etc.
 * ))
 * ```
 *
 * The `$message` field is mutable because spec §20.5.1.1 allows
 * `error.message = "x"` writes. `$name` and `$tag` are immutable — the spec
 * does allow `error.name = "x"` overrides on subclasses, but Phase 2 will
 * decide whether to mirror that into the struct field or via a sidecar map.
 *
 * Issue: plan/issues/backlog/1104-wasm-native-error-construction-and.md
 * Related: src/codegen/builtin-tags.ts (#1325 type-tag registry)
 */

import type { CodegenContext } from "../context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js"; // (#1916 S3b) stable-regime minting
import type { Instr, ValType } from "../../ir/types.js";

import { BUILTIN_TYPE_TAGS } from "../builtin-tags.js";
import { userErrorCtorCarrierGlobal } from "../error-ctor-carrier.js"; // (#4262) carrier precedence
import { addFuncType, getOrRegisterErrorStructType } from "./types.js";
import { addStringConstantGlobal } from "./imports.js";
import {
  ensureNativeStringBoundaryBridge,
  nativeStringLiteralInstrs,
  stringConstantExternrefInstrs,
} from "../native-strings.js";
import { undefinedSingletonActive } from "../any-helpers.js";
import { usesNativeJsErrors } from "../js-errors.js";
import { CARRIER_BAG_HAS } from "../carrier-bag-visibility.js";
import { ERROR_PROP_GET } from "../error-props.js";

// (#2962) `getOrRegisterErrorStructType` moved to registry/types.ts so
// native-strings.ts can import it without an import cycle (this module imports
// `stringConstantExternrefInstrs` FROM native-strings.ts). Re-exported here so
// the existing importers (class-bodies, property-access, assignment,
// identifiers) keep their import path.
export { getOrRegisterErrorStructType } from "./types.js";

/**
 * The 8 built-in JS Error constructors that Phase 1 supports as Wasm-native
 * struct construction in WASI mode. Order matches the order in which test262
 * tests typically reference them.
 */
const WASI_ERROR_NAMES = [
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

/** Returns true if `name` is one of the 8 Error constructors handled by Phase 1. */
export function isWasiErrorName(name: string): name is WasiErrorName {
  return (WASI_ERROR_NAMES as readonly string[]).includes(name);
}

/**
 * (#2917 slice 1) Native backing representation of an externref-backed class
 * instance in standalone/WASI mode, for OWN-FIELD storage routing.
 *
 * An externref-backed subclass (`ctx.classExternrefBackedSet`) has no `$X`
 * WasmGC struct instance at runtime — the value `super(...)` produced depends
 * on the transitive BUILTIN ancestor (`ctx.classBuiltinParentMap`):
 *
 *   - Error family (+ `SuppressedError`, whose native instances are also
 *     `$Error_struct`s — #3234): a `$Error_struct` from
 *     `emitWasiErrorConstructor`. Own fields live in its `$props` side-slot
 *     (fieldIdx 5) — the #2101a R5 path.
 *   - `Object` (#3238): a native open `$Object` from
 *     `emitStandaloneObjectConstructor`. The instance ITSELF is the property
 *     store — own fields go straight through `__extern_set`/`__extern_get` on
 *     it. Casting it to `$Error_struct` (what the #2101a path did) TRAPS —
 *     that was the `class X extends Object { own = 1 }` illegal-cast bug.
 *   - anything else (TypedArray/SAB vec backing #3239, String, Promise, …):
 *     neither representation holds — return `undefined` so callers fall
 *     through to the legacy multi-dispatch path instead of baking a cast that
 *     can only trap.
 */
export type ExternrefBackedOwnFieldBacking = "error-struct" | "plain-object";

export function externrefBackedOwnFieldBacking(
  ctx: CodegenContext,
  className: string,
): ExternrefBackedOwnFieldBacking | undefined {
  const ancestor = ctx.classBuiltinParentMap.get(className) ?? className;
  if (ancestor === "Object") return "plain-object";
  if (isWasiErrorName(ancestor) || ancestor === "SuppressedError") return "error-struct";
  return undefined;
}

/**
 * Emit an internal Wasm function `__new_<errorName>` that constructs a new
 * `$Error_struct` and returns it as externref. The function takes `argCount`
 * externref params (the constructor arguments seen at call sites — typically
 * 0 or 1 for `new Error(msg)`).
 *
 * Idempotent — does nothing if `__new_<errorName>` is already registered
 * (whether as a host import or a previously-emitted internal function).
 *
 * #1536 Phase 2 — the `$name` field is now materialized with the error
 * class's name string ("Error" / "TypeError" / …) instead of the Phase-1
 * `ref.null extern` placeholder, so `err.name` reads the correct value in
 * standalone mode (the property-access fast path in `property-access.ts`
 * already does `struct.get $Error_struct[2]` for `.name` under
 * `ctx.wasi || ctx.standalone`). The constant is materialized via the
 * shared `stringConstantExternrefInstrs` dual-mode helper: nativeStrings
 * mode builds the FlatString struct inline + `extern.convert_any`;
 * host-strings mode emits a `global.get` of the interned string constant.
 * The string is registered via `addStringConstantGlobal` first so the
 * helper finds it in `ctx.stringGlobalMap`.
 */
export function emitWasiErrorConstructor(ctx: CodegenContext, errorName: WasiErrorName, argCount: number): void {
  emitErrorStructConstructor(ctx, `__new_${errorName}`, errorName, BUILTIN_TYPE_TAGS[errorName], argCount);
}

/**
 * Publish the minimal native-Error value adapter used by a JavaScript boundary.
 * Error state remains in `$Error_struct`; these functions only identify the
 * carrier and expose its stored name/message for a real host Error facade.
 */
export function emitNativeErrorBoundaryBridge(ctx: CodegenContext): void {
  if (
    ctx.targetProfile.semanticProviders !== "native-first" ||
    !ctx.emitHostBridge ||
    ctx.errorStructTypeIdx < 0 ||
    ctx.funcMap.has("__error_boundary_is_native")
  ) {
    return;
  }

  ensureNativeStringBoundaryBridge(ctx);
  const errorTypeIdx = ctx.errorStructTypeIdx;
  const register = (name: string, result: ValType, body: Instr[]): void => {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [result], `${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.funcMap.set(name, funcIdx);
    pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals: [], body, exported: true });
    ctx.mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
  };

  register("__error_boundary_is_native", { kind: "i32" }, [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: errorTypeIdx },
  ]);
  const field = (fieldIdx: number): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: errorTypeIdx },
    { op: "struct.get", typeIdx: errorTypeIdx, fieldIdx },
  ];
  register("__error_boundary_message", { kind: "externref" }, field(1));
  register("__error_boundary_name", { kind: "externref" }, field(2));
}

/**
 * (#3130) Get-or-create the `__builtin_<Name>` externref carrier global for an
 * Error-family constructor. Mirrors the global-creation half of
 * `emitBuiltinNamespaceObject` (builtin-static-globals.ts) byte-for-byte and
 * shares its `ctx.builtinObjectGlobals` key space, so the bare-identifier read
 * and the `err.constructor` runtime arm resolve to the SAME global. The global
 * starts null; both readers guard with the same lazy `__new_plain_object`
 * materialization, so first-read-wins and identity holds either way.
 *
 * Called from `fillExternGetErrorProps` at FINALIZE — deliberately NOT at
 * ctor-emit time: the standalone scaffold pre-registers `__new_TypeError` for
 * virtually every module, and an eager per-ctor global changed bytes on
 * error-free standalone modules (measured). Appending a global at finalize is
 * safe: dead-elim never removes/renumbers globals (it only remaps type/func
 * indices inside inits), and no import globals are added after the fill phase
 * in standalone/wasi mode, so `numImportGlobals + position` is final.
 */
function ensureErrorCtorCarrierGlobal(ctx: CodegenContext, name: string): number {
  let globalIdx = ctx.builtinObjectGlobals.get(name);
  if (globalIdx === undefined) {
    globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: `__builtin_${name}`,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.builtinObjectGlobals.set(name, globalIdx);
  }
  return globalIdx;
}

/**
 * (#2902) Standalone/WASI-native `new Test262Error(msg)` construction.
 *
 * The test262 harness injects `class Test262Error { message }` (and, in the
 * JS-host eval shim, `class Test262Error extends Error`) into every wrapped
 * test. In JS-host mode `new Test262Error(msg)` lowers to a `__new_Test262Error`
 * host import that yields a real `Error` subclass. In standalone mode there is
 * no JS host, so that import is unsatisfiable and leaks into the module — even
 * though the constructor is only ever reached on the (untaken) failure path of
 * a passing test. A leak-analysis of the merge_group standalone report found
 * ~2,779 tests that import ONLY `env::__new_Test262Error`, so building it
 * in-module flips them host-free.
 *
 * The value is built as the SAME `$Error_struct` the WASI error constructors
 * use, tagged as `Error` (so `instanceof Error` holds, matching
 * `Test262Error extends Error`) with `$name` = "Test262Error" (so `err.name`
 * and the standalone exception formatter read the correct constructor name).
 * `err.message` reads the first-arg field via the existing property-access
 * fast path. Host mode is unchanged — it keeps the `__new_Test262Error` import.
 */
export function emitStandaloneTest262Error(ctx: CodegenContext, argCount: number): void {
  emitErrorStructConstructor(ctx, "__new_Test262Error", "Test262Error", BUILTIN_TYPE_TAGS.Error, argCount);
}

/**
 * Shared builder for an in-module `$Error_struct` constructor. `displayName` is
 * materialized into the `$name` field; `tagValue` is written to `$tag` (drives
 * standalone `instanceof`). Idempotent on `importName`.
 */
function emitErrorStructConstructor(
  ctx: CodegenContext,
  importName: string,
  displayName: string,
  tagValue: number,
  argCount: number,
): void {
  if (ctx.funcMap.has(importName)) return;

  const structIdx = getOrRegisterErrorStructType(ctx);

  // #1536 Phase 2 — register the class-name string so the $name field can be
  // materialized below. Must run BEFORE building the body so the dual-mode
  // helper finds the interned global.
  addStringConstantGlobal(ctx, displayName);
  const nameInstrs = stringConstantExternrefInstrs(ctx, displayName);

  const params: ValType[] = Array.from({ length: argCount }, () => ({ kind: "externref" }) as ValType);
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }], `${importName}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(importName, funcIdx);

  // Body: push fields in struct field order (tag, message, name), then
  // `struct.new $Error_struct`, then `extern.convert_any` so the result has
  // the externref ABI shape that the `__new_<Name>` callers expect.
  const body: Instr[] = [
    { op: "i32.const", value: tagValue },
    // $message — first arg if present, else null
    argCount > 0 ? { op: "local.get", index: 0 } : { op: "ref.null.extern" },
    // $name — #1536 Phase 2: materialized class-name string ("TypeError" …)
    // as externref, replacing the Phase-1 `ref.null.extern` placeholder.
    ...nameInstrs,
    // $stack — (#1536) non-standard; standalone has no stack-capture
    // primitive, so initialize to null (reads back as `undefined`).
    { op: "ref.null.extern" },
    // $userClassId — (#2188) -1 sentinel: a plain builtin Error (or the shared
    // parent ctor of a user subclass) carries no per-user-class brand. The
    // subclass `super()` site overwrites this field after construction.
    { op: "i32.const", value: -1 },
    // $props — (#2101a R5) own-field backing store; null until the subclass's
    // first own-field write lazily allocates an `$Object` here.
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: structIdx },
    { op: "extern.convert_any" },
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: importName,
    typeIdx,
    locals: [],
    body,
    exported: false,
  });
}

/**
 * (#5269 E-2) `__new_SuppressedError_native(error, suppressed, message, options)`
 * — §20.5.10.1 without a JS host.
 *
 * `new SuppressedError(...)` and `SuppressedError(...)` both lowered to the
 * `env::__new_SuppressedError` host import unconditionally, so the mere PRESENCE
 * of the `nativeErrors.js` harness shape (a `typeof SuppressedError !==
 * 'undefined'` guard plus a construction) put an `env` import in a standalone
 * module and failed it at the host-import leak check (#2961/#5272) before a
 * single assertion ran.
 *
 * The body is the one the dispose driver already builds inline for its LIFO
 * error nesting (`disposable-runtime.ts` `buildSuppressedError`): an
 * `$Error_struct` tagged `SuppressedError`, carrying `error` and `suppressed`
 * on the `$props` sidecar. Sharing the shape is the point — a SuppressedError
 * raised by `using` and one written by hand must be the same kind of value.
 *
 * Spec order is preserved: `suppressed` (step 3), `error` (step 4), `message`
 * (step 5, only when not undefined), then InstallErrorCause (step 6).
 *
 * Returns `undefined` — having emitted NOTHING — when the object runtime's
 * property helpers are absent, so the caller keeps its existing lowering and
 * the module stays byte-identical.
 */
export function ensureNativeSuppressedErrorCtor(ctx: CodegenContext): number | undefined {
  const NAME = "__new_SuppressedError_native";
  const cached = ctx.funcMap.get(NAME);
  if (cached !== undefined) return cached;
  if (!usesNativeJsErrors(ctx)) return undefined;

  // The `$props` sidecar is an ordinary `$Object`, so this needs the object
  // runtime's property helpers. The CALLER ensures that runtime — `registry/`
  // sits below `object-runtime.ts` and importing it here would close an ESM
  // cycle (object-runtime-strict-set already imports this module).
  const newPlainObjIdx = ctx.funcMap.get("__new_plain_object");
  const externSetIdx = ctx.funcMap.get("__extern_set");
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const externHasIdx = ctx.funcMap.get("__extern_has");
  if (
    newPlainObjIdx === undefined ||
    externSetIdx === undefined ||
    externGetIdx === undefined ||
    externHasIdx === undefined
  ) {
    return undefined;
  }

  const externref: ValType = { kind: "externref" };
  const structIdx = getOrRegisterErrorStructType(ctx);
  addStringConstantGlobal(ctx, "SuppressedError");
  addStringConstantGlobal(ctx, "error");
  addStringConstantGlobal(ctx, "suppressed");
  addStringConstantGlobal(ctx, "cause");

  const P_ERROR = 0;
  const P_SUPPRESSED = 1;
  const P_MESSAGE = 2;
  const P_OPTIONS = 3;
  const L_PROPS = 4;

  // `x === undefined` is NOT `ref.is_null` under the #2106 singleton regime: an
  // omitted argument arrives as a non-null `$undefined` value. Both spec sites
  // below ("message is not undefined", "options is an Object") need the real
  // test, or an absent `message` would be stored as a present one.
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  const singleton = undefinedSingletonActive(ctx) && isUndefinedIdx !== undefined;
  const isAbsent = (param: number): Instr[] =>
    singleton
      ? [
          { op: "local.get", index: param },
          { op: "ref.is_null" },
          { op: "local.get", index: param },
          { op: "call", funcIdx: isUndefinedIdx! },
          { op: "i32.or" },
        ]
      : [{ op: "local.get", index: param }, { op: "ref.is_null" }];

  const setOn = (target: number, key: string, value: Instr[]): Instr[] => [
    { op: "local.get", index: target },
    ...stringConstantExternrefInstrs(ctx, key),
    ...value,
    { op: "call", funcIdx: externSetIdx },
  ];

  const body: Instr[] = [
    { op: "call", funcIdx: newPlainObjIdx },
    { op: "local.set", index: L_PROPS },
    // Step 3 then step 4 — the spec's order, and the order the dispose driver
    // writes them in.
    ...setOn(L_PROPS, "suppressed", [{ op: "local.get", index: P_SUPPRESSED }]),
    ...setOn(L_PROPS, "error", [{ op: "local.get", index: P_ERROR }]),
    // Step 6, InstallErrorCause: `cause` is installed when options HAS the
    // property — not when it is truthy — so an explicit `{ cause: undefined }`
    // still creates it.
    ...isAbsent(P_OPTIONS),
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: P_OPTIONS },
        ...stringConstantExternrefInstrs(ctx, "cause"),
        { op: "call", funcIdx: externHasIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: setOn(L_PROPS, "cause", [
            { op: "local.get", index: P_OPTIONS },
            ...stringConstantExternrefInstrs(ctx, "cause"),
            { op: "call", funcIdx: externGetIdx },
          ]),
        },
      ],
    },
    // $tag
    { op: "i32.const", value: BUILTIN_TYPE_TAGS.SuppressedError },
    // $message — step 5 stores it only when it is not undefined. The value is
    // kept as it arrives, exactly as `__new_Error(msg)` keeps its own argument:
    // routing one of the two through a ToString the other skips is how the
    // Error family's `.message` reads would start to disagree.
    ...isAbsent(P_MESSAGE),
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then: [{ op: "ref.null.extern" }],
      else: [{ op: "local.get", index: P_MESSAGE }],
    },
    // $name
    ...stringConstantExternrefInstrs(ctx, "SuppressedError"),
    // $stack — no stack-capture primitive standalone (reads back as undefined).
    { op: "ref.null.extern" },
    // $userClassId — -1: a builtin, not a user subclass brand.
    { op: "i32.const", value: -1 },
    // $props
    { op: "local.get", index: L_PROPS },
    { op: "struct.new", typeIdx: structIdx },
    { op: "extern.convert_any" },
  ];

  const typeIdx = addFuncType(ctx, [externref, externref, externref, externref], [externref], `${NAME}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(NAME, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: NAME,
    typeIdx,
    locals: [{ name: "props", type: externref }],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * (#3130) Finalize-time fill: teach `__extern_get` — the universal dynamic
 * property reader every `any`-receiver read terminally routes through
 * (`__dyn_get`, the `__get_member_<name>` dispatcher fallbacks, typed reads
 * with no fast path) — to answer property reads on a native `$Error_struct`
 * receiver.
 *
 * WHY: `__extern_get` unwraps its receiver to `$Object` and answers a miss
 * (undefined) for anything else. A thrown/constructed native Error is an
 * `$Error_struct`, NOT an `$Object`, so `reason.constructor`, `err.name`,
 * `err.message` on an `any`-typed value all read back `undefined` in
 * standalone mode even though the struct carries the data and `instanceof`
 * (tag-driven) passes. The static fast path in property-access.ts only
 * covers statically-Error-typed receivers and `catch`-clause bindings — a
 * promise rejection callback parameter (`reason`) is neither, which is
 * exactly the `resolve-settled-*-self` §27.2.1.3.2 acceptance shape.
 *
 * The spliced arm, in shadowing order:
 *   1. `$props` sidecar (fieldIdx 5, subclass own fields / dynamic writes):
 *      recursive `__extern_get` — it holds a plain `$Object`, so accessors +
 *      proto chain resolve normally; a nullish result falls through.
 *   2. String-key dispatch (flatten once, `__str_equals` per candidate —
 *      the fillBuiltinFnMeta pattern): `message`→field 1, `name`→field 2,
 *      `stack`→field 3.
 *   3. `constructor` → the per-name `__builtin_<Name>` bare-identifier
 *      carrier global (#2907), lazily materialized with the SAME
 *      `__new_plain_object` guard `emitBuiltinNamespaceObject` uses — so
 *      `err.constructor === TypeError` is GENUINE object identity. Gated on
 *      `$userClassId == -1` (a user subclass instance must NOT answer its
 *      builtin parent's constructor) and, for the shared "Error" tag, on the
 *      `$name` field equalling "Error" (a Test262Error shares the Error tag
 *      but is a user harness class — it keeps today's miss).
 *   4. Anything else falls through to the original body → the standard miss.
 *
 * Shift-safety (the fillBuiltinFnMeta discipline): runs at finalize BEFORE
 * dead-elim; resolves every funcIdx BY NAME from the shift-maintained maps at
 * fill time; splices into the existing body (never rebuilds it — see
 * `reference_no_rebuild_helper_body_at_finalize`); `ref.test`/`ref.cast`/
 * `struct.get` use type indices (append-only pre-emission). New locals are
 * APPENDED so existing local indices are untouched.
 *
 * No-op (byte-identical) unless the module registered `$Error_struct`
 * (i.e. actually constructs native errors) under wasi/standalone.
 */
export function fillExternGetErrorProps(ctx: CodegenContext): void {
  if (ctx.targetProfile.semanticProviders !== "native-first") return;
  const errTypeIdx = ctx.errorStructTypeIdx;
  if (errTypeIdx < 0) return; // no native Error structs in this module
  const fn = ctx.mod.functions.find((f) => f.name === "__extern_get");
  if (!fn) return; // object runtime never emitted (nothing reads dynamically)
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const newObjectIdx = ctx.funcMap.get("__new_plain_object");
  if (strFlattenIdx === undefined || strEqualsIdx === undefined || newObjectIdx === undefined) {
    return;
  }
  if (ctx.anyStrTypeIdx < 0 || ctx.nativeStrTypeIdx < 0) return;
  const bagHasIdx = ctx.funcMap.get(CARRIER_BAG_HAS);
  const errorPropGetIdx = ctx.funcMap.get(ERROR_PROP_GET);
  if (bagHasIdx === undefined || errorPropGetIdx === undefined) return;

  // __extern_get: params 0=obj 1=key; existing locals o(2) e(3) any(4)
  // getter(5) bfmeta(6). Append ours — never renumber existing ones.
  const anyL = 2 + fn.locals.length;
  const fkeyL = anyL + 1;
  fn.locals.push(
    { name: "__err_any", type: { kind: "anyref" } },
    { name: "__err_fkey", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } },
  );

  const errRef = (): Instr[] => [
    { op: "local.get", index: anyL },
    { op: "ref.cast", typeIdx: errTypeIdx },
  ];
  const keyEquals = (lit: string): Instr[] => [
    { op: "local.get", index: fkeyL },
    { op: "ref.as_non_null" },
    ...nativeStringLiteralInstrs(ctx, lit),
    { op: "call", funcIdx: strEqualsIdx },
  ];
  // key == "<lit>" → return struct field <fieldIdx> (externref, returned raw:
  // the same value rep the typed fast path in property-access.ts yields).
  const fieldArm = (lit: string, fieldIdx: number): Instr[] => [
    ...keyEquals(lit),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...errRef(), { op: "struct.get", typeIdx: errTypeIdx, fieldIdx }, { op: "return" }],
    },
  ];

  // (#3614) `<user-fnctor error instance>.constructor` → the SAME cached
  // closure singleton the bare identifier resolves to.
  //
  // `emitStandaloneTest262Error` (#2902) lowers `new Test262Error(msg)` to an
  // `$Error_struct` carrying `$name = "Test262Error"`. Reading `.constructor`
  // off that struct fell through every arm below (the `Error`-tag arm is
  // explicitly guarded to answer only a genuine `new Error(...)`) and returned
  // `undefined`. The upstream harness's `assert.throws` compares
  // `thrown.constructor !== expectedErrorConstructor` for EVERY caught value,
  // so `undefined !== <closure>` made the comparison fail even when the test
  // threw exactly the expected error — 854 standalone tests whose only defect
  // was this missing back-pointer (measured against the post-#3592
  // de-vacuification merged standalone report).
  //
  // The answer must be IDENTITY-equal to what a bare `Test262Error` mention
  // produces, which is `ctx.funcClosureGlobals`' per-name cached closure
  // singleton (`__fn_closure_<Name>`, method-trampolines.ts) — the same global
  // the `expectedErrorConstructor` argument was read from, so `===` holds by
  // `ref.eq`. We deliberately only READ that global (never lazily materialize
  // it here): materializing would require a `ref.func` trampoline minted at
  // FINALIZE, which is exactly the late-funcidx-shift hazard this file's
  // `ensureErrorCtorCarrierGlobal` note calls out. A null read means the
  // identifier was never evaluated as a value anywhere in the module, in which
  // case nothing can hold the other side of an identity comparison either —
  // so falling through to today's miss loses nothing.
  //
  // Keyed on the immutable `$name` field (not the tag, which Test262Error
  // SHARES with `Error`), so a genuine `new Error()` is unaffected. Scoped to
  // user constructors that this module actually lowered to an `$Error_struct`
  // (`__new_<Name>` present AND a closure singleton exists), which excludes
  // every builtin error name (they have no user function declaration and thus
  // no `funcClosureGlobals` entry).
  //
  // (#4262) The carrier is resolved by `userErrorCtorCarrierGlobal`, NOT by
  // `ctx.funcClosureGlobals` directly. `funcClosureGlobals` is the LOWER-
  // precedence of the two carriers a function value can live in: the bare
  // identifier read takes `ctx.moduleGlobals` first whenever the declaration is
  // closure-backed or reassigned, which the literal upstream harness always is
  // (`assert.js` closes over `Test262Error`). Answering the fn-closure
  // singleton there returned a function that was `!==` the name AND had no
  // property bag, so `err.constructor.name` read `undefined` — the
  // `Expected a Test262Error, but a "undefined" was thrown.` self-test
  // signature. See src/codegen/error-substrate.ts for the measured evidence.
  const userCtorArms: Instr[] = [];
  for (const name of USER_ERROR_CTOR_IDENTITY_NAMES) {
    if (!ctx.funcMap.has(`__new_${name}`)) continue;
    const closureGlobalIdx = userErrorCtorCarrierGlobal(ctx, name);
    if (closureGlobalIdx === undefined) continue;
    userCtorArms.push(
      ...errRef(),
      { op: "struct.get", typeIdx: errTypeIdx, fieldIdx: 2 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } as ValType },
        then: [
          ...errRef(),
          { op: "struct.get", typeIdx: errTypeIdx, fieldIdx: 2 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
          { op: "call", funcIdx: strFlattenIdx },
          ...nativeStringLiteralInstrs(ctx, name),
          { op: "call", funcIdx: strEqualsIdx },
        ],
        else: [{ op: "i32.const", value: 0 }],
      },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "global.get", index: closureGlobalIdx },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "global.get", index: closureGlobalIdx }, { op: "return" }],
          },
        ],
      },
    );
  }

  // One `constructor` arm per builtin error ctor EMITTED in this module. The
  // carrier global is get-or-created HERE (append-only; see
  // ensureErrorCtorCarrierGlobal for why finalize-time creation is safe) —
  // reusing the bare-identifier read's global when one exists.
  const ctorArms: Instr[] = [];
  for (const name of WASI_ERROR_NAMES) {
    if (!ctx.funcMap.has(`__new_${name}`)) continue;
    const globalIdx = ensureErrorCtorCarrierGlobal(ctx, name);
    const answerCarrier: Instr[] = [
      { op: "global.get", index: globalIdx },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "call", funcIdx: newObjectIdx },
          { op: "global.set", index: globalIdx },
        ],
      },
      { op: "global.get", index: globalIdx },
      { op: "return" },
    ];
    // The "Error" tag is SHARED with Test262Error (emitStandaloneTest262Error
    // constructs with the Error tag). Disambiguate by the immutable `$name`
    // field: only a genuine `new Error(...)` (name === "Error") answers the
    // Error carrier; Test262Error keeps today's miss.
    const guarded: Instr[] =
      name === "Error"
        ? [
            ...errRef(),
            { op: "struct.get", typeIdx: errTypeIdx, fieldIdx: 2 },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } as ValType },
              then: [
                ...errRef(),
                { op: "struct.get", typeIdx: errTypeIdx, fieldIdx: 2 },
                { op: "any.convert_extern" },
                { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
                { op: "call", funcIdx: strFlattenIdx },
                ...nativeStringLiteralInstrs(ctx, "Error"),
                { op: "call", funcIdx: strEqualsIdx },
              ],
              else: [{ op: "i32.const", value: 0 }],
            },
            { op: "if", blockType: { kind: "empty" }, then: answerCarrier },
          ]
        : answerCarrier;
    ctorArms.push(
      ...errRef(),
      { op: "struct.get", typeIdx: errTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: BUILTIN_TYPE_TAGS[name] },
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "empty" }, then: guarded },
    );
  }

  const arm: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: anyL },
    { op: "ref.test", typeIdx: errTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // 1) `$props` own entry first — dynamic writes/defines shadow the
        //    builtin surface. Presence and value are separate so a stored null
        //    is still a handled value. The getter helper receives the ORIGINAL
        //    Error receiver, not the hidden sidecar, preserving accessor `this`.
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: bagHasIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: errorPropGetIdx },
            { op: "return" },
          ],
        },
        // 2) Named-key dispatch — string keys only. A Symbol / boxed-number key
        //    skips this block and falls through to the standard miss, exactly
        //    like today (no trap: the cast is guarded by the ref.test).
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
            { op: "call", funcIdx: strFlattenIdx },
            { op: "local.set", index: fkeyL },
            ...fieldArm("message", 1),
            ...fieldArm("name", 2),
            ...fieldArm("stack", 3),
            ...keyEquals("constructor"),
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // Builtin instances only: a user subclass ($userClassId != -1)
                // keeps today's miss rather than answering the WRONG (parent)
                // constructor.
                ...errRef(),
                { op: "struct.get", typeIdx: errTypeIdx, fieldIdx: 4 },
                { op: "i32.const", value: -1 },
                { op: "i32.eq" },
                { op: "if", blockType: { kind: "empty" }, then: [...userCtorArms, ...ctorArms] },
              ],
            },
          ],
        },
        // No match → fall through to the original body → standard miss.
      ],
    },
  ];

  fn.body.splice(0, 0, ...arm);
}

/**
 * (#5269 L) `hasOwnProperty(new Error("m"), "message")` — the ONE intrinsic
 * `$Error_struct` field that is a spec OWN data property.
 *
 * §20.5.1.1 step 4: `CreateNonEnumerableDataPropertyOrThrow(O, "message", msg)`
 * runs only when the argument is not `undefined`, so `new Error()` has NO own
 * `message` while `new Error("m")` does. In this compiler the value lives in
 * struct field 1, not in the `$props` bag, so the own-property walk
 * (`__obj_find`, then the carrier bag) could not see it and
 * `error.hasOwnProperty("message")` answered false while `error.message` read
 * `"my-message"` — the exact disagreement `verifyProperty` reports.
 *
 * ## Why this is spliced onto `__hasOwnProperty` and yet is NOT #4017
 *
 * #4017 widened these two natives GENERICALLY (any carrier, any key, through
 * the closure side table) and was auto-parked for costing 684 host-free passes:
 * `propertyHelper.js` reaches `Object.prototype.hasOwnProperty` on every
 * `built-ins/**\/{name,length}.js` row. The lesson recorded in
 * `carrier-bag-hasown.ts` is that generality AT THIS POINT is blast radius.
 *
 * This arm is the opposite shape: it fires only for a receiver that `ref.test`s
 * as `$Error_struct` AND a key that flattens equal to `"message"` AND a non-null
 * field. A null field falls through to the original body, so `new Error()` keeps
 * today's answer. No other receiver, key, or outcome is reachable.
 *
 * The gOPD twin is spliced from the same builder, over the same field, so
 * presence and the descriptor cannot disagree — measured: with presence alone,
 * `verifyProperty` moved from "message should be an own property" to
 * dereferencing the `undefined` `originalDesc`. Write and delete for `message`
 * are already answered by `error-props.ts`.
 *
 * No-op (byte-identical) unless the module registered `$Error_struct`.
 */
export function fillErrorStructMessageOwnPropArms(ctx: CodegenContext): void {
  if (ctx.targetProfile.semanticProviders !== "native-first") return;
  const errTypeIdx = ctx.errorStructTypeIdx;
  if (errTypeIdx < 0) return;
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (strFlattenIdx === undefined || strEqualsIdx === undefined) return;
  if (ctx.anyStrTypeIdx < 0 || ctx.nativeStrTypeIdx < 0) return;

  // §20.5.1.1: `{ [[Writable]]: true, [[Enumerable]]: false,
  // [[Configurable]]: true }` — the `__create_descriptor` flag word.
  const MESSAGE_DESC_FLAGS = 0x01 | 0x04;
  const createDescriptorIdx = ctx.funcMap.get("__create_descriptor");
  const externGetIdx = ctx.funcMap.get("__extern_get");

  for (const name of ["__hasOwnProperty", "__object_hasOwn", "__getOwnPropertyDescriptor", "__delete_property"]) {
    if (name === "__getOwnPropertyDescriptor" && (createDescriptorIdx === undefined || externGetIdx === undefined))
      continue;
    const fn = ctx.mod.functions.find((f) => f.name === name);
    if (!fn) continue;
    // params 0=obj 1=key; APPEND locals so every baked index keeps its meaning.
    const anyL = 2 + fn.locals.length;
    const fkeyL = anyL + 1;
    fn.locals.push(
      { name: "__errhas_any", type: { kind: "anyref" } },
      { name: "__errhas_fkey", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } },
    );
    // `hasOwnProperty` answers presence; gOPD answers the §20.5.1.1 descriptor
    // over the SAME field, so the two cannot disagree about `message`.
    const answer: Instr[] =
      name === "__getOwnPropertyDescriptor"
        ? [
            // The VALUE comes from `__extern_get`, not from the field directly:
            // a `err.message = x` write lands in the `$props` sidecar, which
            // `fillExternGetErrorProps` reads BEFORE the field. Reading the
            // field here would make the descriptor disagree with the read the
            // moment anything wrote. `__extern_get` already carries the Error
            // arm, so this is one source of truth, not a second walk.
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: externGetIdx! },
            { op: "i32.const", value: MESSAGE_DESC_FLAGS },
            { op: "call", funcIdx: createDescriptorIdx! },
            { op: "return" },
          ]
        : name === "__delete_property"
          ? [
              // `[[Configurable]]: true` is only true if the property can
              // actually be deleted — `verifyProperty` PROVES it by deleting.
              // `$message` is the one mutable intrinsic field (§20.5.1.1 allows
              // `error.message = "x"`), so clear it and then FALL THROUGH: a
              // prior write put a shadowing entry in the `$props` sidecar, and
              // only the ordinary body removes that. Returning here left the
              // sidecar entry behind, so `hasOwnProperty` still answered true
              // after the delete and `isConfigurable` reported false.
              { op: "local.get", index: anyL },
              { op: "ref.cast", typeIdx: errTypeIdx },
              { op: "ref.null.extern" },
              { op: "struct.set", typeIdx: errTypeIdx, fieldIdx: 1 },
            ]
          : [{ op: "i32.const", value: 1 }, { op: "return" }];
    const arm: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: anyL },
      { op: "ref.test", typeIdx: errTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
              { op: "call", funcIdx: strFlattenIdx },
              { op: "local.set", index: fkeyL },
              { op: "local.get", index: fkeyL },
              { op: "ref.as_non_null" },
              ...nativeStringLiteralInstrs(ctx, "message"),
              { op: "call", funcIdx: strEqualsIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: anyL },
                  { op: "ref.cast", typeIdx: errTypeIdx },
                  { op: "struct.get", typeIdx: errTypeIdx, fieldIdx: 1 },
                  { op: "ref.is_null" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    // A null `$message` (`new Error()`) has NO own `message` —
                    // fall through so the answer stays whatever it is today.
                    then: [],
                    else: answer,
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    fn.body.splice(0, 0, ...arm);
  }
}
