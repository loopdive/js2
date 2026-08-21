// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// extern-declarations.ts — the ambient / extern / declare collection pre-pass
// (#3272, extracted verbatim from index.ts). Registers built-in extern classes
// and collects `declare` classes / interfaces / mixins / namespaces / enums /
// globals, node-builtin + jsx-runtime import registration, and the WASI/DOM
// usage guards. index.ts imports these back for its compile driver and
// re-exports the public entry points for their external callers.

import { ts, forEachChild } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, ExternClassInfo } from "./context/types.js";
import type { NodeBuiltinImport } from "../import-resolver.js";
import { hasDeclareModifier } from "./ast-modifiers.js";
import { isExternalDeclaredClass, isVoidType, mapTsTypeToWasm } from "../checker/type-mapper.js";
import { FS_PATH_BASED_MEMBERS, WASI_NODE_FS_ALIAS_SENTINEL } from "../checker/node-capability-map.js";
import { addFuncType } from "./registry/types.js";
import { addImport, addStringConstantGlobal, addStringImports } from "./registry/imports.js";
import { brandExternMethodResult } from "./shared.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { nativeTypeFromTypeNode } from "./native-type-annotations.js";
import { reportError } from "./context/errors.js";
import { registerAmbientParseImport } from "./ambient-parse-import.js";
import {
  heritageBaseName,
  isExternDeclaredLibName,
  isVoidTypeNode,
  libConstructSignatures,
  mapLibTypeNodeToWasm,
  resolveLibTypeName,
  typeParamScopeOf,
  typeRefName,
  type LibDeclIndex,
} from "./lib-decl-index.js";
// ── Built-in extern class registration ───────────────────────────────

/** Helper to create an extern method signature with externref params and results */
function externMethod(
  paramCount: number,
  returnsExternref = true,
): { params: ValType[]; results: ValType[]; requiredParams: number } {
  const params: ValType[] = [];
  for (let i = 0; i <= paramCount; i++) params.push({ kind: "externref" }); // self + args
  return {
    params,
    results: returnsExternref ? [{ kind: "externref" }] : [],
    requiredParams: params.length,
  };
}

/**
 * Register built-in collection types (Set, Map, WeakMap, WeakSet) as extern classes
 * if they weren't already collected from lib .d.ts files. This ensures these types
 * are available for extern class method dispatch even when lib file scanning fails
 * (e.g., bundled/browser environments where readLibFile returns empty strings).
 */
export function registerBuiltinExternClasses(ctx: CodegenContext): void {
  // Set methods — all take (self: externref, ...args: externref) → externref.
  // (#2162) In standalone / nativeStrings mode `Set` is served by the
  // WasmGC-native runtime (src/codegen/set-runtime.ts, reusing the Map backing
  // store), intercepted at the new-expression / method-call / .size sites.
  // Registering it as an externClass here would eagerly emit a `Set_new` host
  // import the standalone module can't satisfy, so skip it in that mode (mirrors
  // the Map gating below). JS-host mode keeps the externClass path unchanged.
  if (!ctx.externClasses.has("Set") && !ctx.nativeStrings) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    // ES2015 methods
    methods.set("add", externMethod(1)); // add(value) → Set
    methods.set("has", externMethod(1)); // has(value) → boolean (externref)
    methods.set("delete", externMethod(1)); // delete(value) → boolean (externref)
    methods.set("clear", externMethod(0, false)); // clear() → void
    methods.set("forEach", externMethod(1)); // forEach(callback) → void (externref for simplicity)
    methods.set("entries", externMethod(0)); // entries() → Iterator
    methods.set("keys", externMethod(0)); // keys() → Iterator
    methods.set("values", externMethod(0)); // values() → Iterator
    // ES2025 Set methods
    methods.set("union", externMethod(1)); // union(other) → Set
    methods.set("intersection", externMethod(1)); // intersection(other) → Set
    methods.set("difference", externMethod(1)); // difference(other) → Set
    methods.set("symmetricDifference", externMethod(1)); // symmetricDifference(other) → Set
    methods.set("isSubsetOf", externMethod(1)); // isSubsetOf(other) → boolean (externref)
    methods.set("isSupersetOf", externMethod(1)); // isSupersetOf(other) → boolean (externref)
    methods.set("isDisjointFrom", externMethod(1)); // isDisjointFrom(other) → boolean (externref)

    ctx.externClasses.set("Set", {
      importPrefix: "Set",
      namespacePath: [],
      className: "Set",
      constructorParams: [{ kind: "externref" }], // new Set(iterable?)
      methods,
      properties: new Map([["size", { type: { kind: "externref" }, readonly: true }]]),
    });
  }

  // Map methods.
  // (#1103a) In standalone / nativeStrings mode, `Map` is served by the
  // WasmGC-native runtime (src/codegen/map-runtime.ts), intercepted at the
  // new-expression / method-call / .size sites. Registering it as an
  // externClass here would eagerly emit a `Map_new` host import the standalone
  // module can't satisfy, so skip registration in that mode. JS-host mode keeps
  // the externClass path unchanged. (Slice 1 covers number/string keys with
  // new/get/set/has/delete/clear/size; forEach / iteration / new Map(iterable)
  // are slice 2 — those fall through and currently have no standalone path.)
  if (!ctx.externClasses.has("Map") && !ctx.nativeStrings) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("get", externMethod(1));
    methods.set("set", externMethod(2));
    methods.set("has", externMethod(1));
    methods.set("delete", externMethod(1));
    methods.set("clear", externMethod(0, false));
    methods.set("forEach", externMethod(1));
    methods.set("entries", externMethod(0));
    methods.set("keys", externMethod(0));
    methods.set("values", externMethod(0));
    // (#837) TC39 Stage 3 "upsert" proposal: Map.prototype.getOrInsert /
    // .getOrInsertComputed. Both take (key, value|callback) and return the
    // existing or newly-inserted value as externref.
    methods.set("getOrInsert", externMethod(2));
    methods.set("getOrInsertComputed", externMethod(2));

    ctx.externClasses.set("Map", {
      importPrefix: "Map",
      namespacePath: [],
      className: "Map",
      constructorParams: [{ kind: "externref" }],
      methods,
      properties: new Map([["size", { type: { kind: "externref" }, readonly: true }]]),
    });
  }

  // WeakMap methods.
  // (#2162) Skip under nativeStrings — the native weak-collection runtime
  // (weak-collections-runtime.ts, reusing the Map backing store) serves it, so
  // registering the externClass would leak a `WeakMap_new` host import.
  if (!ctx.externClasses.has("WeakMap") && !ctx.nativeStrings) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("get", externMethod(1));
    methods.set("set", externMethod(2));
    methods.set("has", externMethod(1));
    methods.set("delete", externMethod(1));
    // (#837) TC39 Stage 3 "upsert" proposal: WeakMap.prototype.getOrInsert /
    // .getOrInsertComputed. Mirrors Map's signatures.
    methods.set("getOrInsert", externMethod(2));
    methods.set("getOrInsertComputed", externMethod(2));

    ctx.externClasses.set("WeakMap", {
      importPrefix: "WeakMap",
      namespacePath: [],
      className: "WeakMap",
      constructorParams: [{ kind: "externref" }],
      methods,
      properties: new Map(),
    });
  }

  // WeakSet methods.
  // (#2162) Skip under nativeStrings — served by the native weak-collection
  // runtime; registering the externClass would leak a `WeakSet_new` host import.
  if (!ctx.externClasses.has("WeakSet") && !ctx.nativeStrings) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("add", externMethod(1));
    methods.set("has", externMethod(1));
    methods.set("delete", externMethod(1));

    ctx.externClasses.set("WeakSet", {
      importPrefix: "WeakSet",
      namespacePath: [],
      className: "WeakSet",
      constructorParams: [{ kind: "externref" }],
      methods,
      properties: new Map(),
    });
  }

  // FinalizationRegistry (#1600) — host-delegate in JS mode, no-op stub in
  // standalone. The spec never guarantees cleanup callbacks run, so a registry
  // that tracks register/unregister but never fires the callback is fully
  // conformant. The host import builds a real engine FinalizationRegistry;
  // register/unregister forward to it.
  if (!ctx.externClasses.has("FinalizationRegistry")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    // register(target, heldValue, unregisterToken?) → undefined
    methods.set("register", {
      params: [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      results: [{ kind: "externref" }],
      requiredParams: 2,
    });
    // unregister(token) → boolean (externref)
    methods.set("unregister", externMethod(1));

    ctx.externClasses.set("FinalizationRegistry", {
      importPrefix: "FinalizationRegistry",
      namespacePath: [],
      className: "FinalizationRegistry",
      constructorParams: [{ kind: "externref" }], // new FinalizationRegistry(cleanupCallback)
      methods,
      properties: new Map(),
    });
  }

  // DisposableStack / AsyncDisposableStack — TC39 Explicit Resource Management (#830)
  if (!ctx.externClasses.has("DisposableStack")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("dispose", externMethod(0, false)); // dispose() → void
    methods.set("use", externMethod(1)); // use(value) → value
    methods.set("adopt", externMethod(2)); // adopt(value, onDispose) → value
    methods.set("defer", externMethod(1, false)); // defer(onDispose) → void
    methods.set("move", externMethod(0)); // move() → DisposableStack

    ctx.externClasses.set("DisposableStack", {
      importPrefix: "DisposableStack",
      namespacePath: [],
      className: "DisposableStack",
      constructorParams: [], // new DisposableStack()
      methods,
      properties: new Map([["disposed", { type: { kind: "externref" }, readonly: true }]]),
    });
  }

  if (!ctx.externClasses.has("AsyncDisposableStack")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("disposeAsync", externMethod(0)); // disposeAsync() → Promise
    methods.set("use", externMethod(1));
    methods.set("adopt", externMethod(2));
    methods.set("defer", externMethod(1, false));
    methods.set("move", externMethod(0));

    ctx.externClasses.set("AsyncDisposableStack", {
      importPrefix: "AsyncDisposableStack",
      namespacePath: [],
      className: "AsyncDisposableStack",
      constructorParams: [],
      methods,
      properties: new Map([["disposed", { type: { kind: "externref" }, readonly: true }]]),
    });
  }

  if (!ctx.externClasses.has("SuppressedError")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    ctx.externClasses.set("SuppressedError", {
      importPrefix: "SuppressedError",
      namespacePath: [],
      className: "SuppressedError",
      constructorParams: [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      methods,
      properties: new Map([
        ["error", { type: { kind: "externref" }, readonly: false }],
        ["suppressed", { type: { kind: "externref" }, readonly: false }],
        ["message", { type: { kind: "externref" }, readonly: false }],
      ]),
    });
  }

  // Register Object as base extern class with prototype methods (#799 WI2).
  // All extern classes that lack a parent inherit from Object, so
  // findExternInfoForMember will resolve hasOwnProperty, toString, etc.
  if (!ctx.externClasses.has("Object")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("hasOwnProperty", externMethod(1));
    methods.set("isPrototypeOf", externMethod(1));
    methods.set("propertyIsEnumerable", externMethod(1));
    methods.set("toString", externMethod(0));
    methods.set("valueOf", externMethod(0));
    methods.set("toLocaleString", externMethod(0));
    ctx.externClasses.set("Object", {
      importPrefix: "Object",
      namespacePath: [],
      className: "Object",
      constructorParams: [],
      methods,
      properties: new Map([["constructor", { type: { kind: "externref" }, readonly: true }]]),
    });
  }

  // Intl.ListFormat — extern class for internationalized list formatting
  if (!ctx.externClasses.has("ListFormat")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("format", externMethod(1)); // format(list) → string (externref)
    methods.set("formatToParts", externMethod(1)); // formatToParts(list) → array (externref)
    methods.set("resolvedOptions", externMethod(0)); // resolvedOptions() → object (externref)
    ctx.externClasses.set("ListFormat", {
      importPrefix: "Intl_ListFormat",
      namespacePath: ["Intl"],
      className: "ListFormat",
      constructorParams: [{ kind: "externref" }, { kind: "externref" }], // locale?, options?
      methods,
      properties: new Map(),
    });
  }

  // Intl.NumberFormat — extern class for internationalized number formatting
  if (!ctx.externClasses.has("NumberFormat")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("format", externMethod(1)); // format(n) → string (externref)
    methods.set("formatToParts", externMethod(1)); // formatToParts(n) → array (externref)
    methods.set("resolvedOptions", externMethod(0)); // resolvedOptions() → object (externref)
    ctx.externClasses.set("NumberFormat", {
      importPrefix: "Intl_NumberFormat",
      namespacePath: ["Intl"],
      className: "NumberFormat",
      constructorParams: [{ kind: "externref" }, { kind: "externref" }], // locale?, options?
      methods,
      properties: new Map(),
    });
  }

  // (#1792) node:url — `URL` / `URLSearchParams` as host constructors. Both are
  // WHATWG globals present in Node 18+ and every browser, so the JS-host path
  // binds them via `builtinCtors` (runtime.ts) exactly like Set/Map. `new
  // URL(...)` / `new URLSearchParams(...)` lower to `URL_new` /
  // `URLSearchParams_new`; instance property reads (`.pathname`,
  // `.searchParams`, …) flow through the generic `__extern_get` host import and
  // method calls (`.get`, `.getAll`, …) through `__extern_method_call`. The
  // method tables below give the typed-dispatch path exact arities. Standalone
  // (WASI) needs a pure-Wasm URL parser — deferred (#1792 approach step 4), so
  // skip registration under nativeStrings to avoid leaking an unsatisfiable
  // `URL_new` host import into the standalone module.
  if (!ctx.externClasses.has("URL") && !ctx.nativeStrings) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("toString", externMethod(0)); // toString() → string
    methods.set("toJSON", externMethod(0)); // toJSON() → string
    ctx.externClasses.set("URL", {
      importPrefix: "URL",
      namespacePath: [],
      className: "URL",
      constructorParams: [{ kind: "externref" }, { kind: "externref" }], // new URL(url, base?)
      methods,
      // All URL instance properties are host getters read via __extern_get;
      // listing the common ones as readonly gives the typed path their shape.
      properties: new Map(
        [
          "href",
          "origin",
          "protocol",
          "username",
          "password",
          "host",
          "hostname",
          "port",
          "pathname",
          "search",
          "searchParams",
          "hash",
        ].map((p) => [p, { type: { kind: "externref" } as ValType, readonly: p === "origin" }]),
      ),
    });
  }

  if (!ctx.externClasses.has("URLSearchParams") && !ctx.nativeStrings) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("append", externMethod(2)); // append(name, value) → void
    methods.set("delete", externMethod(2, false)); // delete(name, value?) → void
    methods.set("get", externMethod(1)); // get(name) → string | null
    methods.set("getAll", externMethod(1)); // getAll(name) → string[]
    methods.set("has", externMethod(2)); // has(name, value?) → boolean
    methods.set("set", externMethod(2, false)); // set(name, value) → void
    methods.set("sort", externMethod(0, false)); // sort() → void
    methods.set("toString", externMethod(0)); // toString() → string
    methods.set("forEach", externMethod(1, false)); // forEach(cb) → void
    methods.set("entries", externMethod(0)); // entries() → Iterator
    methods.set("keys", externMethod(0)); // keys() → Iterator
    methods.set("values", externMethod(0)); // values() → Iterator
    ctx.externClasses.set("URLSearchParams", {
      importPrefix: "URLSearchParams",
      namespacePath: [],
      className: "URLSearchParams",
      constructorParams: [{ kind: "externref" }], // new URLSearchParams(init?)
      methods,
      properties: new Map([["size", { type: { kind: "externref" }, readonly: true }]]),
    });
  }

  // #1238 — synthetic ExternClassInfo for String and Array.
  //
  // String and Array are JS built-ins, not declared classes (`declare class
  // String { ... }` doesn't appear in user source — they're skipped by
  // `BUILTIN_SKIP` in `collectExternFromDeclareVar`). To let the IR's
  // `lowerMethodCall` / `lowerPropertyAccess` dispatch through the existing
  // extern-class registry path (instead of growing more hardcoded special
  // cases), we register pseudo-`ExternClassInfo` entries here. The
  // method/property metadata mirrors the legacy `STRING_METHODS` table
  // (`src/codegen/index.ts:3058`) and the array prototype-method dispatch
  // in `src/codegen/array-methods.ts`.
  //
  // **Why a separate `pseudoExternClasses` map?**
  // Putting String/Array directly into `ctx.externClasses` broke `new
  // Array(...)` / `new String(...)` because:
  //   - `collectUsedExternImports` (line ~6297) registers `${prefix}_new`
  //     for any `new ClassName()` whose className is in `ctx.externClasses`.
  //     With "Array" in the map, `new Array(10)` registered an `array_new`
  //     host import.
  //   - `compileNewExpression` (in `src/codegen/expressions/new-super.ts`,
  //     ~line 2193) dispatches via the externInfo branch BEFORE the inline
  //     `if (className === "Array")` vec-creation special case. So `new
  //     Array(10)` emitted `call $array_new` instead of the inline vec.
  //   - At runtime, `runtime.ts` couldn't find an `Array` constructor in
  //     its `builtinCtors` map (Number/String/Map/Set/RegExp/... but no
  //     Array — Array is a TypedArray-style built-in), throwing "No
  //     dependency provided for extern class 'Array'".
  // PR#149 caught this in CI as 152 wasm_compile regressions. Splitting
  // pseudo entries into a separate map keeps `ctx.externClasses` shaped
  // exactly as before — every existing consumer is unchanged. The pseudo
  // map is queried only by the new IR-side `resolveMethodDispatchTarget`
  // helper, which downstream slices (#1232, #1233) will route through.
  //
  // **MLIR seam alignment** (per #1231 Phase 2 design note): the registry
  // itself is a static table (this function is the entry point — no IR
  // node mutations, no ambient maps). Only the lookup will be TypeMap-
  // keyed when 1232/1233 wire it up via `resolveMethodDispatchTarget`.
  if (!ctx.pseudoExternClasses.has("String")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    // Mirror STRING_METHODS in src/codegen/index.ts:3058. The extern-class
    // method-signature shape is `[receiver, ...args] -> [result]`, so we
    // prepend an externref self-param to each signature. We restrict to
    // the methods listed in the #1238 spec (slice/charAt/charCodeAt/
    // indexOf/includes/toUpperCase/toLowerCase/trim) plus `length` as a
    // property — additional STRING_METHODS entries can be added as the
    // dispatch routing in #1232 covers them.
    const SELF: ValType = { kind: "externref" };
    const methodEntry = (
      params: readonly ValType[],
      result: ValType,
    ): {
      params: ValType[];
      results: ValType[];
      requiredParams: number;
    } => ({
      params: [SELF, ...params],
      results: [result],
      requiredParams: 1 + params.length,
    });
    methods.set("slice", methodEntry([{ kind: "f64" }, { kind: "f64" }], { kind: "externref" }));
    methods.set("charAt", methodEntry([{ kind: "f64" }], { kind: "externref" }));
    methods.set("charCodeAt", methodEntry([{ kind: "f64" }], { kind: "f64" }));
    methods.set("indexOf", methodEntry([{ kind: "externref" }, { kind: "externref" }], { kind: "f64" }));
    methods.set("includes", methodEntry([{ kind: "externref" }], { kind: "i32" }));
    methods.set("toUpperCase", methodEntry([], { kind: "externref" }));
    methods.set("toLowerCase", methodEntry([], { kind: "externref" }));
    methods.set("trim", methodEntry([], { kind: "externref" }));

    // String.length is f64-typed in JS engine semantics (Number, not
    // i32). Read-only — `(str).length = N` is a no-op in JS, but we
    // mark `readonly: true` so any future write attempts cleanly fall
    // back to legacy.
    const properties = new Map<string, { type: ValType; readonly: boolean }>();
    properties.set("length", { type: { kind: "f64" }, readonly: true });

    ctx.pseudoExternClasses.set("String", {
      importPrefix: "string", // matches the legacy `string_<method>` host imports
      namespacePath: [],
      className: "String",
      constructorParams: [{ kind: "externref" }], // new String(value) — accepts any
      methods,
      properties,
    });
  }

  if (!ctx.pseudoExternClasses.has("Array")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    // Array methods are parametric in the element type — the registry
    // here uses externref for value-shaped receivers and args, which is
    // correct for the JS-host fast path. The vec-specialised lowerings
    // (#1233) will inspect the actual vec element type at dispatch time
    // and route to the typed `vec.*` ops; this entry is the fallback
    // metadata the IR uses to recognise the method exists.
    const SELF: ValType = { kind: "externref" };
    const methodEntry = (
      params: readonly ValType[],
      result: ValType | null,
    ): { params: ValType[]; results: ValType[]; requiredParams: number } => ({
      params: [SELF, ...params],
      results: result === null ? [] : [result],
      requiredParams: 1 + params.length,
    });
    methods.set("push", methodEntry([{ kind: "externref" }], { kind: "f64" })); // returns new length
    methods.set("pop", methodEntry([], { kind: "externref" }));
    methods.set("indexOf", methodEntry([{ kind: "externref" }, { kind: "externref" }], { kind: "f64" }));
    methods.set("includes", methodEntry([{ kind: "externref" }], { kind: "i32" }));
    methods.set("slice", methodEntry([{ kind: "f64" }, { kind: "f64" }], { kind: "externref" }));
    methods.set("join", methodEntry([{ kind: "externref" }], { kind: "externref" }));
    // #1233 — concat: returns a new array. The fallback signature uses
    // externref for both the variadic items and the result; the IR's
    // existing dispatch falls through to the legacy `compileArrayConcat`
    // when needed, which handles the per-element-type splatting.
    methods.set("concat", methodEntry([{ kind: "externref" }], { kind: "externref" }));

    // Array.length — like String.length, f64-typed in JS engine
    // semantics. **Not** readonly (JS allows `arr.length = 0` to truncate),
    // but #1238 marks it read-only for now; the writable arm is a future
    // enhancement covered by #1233 if needed.
    const properties = new Map<string, { type: ValType; readonly: boolean }>();
    properties.set("length", { type: { kind: "f64" }, readonly: true });

    ctx.pseudoExternClasses.set("Array", {
      importPrefix: "array",
      namespacePath: [],
      className: "Array",
      constructorParams: [{ kind: "f64" }], // new Array(length)
      methods,
      properties,
    });
  }

  // Set Object as terminal parent for any extern class that has no parent
  for (const [className] of ctx.externClasses) {
    if (className !== "Object" && !ctx.externClassParent.has(className)) {
      ctx.externClassParent.set(className, "Object");
    }
  }
}

/**
 * #1238 — Look up a pseudo-extern-class entry by className. Returns
 * `undefined` when the className isn't registered as a pseudo-extern
 * class (i.e., it's either a real extern class — query
 * `ctx.externClasses` for those — or unknown).
 *
 * This is the canonical accessor for the synthetic String/Array
 * registry. Existing consumers of `ctx.externClasses` are intentionally
 * NOT updated to consult this map: the legacy `new ClassName()` /
 * extern-method dispatch paths must keep their existing behaviour for
 * String / Array (they're handled via inline special cases or
 * `__new_<name>` / `string_<method>` lowercase imports). The pseudo
 * registry is the IR-only seam, queried by #1232 (String dispatch) and
 * #1233 (Array dispatch).
 */
export function getPseudoExternClassInfo(ctx: CodegenContext, className: string): ExternClassInfo | undefined {
  return ctx.pseudoExternClasses.get(className);
}

/**
 * #1238 — TypeMap-keyed receiver-type → extern className lookup. Given an
 * `IrType` resolved from the propagator's `TypeMap`, return the className
 * of the matching synthetic extern class (or `null` if no match).
 *
 * This is the **MLIR-seam-friendly** dispatch helper: callers route
 * receiver IrTypes here instead of pattern-matching `atom.kind ===
 * "string"` inline. A future MLIR optimizer producing the same `IrType`
 * shape would hit the same lookup, unchanged.
 *
 * Returns:
 *   - `"String"` for `IrType.string` and `IrType.val<externref>`
 *     (the externref arm covers post-#1169i extern-tagged strings)
 *   - `"Array"` for `IrType.val<ref|ref_null>` whose typeIdx points at
 *     a registered vec type (callers must check via their vec resolver)
 *   - `null` for anything else (including primitives, classes, objects)
 *
 * Note: the array path is only metadata. Confirming the receiver IS a
 * vec (vs. a generic ref) requires the lowerer's vec resolver — this
 * helper just identifies the target className so the lowerer can pick
 * which extern entry to consult. Callers should pair this with
 * `getPseudoExternClassInfo(ctx, target)` to get the method metadata.
 */
export function resolveMethodDispatchTarget(t: import("../ir/nodes.js").IrType): "String" | "Array" | null {
  if (t.kind === "string") return "String";
  if (t.kind === "val") {
    const v = t.val;
    if (v.kind === "ref" || v.kind === "ref_null") {
      // Caller verifies via vec resolver — we just signal the candidate.
      return "Array";
    }
  }
  return null;
}

// ── Extern class collection ──────────────────────────────────────────

// #2520 — collect names that actually RESOLVE to an ambient (lib-declared)
// global in the given user source. Symbol resolution distinguishes a real
// reference to a global (e.g. `setTimeout(...)`) from a local variable or a
// property that merely shares the name — e.g. a local `let stop = …` must NOT
// pull in the DOM `window.stop` global, and `obj.close` must NOT pull in
// `close`. Used to gate the lib-file ambient-`declare function` scan so only
// genuinely-referenced globals register as host imports.
export function collectReferencedGlobalNames(
  userFiles: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
): Set<string> {
  const isLibFile = (sf: ts.SourceFile): boolean => {
    const bn = sf.fileName.split("/").pop() ?? sf.fileName;
    return bn.startsWith("lib.") && bn.endsWith(".d.ts");
  };
  // A genuine global reference resolves to an AMBIENT declaration: a lib
  // `declare function`, OR a `declare function` stub preprocessImports injects
  // into the user file (so `setTimeout` resolves to a user-file stub, not the
  // lib). A local `let stop` resolves to a plain VariableDeclaration → excluded,
  // so it can't pull in the same-named DOM global.
  const isAmbientGlobalDecl = (d: ts.Declaration): boolean =>
    isLibFile(d.getSourceFile()) || (ts.isFunctionDeclaration(d) && hasDeclareModifier(d) && !d.body);
  // #2509 — an identifier in property-NAME position (`obj.close`, or `NS.close`
  // in type position) merely SHARES a global's name; its symbol resolves to the
  // property/method (often a lib-file method like `EventSource.prototype.close`)
  // which `isAmbientGlobalDecl` mistakes for an ambient global, spuriously
  // pulling in `declare function close` under wasi/standalone. Exclude those
  // pure-name positions; only bare/computed value references gate the scan.
  const isPropertyNamePosition = (id: ts.Identifier): boolean => {
    const p = id.parent;
    return (ts.isPropertyAccessExpression(p) && p.name === id) || (ts.isQualifiedName(p) && p.right === id);
  };
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isPropertyNamePosition(node)) {
      const decls = checker.getSymbolAtLocation(node)?.getDeclarations();
      if (decls && decls.some(isAmbientGlobalDecl)) {
        names.add(node.text);
      }
    }
    forEachChild(node, visit);
  };
  for (const sf of userFiles) {
    for (const stmt of sf.statements) forEachChild(stmt, visit);
  }
  return names;
}

// #2696/#2632 — the fd0 stdin-reactor intrinsic names. The injected
// process.stdin Readable prelude declares these as `declare function` stubs;
// under `--target wasi` every call site is inline-lowered to poll_oneoff/fd_read
// (tryWasiTimerCall), so collectExternDeclarations must NOT re-register them as
// `env.*` host imports (which would only be dropped with a spurious warning).
const WASI_STDIN_REACTOR_INTRINSICS = new Set([
  "__wasiStdinReadByte",
  "__wasiStdinAvailable",
  "__wasiStdinEof",
  "__wasiStdinSetReader",
  // #2817 — `__wasiStdinStop` (added in #2735 for a NON-EOF reactor exit: it
  // drops the fd0 subscription so the run loop terminates on in-band shutdown /
  // `process.stdin.destroy()` / pre-`proc_exit`). Its every call site is
  // inline-lowered by `emitStdinStop` (async-scheduler.ts) via tryWasiTimerCall
  // — a native `global.set` clearing `__stdin_fd_active`, NO host import. The
  // sibling intrinsics above were already skipped; #2735 forgot to add this one,
  // so its prelude `declare function __wasiStdinStop` stub re-registered here as
  // a DEAD `env.__wasiStdinStop` host import (dropped from the binary, but
  // firing the spurious "not on the dual-mode allowlist" warning on the
  // otherwise-runnable standalone nm_js2wasm_node_process.ts build). Skip it.
  "__wasiStdinStop",
]);

// `libReferencedNames`, when provided (lib-file scan only), gates ambient
// `declare function` host-import registration to names the user references
// (#2520). User-file call sites omit it so preprocessImports stubs always
// register.
//
// `libIndex`, when provided (lib-file scan only, #4218), switches ALL type
// resolution in this pre-pass to the syntactic lib-decl index — zero
// `ctx.checker` queries. User-file call sites omit it and keep the checker
// (user `declare`s are input-driven and cheap; lib files were 96 % of the
// compiler's checker traffic).
export function collectExternDeclarations(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  libReferencedNames?: Set<string>,
  libIndex?: LibDeclIndex,
): void {
  for (const stmt of sourceFile.statements) {
    if (ts.isModuleDeclaration(stmt) && hasDeclareModifier(stmt)) {
      collectDeclareNamespace(ctx, stmt, [], libIndex);
    }
    // Top-level declare class (e.g. user-defined or import-resolver stubs)
    if (ts.isClassDeclaration(stmt) && stmt.name && hasDeclareModifier(stmt)) {
      collectExternClass(ctx, stmt, [], libIndex);
    }
    // Top-level declare function stubs — registered as Wasm imports so that calls
    // can pass arguments correctly (missing args get padded with default values).
    // These are generated by preprocessImports for named imports from unresolved
    // external modules, e.g. `import { foo } from "./x.js"` → `declare function foo(a0, a1): any`.
    // In WASI mode, skip node:fs functions — they're handled by WASI syscall helpers.
    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasDeclareModifier(stmt) && !stmt.body) {
      const name = stmt.name.text;
      // #2520 — when scanning the TS lib files (libReferencedNames provided),
      // only register an ambient `declare function` as an env host import if the
      // user source actually references it. Otherwise one lib-global reference
      // (Uint8Array/Date/…) drags in the whole ambient global-function surface
      // (~60: eval/alert/fetch/scroll/…), each then dropped by the allowlist
      // gate under --target wasi. User-file calls pass no set → always register.
      if (libReferencedNames && !libReferencedNames.has(name)) continue;
      // Skip node:fs functions — they're handled by dedicated dispatch:
      //   • WASI target → __wasi_*  syscall helpers (#1035)
      //   • non-WASI + allowFs → __node_fs_* JS-host imports (#1491)
      if (ctx.wasiNodeFsFuncs.has(name) && (ctx.wasi || ctx.allowFs)) continue;
      // #2696 — raw-WASI intrinsics (#2657): the `wasm:memory` accessors
      // (store32/load32/store8/load8) lower to INLINE memory ops and the
      // `wasi_snapshot_preview1` fd funcs (fd_read/fd_write) bind to the real
      // WASI import via registerWasiImports. preprocessImports rewrites BOTH
      // import forms into bare `declare function` stubs that lose their module
      // origin, so without this guard they would re-register here as `env.*`
      // host imports — spuriously firing the "not on the dual-mode allowlist"
      // drop warning on the clean nm_wasi.ts compile, and (on the npm/bun path,
      // where the stub survives) leaking an unsatisfiable `env.store32` import
      // that breaks wasmtime instantiation (loopdive/js2wasm#389 bug 1).
      // tryCompileRawWasiCall (raw-wasi-api.ts) already handles every call site,
      // so skip the stub entirely under `--target wasi`.
      // (#4238) `ctx.importMemory` is the second regime in which the
      // `wasm:memory` accessors lower inline (a peer module owns the memory,
      // this module imports it at index 0) — see raw-wasi-api.ts. Skip the
      // stub there too, or the accessor names would re-register as host
      // imports the peer cannot satisfy.
      if (ctx.wasi && (ctx.wasiMemAccessors.has(name) || ctx.wasiRawImports.has(name))) continue;
      if (ctx.importMemory !== undefined && ctx.wasiMemAccessors.has(name)) continue;
      // #2696 — the #2632 fd0 stdin-reactor intrinsics. The injected
      // process.stdin prelude (src/process-stdin-prelude.ts) declares these as
      // `declare function __wasiStdin*` stubs, but every call site is
      // inline-lowered to poll_oneoff/fd_read by tryWasiTimerCall (calls.ts) when
      // `ctx.wasi`. Registering them as `env.*` host imports here therefore only
      // leaks a spurious "not on the dual-mode allowlist" dropped-import warning
      // on the otherwise-runnable standalone nm_js2wasm_node_process.ts module
      // (loopdive/js2wasm#389 bug 2). Skip the stub under WASI.
      if (ctx.wasi && WASI_STDIN_REACTOR_INTRINSICS.has(name)) continue;
      // #1663: parseInt / parseFloat have no JS host under WASI / standalone —
      // skip the stub so the unified-collector finalize can emit the WasmGC
      // native scanners (registered under the same funcMap names) instead.
      //
      // (#3401) The URI globals (`decodeURI`/`decodeURIComponent`/`encodeURI`/
      // `encodeURIComponent`, native since #2500) and the legacy `escape`/
      // `unescape` (native since #3063/#3064) are in the SAME "has a standalone
      // native, must NOT register an env host import" family — but were missing
      // from this skip. When an unrelated builtin (`String.fromCharCode`, `new
      // Error`, …) pulls the URI name into `libReferencedNames`, this pass
      // registered `env::decodeURI` FIRST; the URI finalize (import-collector.ts)
      // then saw `funcMap.has(name)` and SKIPPED its native emit, so the call
      // site fell through to the leaked `env::*URI*` import — a host_import_leak
      // CE in standalone (#2961). Verified: 48 official `built-ins/{decode,
      // encode}URI*` tests. The context-dependence (only leaks when a sibling
      // builtin drags the name into the lib-referenced set) is why #2500 shipped
      // green on its own probes. Skip the stub here so the finalize owns the
      // native emit, exactly as parseInt/parseFloat do.
      if (
        (ctx.targetProfile.semanticProviders === "native-first" || ctx.wasi || ctx.standalone) &&
        (name === "parseInt" ||
          name === "parseFloat" ||
          name === "decodeURI" ||
          name === "decodeURIComponent" ||
          name === "encodeURI" ||
          name === "encodeURIComponent" ||
          name === "escape" ||
          name === "unescape")
      ) {
        continue;
      }
      // #3436: `structuredClone` has no host under WASI / standalone. The
      // universal test262 prelude's `$262.detachArrayBuffer` references the
      // ambient global (a `typeof structuredClone !== "function"` guard, then a
      // call), which would otherwise materialize an unsatisfiable
      // `env.structuredClone` host import — making EVERY standalone test262
      // module fail to instantiate (`unknown import`). Skip the stub: the global
      // stays undefined, so `typeof structuredClone` is "undefined" and the
      // shim's own guard throws the honest "unsupported by this host" error
      // (correct semantics — standalone has no structuredClone). Host mode still
      // registers the import so a real host can satisfy it.
      if ((ctx.wasi || ctx.standalone) && name === "structuredClone") continue;
      if (!ctx.funcMap.has(name)) {
        // (#4238) Under `externNativeTypes` an explicit native annotation
        // (`type i32 = number` & friends) wins over the default mapping, so
        // a peer-wasm binding can declare its REAL `(i32,i32,i32) -> i32`
        // signature and bind with no JS wrapper closure. Without the option
        // — every user compile — `nativeTypeFromTypeNode` is never consulted
        // and `number` keeps mapping to f64, byte-identical.
        const nativeOf = (node: ts.TypeNode | undefined): ValType | null =>
          ctx.externNativeTypes ? nativeTypeFromTypeNode(ctx.checker, node) : null;
        if (libIndex) {
          // (#4218) Syntactic path — lib declaration files are fully annotated.
          const scope = typeParamScopeOf(stmt);
          const params: ValType[] = stmt.parameters.map(
            (p) => nativeOf(p.type) ?? mapLibTypeNodeToWasm(p.type, libIndex, scope),
          );
          const results: ValType[] = isVoidTypeNode(stmt.type)
            ? []
            : [nativeOf(stmt.type) ?? mapLibTypeNodeToWasm(stmt.type, libIndex, scope)];
          const typeIdx = addFuncType(ctx, params, results);
          registerAmbientParseImport(ctx, sourceFile, name, typeIdx);
        } else {
          const sig = ctx.checker.getSignatureFromDeclaration(stmt);
          if (sig) {
            const params: ValType[] = stmt.parameters.map(
              (p) => nativeOf(p.type) ?? mapTsTypeToWasm(ctx.checker.getTypeAtLocation(p), ctx.checker),
            );
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            const results: ValType[] = isVoidType(retType)
              ? []
              : [nativeOf(stmt.type) ?? mapTsTypeToWasm(retType, ctx.checker)];
            const typeIdx = addFuncType(ctx, params, results);
            // (#4238) `externImportModule` retargets extern declarations at a
            // wasm-to-wasm provider namespace (`js2wasm:qjs`) instead of the
            // `env` JS-host module. Unset for every user compile.
            registerAmbientParseImport(ctx, sourceFile, name, typeIdx);
          }
        }
      }
    }
    // declare var X: { prototype: X; new(): X } (lib.dom.d.ts pattern)
    // declare var Date: DateConstructor (interface with new() pattern)
    if (ts.isVariableStatement(stmt) && hasDeclareModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!decl.name || !ts.isIdentifier(decl.name) || !decl.type) continue;
        // Inline type literal with construct signature
        if (ts.isTypeLiteralNode(decl.type) && decl.type.members.some((m) => ts.isConstructSignatureDeclaration(m))) {
          collectExternFromDeclareVar(ctx, decl, libIndex);
        }
        // Type reference to interface with construct signature (e.g. declare var Date: DateConstructor)
        // Skip types with built-in wasm handling (Array, primitives, etc.)
        else if (ts.isTypeReferenceNode(decl.type)) {
          const varName = decl.name.text;
          const BUILTIN_SKIP = new Set([
            "Array",
            "Number",
            "Boolean",
            "String",
            "Object",
            "Function",
            "Symbol",
            "BigInt",
            "Int8Array",
            "Uint8Array",
            "Int16Array",
            "Uint16Array",
            "Int32Array",
            "Uint32Array",
            "Float32Array",
            "Float64Array",
            "ArrayBuffer",
            "DataView",
            "JSON",
            "Math",
            "Error",
            "TypeError",
            "RangeError",
            "SyntaxError",
            "URIError",
            "EvalError",
            "ReferenceError",
            // Promise instance methods (.then/.catch/.finally) are handled by
            // dedicated Promise-specific codegen that registers 2-param late imports.
            // Registering Promise via collectExternFromDeclareVar causes the TypeScript
            // interface declaration (then(onfulfilled?, onrejected?)) to be collected
            // as a 3-param Wasm function, creating an arity mismatch with the 2-param
            // late imports used by the Promise-specific handler. (#966)
            "Promise",
          ]);
          if (!BUILTIN_SKIP.has(varName)) {
            const hasCtor = libIndex
              ? libConstructSignatures(typeRefName(decl.type.typeName), libIndex).length > 0
              : ctx.checker.getTypeAtLocation(decl.type).getConstructSignatures().length > 0;
            if (hasCtor) {
              collectExternFromDeclareVar(ctx, decl, libIndex);
            }
          }
        }
      }
    }
  }
}

function collectDeclareNamespace(
  ctx: CodegenContext,
  decl: ts.ModuleDeclaration,
  parentPath: string[],
  libIndex?: LibDeclIndex,
): void {
  const nsName = decl.name.text;
  const path = [...parentPath, nsName];

  if (decl.body && ts.isModuleBlock(decl.body)) {
    for (const stmt of decl.body.statements) {
      if (ts.isClassDeclaration(stmt) && stmt.name) {
        collectExternClass(ctx, stmt, path, libIndex);
      }
      if (ts.isModuleDeclaration(stmt)) {
        collectDeclareNamespace(ctx, stmt, path, libIndex);
      }
    }
  }
}

function collectExternClass(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration,
  namespacePath: string[],
  libIndex?: LibDeclIndex,
): void {
  const className = decl.name!.text;
  if (ERROR_TYPES_SKIP.has(className)) return;
  const prefix = [...namespacePath, className].join("_");

  const info: ExternClassInfo = {
    importPrefix: prefix,
    namespacePath,
    className,
    constructorParams: [],
    methods: new Map(),
    properties: new Map(),
  };

  // (#4218) Type resolution: syntactic through the lib index on the lib-file
  // scan, checker-based on the user path. Both produce identical ValTypes for
  // annotated declarations (see lib-decl-index.ts).
  const mapNode = (node: ts.TypeNode | undefined, scope: ReturnType<typeof typeParamScopeOf>): ValType =>
    libIndex ? mapLibTypeNodeToWasm(node, libIndex, scope) : { kind: "externref" };

  for (const member of decl.members) {
    if (ts.isConstructorDeclaration(member)) {
      for (const param of member.parameters) {
        info.constructorParams.push(
          libIndex
            ? mapNode(param.type, typeParamScopeOf(decl, member))
            : mapTsTypeToWasm(ctx.checker.getTypeAtLocation(param), ctx.checker),
        );
      }
    }
    if (ts.isMethodDeclaration(member) && member.name) {
      const methodName = (member.name as ts.Identifier).text;
      if (libIndex) {
        const scope = typeParamScopeOf(decl, member);
        const params: ValType[] = [{ kind: "externref" }]; // 'this'
        let requiredParams = 1;
        for (const p of member.parameters) {
          params.push(mapNode(p.type, scope));
          if (!p.questionToken && !p.initializer) requiredParams++;
        }
        const results: ValType[] = isVoidTypeNode(member.type) ? [] : [mapNode(member.type, scope)];
        info.methods.set(methodName, { params, results, requiredParams });
      } else {
        const sig = ctx.checker.getSignatureFromDeclaration(member);
        if (sig) {
          const params: ValType[] = [{ kind: "externref" }]; // 'this'
          let requiredParams = 1;
          for (const p of member.parameters) {
            const pt = ctx.checker.getTypeAtLocation(p);
            params.push(mapTsTypeToWasm(pt, ctx.checker));
            if (!p.questionToken && !p.initializer) requiredParams++;
          }
          const retType = ctx.checker.getReturnTypeOfSignature(sig);
          // (#2770, S5b) Brand a boolean extern-method result at registration so the
          // direct `methodInfo.results[0]` consumption path (extern.ts) is honest.
          const results: ValType[] = isVoidType(retType)
            ? []
            : [brandExternMethodResult(ctx, retType, mapTsTypeToWasm(retType, ctx.checker))];
          info.methods.set(methodName, { params, results, requiredParams });
        }
      }
    }
    if (ts.isPropertyDeclaration(member) && member.name) {
      const propName = (member.name as ts.Identifier).text;
      const wasmType = libIndex
        ? mapNode(member.type, typeParamScopeOf(decl))
        : mapTsTypeToWasm(ctx.checker.getTypeAtLocation(member), ctx.checker);
      const isReadonly = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false;
      info.properties.set(propName, { type: wasmType, readonly: isReadonly });
    }
  }

  // Record parent class for inheritance chain walk
  if (decl.heritageClauses) {
    for (const clause of decl.heritageClauses) {
      if (clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types[0]) {
        const baseName = libIndex
          ? heritageBaseName(clause.types[0])
          : ctx.checker.getTypeAtLocation(clause.types[0]).getSymbol()?.name;
        if (baseName) ctx.externClassParent.set(className, baseName);
      }
    }
  }

  ctx.externClasses.set(className, info);
  // Also register with full qualified name
  const fullName = [...namespacePath, className].join(".");
  ctx.externClasses.set(fullName, info);
}

/** Types handled natively — skip extern class registration */
const ERROR_TYPES_SKIP = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  "Date",
]);

/** Collect extern class info from a `declare var X: { prototype: X; new(): X }` (lib.dom.d.ts pattern) */
function collectExternFromDeclareVar(ctx: CodegenContext, decl: ts.VariableDeclaration, libIndex?: LibDeclIndex): void {
  const className = (decl.name as ts.Identifier).text;
  if (ERROR_TYPES_SKIP.has(className)) return;
  // (#1103a) In standalone / nativeStrings mode, `Map` is served by the
  // WasmGC-native runtime (map-runtime.ts) intercepted at the call sites.
  // Skip registering it as an externClass from the lib `declare var Map`
  // declaration — otherwise the extern-class import registration eagerly
  // emits a `Map_new` host import the standalone module can't satisfy.
  if (className === "Map" && ctx.nativeStrings) return;
  if (ctx.externClasses.has(className)) return;

  // (#4218) Lib path: the merged `interface <className>` declarations come
  // from the name-keyed index (same program order the checker's merged
  // symbol reports). User path: resolve the symbol via the checker.
  let ifaceDecls: readonly ts.Declaration[];
  if (libIndex) {
    ifaceDecls = libIndex.interfaces.get(className) ?? [];
  } else {
    const symbol = ctx.checker.getSymbolAtLocation(decl.name);
    if (!symbol) return;
    ifaceDecls = symbol.getDeclarations() ?? [];
  }

  const info: ExternClassInfo = {
    importPrefix: className,
    namespacePath: [],
    className,
    constructorParams: [],
    methods: new Map(),
    properties: new Map(),
  };

  // Extract constructor params from the construct signature
  if (decl.type) {
    if (ts.isTypeLiteralNode(decl.type)) {
      for (const member of decl.type.members) {
        if (ts.isConstructSignatureDeclaration(member)) {
          for (const param of member.parameters) {
            info.constructorParams.push(
              libIndex
                ? mapLibTypeNodeToWasm(param.type, libIndex, typeParamScopeOf(member))
                : mapTsTypeToWasm(ctx.checker.getTypeAtLocation(param), ctx.checker),
            );
          }
          break;
        }
      }
    } else if (ts.isTypeReferenceNode(decl.type)) {
      // Resolve interface reference (e.g. DateConstructor, RegExpConstructor).
      // Use the constructor with the most parameters so all overloads can be
      // served.  Missing args at call sites are padded with defaults.
      if (libIndex) {
        const constructSigs = libConstructSignatures(typeRefName(decl.type.typeName), libIndex);
        const sig =
          constructSigs.length > 0
            ? constructSigs.reduce((a, b) => (b.parameters.length > a.parameters.length ? b : a))
            : undefined;
        if (sig) {
          for (const param of sig.parameters) {
            info.constructorParams.push(mapLibTypeNodeToWasm(param.type, libIndex, typeParamScopeOf(sig)));
          }
        }
      } else {
        const refType = ctx.checker.getTypeAtLocation(decl.type);
        const constructSigs = refType.getConstructSignatures();
        const sig =
          constructSigs.length > 0
            ? constructSigs.reduce((a, b) => (b.parameters.length > a.parameters.length ? b : a))
            : undefined;
        if (sig) {
          for (const param of sig.parameters) {
            const paramType = ctx.checker.getTypeOfSymbol(param);
            info.constructorParams.push(mapTsTypeToWasm(paramType, ctx.checker));
          }
        }
      }
    }
  }

  // Collect members from own interface declarations + non-extern mixin interfaces
  const visited = new Set<string>();
  for (const d of ifaceDecls) {
    if (!ts.isInterfaceDeclaration(d)) continue;
    // Collect own members
    collectInterfaceMembers(ctx, d, info, decl, libIndex);
    // Walk extends: first extern parent → inheritance chain, non-extern → collect their members
    if (d.heritageClauses) {
      let parentSet = false;
      for (const clause of d.heritageClauses) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const typeRef of clause.types) {
          if (libIndex) {
            const baseName = heritageBaseName(typeRef);
            if (!baseName) continue;
            if (!parentSet && !ctx.externClassParent.has(className)) {
              ctx.externClassParent.set(className, baseName);
              parentSet = true;
            }
            if (!isExternDeclaredLibName(baseName, libIndex)) {
              collectMixinMembersLib(ctx, baseName, info, decl, visited, libIndex);
            }
          } else {
            const baseType = ctx.checker.getTypeAtLocation(typeRef);
            const baseName = baseType.getSymbol()?.name;
            if (!baseName) continue;
            if (!parentSet && !ctx.externClassParent.has(className)) {
              // First extends type → record as parent for inheritance chain
              ctx.externClassParent.set(className, baseName);
              parentSet = true;
            }
            // If this base is NOT an extern class, it's a mixin — collect its members
            if (!isExternalDeclaredClass(baseType, ctx.checker)) {
              collectMixinMembers(ctx, baseType, info, decl, visited);
            }
          }
        }
      }
    }
  }

  ctx.externClasses.set(className, info);
}

/** Collect methods and properties from an interface declaration */
function collectInterfaceMembers(
  ctx: CodegenContext,
  iface: ts.InterfaceDeclaration,
  info: ExternClassInfo,
  locationNode: ts.Node,
  libIndex?: LibDeclIndex,
): void {
  for (const member of iface.members) {
    // Method signatures
    if (ts.isMethodSignature(member) && member.name && ts.isIdentifier(member.name)) {
      const methodName = member.name.text;
      if (info.methods.has(methodName)) continue;
      if (libIndex) {
        // (#4218) Syntactic path — declared annotations only, no checker.
        // Boolean results are already branded by mapLibTypeNodeToWasm
        // (mirroring mapTsTypeToWasm), so no separate branding step is needed.
        const scope = typeParamScopeOf(iface, member);
        const params: ValType[] = [{ kind: "externref" }];
        let requiredParams = 1;
        for (const p of member.parameters) {
          params.push(mapLibTypeNodeToWasm(p.type, libIndex, scope));
          if (!p.questionToken && !p.initializer) requiredParams++;
        }
        const results: ValType[] = isVoidTypeNode(member.type)
          ? []
          : [mapLibTypeNodeToWasm(member.type, libIndex, scope)];
        info.methods.set(methodName, { params, results, requiredParams });
      } else {
        const sig = ctx.checker.getSignatureFromDeclaration(member);
        if (sig) {
          const params: ValType[] = [{ kind: "externref" }];
          let requiredParams = 1;
          for (const p of member.parameters) {
            const pt = ctx.checker.getTypeAtLocation(p);
            params.push(mapTsTypeToWasm(pt, ctx.checker));
            if (!p.questionToken && !p.initializer) requiredParams++;
          }
          const retType = ctx.checker.getReturnTypeOfSignature(sig);
          // (#2770, S5b) Brand a boolean extern-method result at registration so the
          // direct `methodInfo.results[0]` consumption path (extern.ts) is honest.
          const results: ValType[] = isVoidType(retType)
            ? []
            : [brandExternMethodResult(ctx, retType, mapTsTypeToWasm(retType, ctx.checker))];
          info.methods.set(methodName, { params, results, requiredParams });
        }
      }
    }
    // Property signatures
    if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
      const propName = member.name.text;
      if (info.properties.has(propName)) continue;
      let wasmType = libIndex
        ? mapLibTypeNodeToWasm(member.type, libIndex, typeParamScopeOf(iface))
        : mapTsTypeToWasm(ctx.checker.getTypeAtLocation(member), ctx.checker);
      // (#2671) `RegExp.lastIndex` is a value-preserving data slot: §22.2.7.2
      // RegExpBuiltinExec reads it via `ToLength(? Get(R, "lastIndex"))` at exec
      // time — the spec stores whatever was assigned verbatim and coerces only
      // inside exec (writing back only when the regex is global/sticky). Typing
      // the field `number` makes the host import eagerly ToNumber the assigned
      // value: an opaque WasmGC struct (`r.lastIndex = {valueOf(){…}}`) is
      // unconvertible to V8 ("Cannot convert object to primitive value"), so the
      // subsequent `exec` throws instead of firing the object's `valueOf` once.
      // Carry the slot as `externref` in host mode so the raw value round-trips
      // through the native RegExp; numeric uses coerce at the use site, and the
      // exec-time ToLength is performed by native code. Standalone / WASI keep
      // their native struct-field RegExp path (the `RegExp_*_lastIndex` extern
      // import is never emitted there), so only true host mode is retyped.
      if (info.className === "RegExp" && propName === "lastIndex" && !ctx.standalone && !ctx.wasi) {
        wasmType = { kind: "externref" };
      }
      // (#3051 Slice 2) `RegExp.prototype.global` / `.unicode` are spec-readonly
      // booleans, but test262's @@replace/@@split coercion tests redefine them as
      // writable data properties (`Object.defineProperty(r,'global',{writable:true})`)
      // and then assign arbitrary values (`r.global = Symbol.replace`, `= {}`,
      // `= NaN`, …). §22.2.6.11/§22.2.6.14 read the flag back through
      // `ToBoolean(? Get(rx, "global"|"unicode"))` — i.e. any value coerces at
      // read time, it is NOT constrained to a boolean on write. Typing the extern
      // property `boolean` makes the generated `RegExp_set_global(externref, i32)`
      // setter eagerly ToNumber the assigned value: a Symbol RHS traps ("Cannot
      // convert a Symbol value to a number") and an object RHS traps ("Cannot
      // convert object to primitive value") at the wasm boundary, before the value
      // is ever stored. Carry the slot as `externref` in host mode (mirroring the
      // #2671 `lastIndex` treatment) so the raw value round-trips onto the native
      // RegExp and the native @@replace/@@split protocol performs the spec
      // ToBoolean itself; explicit `r.global` reads coerce externref→boolean at the
      // use site (a boxed `false` unboxes correctly — see the Slice 2 controls).
      // Standalone / WASI keep their native struct-field RegExp path (the
      // `RegExp_*_global` extern import is never emitted there), so only host mode
      // is retyped.
      if (
        info.className === "RegExp" &&
        (propName === "global" || propName === "unicode") &&
        !ctx.standalone &&
        !ctx.wasi
      ) {
        wasmType = { kind: "externref" };
      }
      const isReadonly = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false;
      info.properties.set(propName, { type: wasmType, readonly: isReadonly });
    }
    // Getter accessors (e.g. `get style(): CSSStyleDeclaration`)
    if (ts.isGetAccessorDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      const propName = member.name.text;
      if (info.properties.has(propName)) continue;
      const wasmType = libIndex
        ? mapLibTypeNodeToWasm(member.type, libIndex, typeParamScopeOf(iface, member))
        : mapTsTypeToWasm(ctx.checker.getTypeAtLocation(member), ctx.checker);
      // Check if there's a matching setter
      const hasSetter = iface.members.some(
        (m) => ts.isSetAccessorDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === propName,
      );
      info.properties.set(propName, { type: wasmType, readonly: !hasSetter });
    }
  }
}

/** Recursively collect members from non-extern mixin interfaces */
function collectMixinMembers(
  ctx: CodegenContext,
  mixinType: ts.Type,
  info: ExternClassInfo,
  locationNode: ts.Node,
  visited: Set<string>,
): void {
  const mixinSymbol = mixinType.getSymbol();
  if (!mixinSymbol) return;
  const mixinName = mixinSymbol.name;
  if (visited.has(mixinName)) return;
  visited.add(mixinName);

  for (const d of mixinSymbol.getDeclarations() ?? []) {
    if (!ts.isInterfaceDeclaration(d)) continue;
    collectInterfaceMembers(ctx, d, info, locationNode);
    // Also walk this mixin's extends (for deeply nested mixins)
    if (d.heritageClauses) {
      for (const clause of d.heritageClauses) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const typeRef of clause.types) {
          const baseType = ctx.checker.getTypeAtLocation(typeRef);
          if (!isExternalDeclaredClass(baseType, ctx.checker)) {
            collectMixinMembers(ctx, baseType, info, locationNode, visited);
          }
        }
      }
    }
  }
}

/** (#4218) Syntactic twin of {@link collectMixinMembers}: recurse through the
 * merged interface declarations of a non-extern mixin by NAME via the lib
 * index — no checker. Same visited-set and traversal order. */
function collectMixinMembersLib(
  ctx: CodegenContext,
  mixinName: string,
  info: ExternClassInfo,
  locationNode: ts.Node,
  visited: Set<string>,
  libIndex: LibDeclIndex,
): void {
  if (visited.has(mixinName)) return;
  visited.add(mixinName);

  for (const d of libIndex.interfaces.get(mixinName) ?? []) {
    collectInterfaceMembers(ctx, d, info, locationNode, libIndex);
    // Also walk this mixin's extends (for deeply nested mixins)
    if (d.heritageClauses) {
      for (const clause of d.heritageClauses) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const typeRef of clause.types) {
          const baseName = heritageBaseName(typeRef);
          if (baseName && !isExternDeclaredLibName(baseName, libIndex)) {
            collectMixinMembersLib(ctx, baseName, info, locationNode, visited, libIndex);
          }
        }
      }
    }
  }
}

// ── Declared globals (e.g. declare const document: Document) ────────

export function collectDeclaredGlobals(
  ctx: CodegenContext,
  libFile: ts.SourceFile,
  userFile: ts.SourceFile,
  libIndex?: LibDeclIndex,
): void {
  // First collect identifiers referenced in user source
  const referencedNames = new Set<string>();
  // #2520 — also track names used as a VALUE (vs. a pure call/new callee or a
  // type-position reference). Only a value use actually needs the reified host
  // constructor object (`global_<Ctor>`); `new Uint8Array(4)` does not, so it
  // must not register it.
  //
  // A property-access RECEIVER (`Date.parse`, `Date.hasOwnProperty(...)`,
  // `Uint8Array.from(...)`) IS a value use: the static methods/props the
  // compiler intercepts (`Date.now`, `Array.isArray`, `Uint8Array.from`, …) are
  // resolved BEFORE identifier resolution at the property-access site, so for
  // those the registered global is simply an unused import the fast path
  // bypasses — harmless. But for any NON-intercepted static prop (`Date.parse`,
  // `Date.prototype`, `Date.hasOwnProperty`, `X.length`, `X.constructor`) the
  // bare receiver `X` must resolve to the host constructor object, which needs
  // `global_X`. Excluding the receiver dropped that global and broke e.g.
  // `Date.hasOwnProperty("prototype")` (→ null receiver, assert fails). So a
  // receiver counts as a value use; only the call/new callee, the property NAME
  // (`obj.Date`), and type positions are excluded.
  const valueRefNames = new Set<string>();
  const isBareValueUse = (id: ts.Identifier): boolean => {
    const p = id.parent;
    if ((ts.isNewExpression(p) || ts.isCallExpression(p)) && p.expression === id) return false;
    // Property NAME (`obj.Date`) is a key, not a value reference; the RECEIVER
    // (`Date.member`) is a value use and must NOT be excluded.
    if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
    // Type-annotation position (`buf: Uint8Array`, `Uint8Array | ArrayBuffer`,
    // `typeof X`) is not a value use of the constructor.
    if (ts.isTypeReferenceNode(p) && p.typeName === id) return false;
    if (ts.isTypeQueryNode(p) && p.exprName === id) return false;
    return true;
  };
  const collectRefs = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      referencedNames.add(node.text);
      if (isBareValueUse(node)) valueRefNames.add(node.text);
    }
    forEachChild(node, collectRefs);
  };
  for (const stmt of userFile.statements) {
    forEachChild(stmt, collectRefs);
  }

  for (const stmt of libFile.statements) {
    if (!ts.isVariableStatement(stmt) || !hasDeclareModifier(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const name = decl.name.text;
      if (!referencedNames.has(name)) continue; // only register used globals
      if (ctx.declaredGlobals.has(name)) continue;
      // (#4218) Extern-class classification + declared-type class name:
      // syntactic on the lib path (`declare var document: Document` → the
      // TypeReference target's lib declarations), checker-based otherwise.
      let isExternClassGlobal: boolean;
      let declaredClassName: string | undefined;
      if (libIndex) {
        // Resolve alias-typed globals (`parent: WindowProxy`) to the aliased
        // class name — the checker's symbol reports the target ("Window").
        declaredClassName =
          decl.type && ts.isTypeReferenceNode(decl.type)
            ? resolveLibTypeName(typeRefName(decl.type.typeName), libIndex)
            : undefined;
        isExternClassGlobal = declaredClassName !== undefined && isExternDeclaredLibName(declaredClassName, libIndex);
      } else {
        const type = ctx.checker.getTypeAtLocation(decl);
        isExternClassGlobal = isExternalDeclaredClass(type, ctx.checker);
        declaredClassName = type.getSymbol()?.name;
      }
      // `window` is declared by lib.dom as `Window & typeof globalThis`, so
      // its intersection type has no single external-class symbol even though
      // it is a real ambient host value. The same rule applies to the other
      // browser-only ambient variables below. Register those by their proven
      // lib declaration/name; otherwise a bare `window.event` read silently
      // lowers to `ref.null` (ReactDOM's update-priority path).
      if (!isExternClassGlobal && !DOM_ONLY_GLOBALS.has(name)) continue;
      // #2907 — under no-JS-host mode (standalone as well as
      // strictNoHostImports/wasi) there is no host to satisfy
      // `env.global_<Name>`. `TypeError`, `Error`, `RegExp`, `Reflect`, the
      // *Error subtypes etc. are NOT in `BUILTIN_TYPES`, so they reach here via
      // `isExternalDeclaredClass` and leaked a `global_<Name>` host import in
      // standalone — the ambient-ctor loop below already skips under strict mode
      // (#2696) but this earlier declared-globals loop had no such guard. A bare
      // value use of the global (the harness `expectedError = TypeError` idiom,
      // an array literal `[TypeError, RangeError]`, `Object.getPrototypeOf(Reflect)`)
      // was the sole standalone blocker for a large cluster. `instanceof`/`new`
      // are resolved BEFORE identifier resolution (static builtin-tag registry in
      // builtin-tags.ts / `new`-callee interception), so dropping the host value
      // binding here only affects genuine bare-value uses, which fall through to
      // the native-namespace carrier (identifiers.ts:emitBuiltinNamespaceObject)
      // or the `ref.null.extern` graceful default. Host/gc mode is unchanged.
      const certifiedStandaloneDocument =
        ctx.standalone && ctx.requiresStandaloneDomCapability === true && name === "document";
      if (ctx.strictNoHostImports || (ctx.standalone && !certifiedStandaloneDocument)) continue;
      const importName = `global_${name}`;
      const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
      addImport(ctx, "env", importName, { kind: "func", typeIdx });
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx !== undefined) {
        // (#2856) Record the extern class of the global's declared type so
        // the IR host-extern path can type the `call global_<name>` handle
        // as `IrType.extern { className }` and dispatch member access on it.
        ctx.declaredGlobals.set(name, { type: { kind: "externref" }, funcIdx, className: declaredClassName });
      }
    }
  }

  // #1065 — Register ambient builtin constructors (Array, Object, Function, ...)
  // as declared globals when referenced in source. These are filtered out of
  // isExternalDeclaredClass because they have Wasm-native fast paths (vec
  // structs, tuples, etc.), but they ALSO need to resolve to the real host
  // constructor when used in identity-compare positions (`x.constructor === Array`).
  // The fast paths at call sites (`new Array(n)`, `Array.of`, `Array.prototype`,
  // `Array.isArray`) intercept BEFORE identifier resolution, so adding the
  // global only affects bare-identifier uses.
  const AMBIENT_BUILTIN_CTORS = [
    "Array",
    "Object",
    "Function",
    "Number",
    "String",
    "Boolean",
    "Symbol",
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "ReferenceError",
    // (#4394) The remaining NativeError subtypes plus AggregateError. They were
    // missing here while their five siblings above were listed, so a bare value
    // use lowered to `ref.null.extern` and every identity comparison against
    // them silently answered `false` — including the `thrown.constructor !==
    // expectedErrorConstructor` test at the heart of `assert.throws`, which then
    // dereferenced the null constructor. `new EvalError()` was always a real
    // host EvalError; only the bare-identifier read was null.
    "EvalError",
    "URIError",
    "AggregateError",
    // (#4394) Same omission for the non-Error ambient constructors/namespaces
    // that also carry native fast paths at their call sites.
    "BigInt",
    "Proxy",
    "SharedArrayBuffer",
    "Atomics",
    "Date",
    "RegExp",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Promise",
    "Math",
    "JSON",
    "Reflect",
    "ArrayBuffer",
    "DataView",
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
  ];
  for (const name of AMBIENT_BUILTIN_CTORS) {
    // #2520 — only when the constructor is used as a bare value/identity; a
    // plain `new Uint8Array(4)` / `Uint8Array.from(...)` is intercepted by the
    // native fast paths and needs no host constructor object.
    if (!valueRefNames.has(name)) continue;
    if (ctx.declaredGlobals.has(name)) continue;
    // #2696 — under strict-no-host-imports (auto-on for --target wasi) there is
    // no JS host to satisfy `env.global_<Ctor>`, so addImport would drop it AND,
    // because the dropped import leaves no funcMap entry, the
    // `declaredGlobals.set` below never fires either — the whole registration is
    // already a no-op EXCEPT for the spurious "not on the dual-mode allowlist"
    // warning it emits. nm_js2wasm_node_process.ts trips this via the
    // `String.fromCharCode` receiver in the injected process.stdin prelude
    // (loopdive/js2wasm#389 bug 2: `env.global_String`). Skip it so the standalone
    // module compiles cleanly; bare identity uses already had no host global
    // under strict mode, so behavior is unchanged.
    // #2907 — `ctx.standalone` is a SEPARATE flag from `strictNoHostImports`
    // (create-context.ts: strictNoHostImports defaults to `wasi`, NOT
    // `standalone`), so the guard above missed `--target standalone`. A bare
    // value use of an ambient ctor there (`[Int8Array, Uint8Array, …].forEach`,
    // `expectedError = TypeError`) leaked `env.global_<Ctor>` with no host to
    // satisfy it. Include `ctx.standalone` so standalone stops leaking the host
    // constructor object; bare-value uses fall through to the native carrier /
    // ref.null.extern default exactly as under wasi.
    if (ctx.strictNoHostImports || ctx.standalone) continue;
    const importName = `global_${name}`;
    const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
    addImport(ctx, "env", importName, { kind: "func", typeIdx });
    const funcIdx = ctx.funcMap.get(importName);
    if (funcIdx !== undefined) {
      ctx.declaredGlobals.set(name, { type: { kind: "externref" }, funcIdx });
    }
  }
}

/**
 * DOM-only globals that require a browser host and are not available in WASI.
 * Used to emit a compile error when `--target wasi` is combined with DOM usage.
 */
const DOM_ONLY_GLOBALS = new Set([
  "document",
  "window",
  "navigator",
  "location",
  "history",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "EventTarget",
  "DocumentFragment",
  "Text",
  "Comment",
  "requestAnimationFrame",
  "cancelAnimationFrame",
]);

// Named node:fs bindings the WASI compiler deliberately owns: fd/file writes
// lower in-module, while known path-based calls reach the precise no-provider
// gate. Keep this exact; an arbitrary name would otherwise disappear after
// import preprocessing (#4565 review).
const WASI_HANDLED_NODE_FS_MEMBERS = new Set(["readSync", "writeSync", "writeFileSync", ...FS_PATH_BASED_MEMBERS]);

/**
 * Register Node.js builtin module imports as externref host imports (#1044).
 *
 * For each detected `import * as X from 'node:http'` (or named/default import),
 * we register a function import `__node_<module>` that returns the module object
 * as externref. The local binding name is added to `declaredGlobals` so that
 * identifier resolution in expressions picks it up via the existing extern path.
 *
 * In WASI mode, emit a compile error instead (Node builtins not available).
 */
export function registerNodeBuiltinImports(ctx: CodegenContext, builtins: NodeBuiltinImport[]): void {
  for (const builtin of builtins) {
    if (ctx.wasi) {
      // `node:process` is a compile-time API surface for WASI: import
      // preprocessing leaves a type-level `process` binding in the AST and
      // node-fs-api.ts lowers supported stream calls directly to WASI.
      if (builtin.moduleName === "process") continue;
      // `node:fs` is a compile-time API surface only when every named binding
      // is either lowered by WASI or owned by the precise no-provider call-site
      // gate. Imports are stripped by preprocessing, so failing open here would
      // turn unknown calls into silent no-ops.
      if (
        builtin.moduleName === "fs" &&
        !ctx.wasiNodeFsFuncs.has(WASI_NODE_FS_ALIAS_SENTINEL) &&
        builtin.namedBindings !== undefined &&
        builtin.namedBindings.length > 0 &&
        builtin.namedBindings.every((name) => WASI_HANDLED_NODE_FS_MEMBERS.has(name))
      ) {
        continue;
      }
      ctx.errors.push({
        message: `Node builtin module '${builtin.moduleName}' is not available in WASI target. Use compile-time syscall path for node:fs (#1035).`,
        line: 1,
        column: 1,
        severity: "error",
      });
      continue;
    }

    // Track this module as a Node builtin so the import manifest/runtime can resolve it
    ctx.mod.nodeBuiltinModules.add(builtin.moduleName);

    const importName = `__node_${builtin.moduleName}`;
    // Emit one host import per module; bind every graph alias to its shared thunk.
    if (!ctx.funcMap.has(importName)) {
      const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
      addImport(ctx, "env", importName, { kind: "func", typeIdx });
    }
    const funcIdx = ctx.funcMap.get(importName);
    if (funcIdx !== undefined) {
      // Register as a declared global so identifier resolution picks it up
      ctx.declaredGlobals.set(builtin.localName, { type: { kind: "externref" }, funcIdx });
      ctx.nodeBuiltinGlobals.set(builtin.localName, funcIdx);
    }
  }
}

/**
 * Register JSX runtime imports detected by preprocessImports (#1540).
 *
 * Wires three host-import shapes:
 *   - `__jsx_runtime_jsx` / `__jsx_runtime_jsxs`: `(externref, externref,
 *     externref) -> externref` — called by the JSX call-site intercept in
 *     `expressions/calls.ts`.
 *   - `__jsx_runtime_Fragment`: `() -> externref` — exposed as a declared
 *     global under the user's `localFragment` name, so identifier
 *     resolution sees it like a normal externref.
 *   - `__jsx_runtime_jsxDEV` (when present): same shape as `jsx`/`jsxs`
 *     with three extra throwaway args we ignore in v1.
 *
 * In WASI mode we still register the imports (the standalone-target
 * Wasm-native VDOM path is a follow-up); the user is expected to provide
 * `deps.jsxRuntime` or accept the built-in React-shaped fallback.
 *
 * `ctx.mod.jsxImportSource` is set so the import-manifest classifier can
 * carry the specifier through to `resolveImport`.
 */
export function registerJsxRuntimeImports(
  ctx: CodegenContext,
  jsxRuntime: import("../import-resolver.js").JsxRuntimeImport,
): void {
  ctx.mod.jsxImportSource = jsxRuntime.specifier;
  ctx.jsxRuntime = jsxRuntime;
  const ext: ValType = { kind: "externref" };

  const callableShapes: { method: "jsx" | "jsxs" | "jsxDEV"; local: string | undefined; arity: number }[] = [
    { method: "jsx", local: jsxRuntime.localJsx, arity: 3 },
    { method: "jsxs", local: jsxRuntime.localJsxs, arity: 3 },
    // jsxDEV takes extra (isStatic, source, self) args. We accept up to 6
    // and ignore the trailing three at the host binding side.
    { method: "jsxDEV", local: jsxRuntime.localJsxDev, arity: 6 },
  ];
  for (const { method, local, arity } of callableShapes) {
    if (!local) continue;
    const importName = `__jsx_runtime_${method}`;
    if (ctx.funcMap.has(importName)) continue;
    const params: ValType[] = Array.from({ length: arity }, () => ext);
    const typeIdx = addFuncType(ctx, params, [ext]);
    addImport(ctx, "env", importName, { kind: "func", typeIdx });
  }

  // Fragment is an externref-returning thunk so identity comparisons work
  // (the host binding caches a single Symbol). Surface it as a declared
  // global so identifier resolution picks it up.
  if (jsxRuntime.localFragment) {
    const importName = `__jsx_runtime_Fragment`;
    if (!ctx.funcMap.has(importName)) {
      const typeIdx = addFuncType(ctx, [], [ext]);
      addImport(ctx, "env", importName, { kind: "func", typeIdx });
    }
    const funcIdx = ctx.funcMap.get(importName);
    if (funcIdx !== undefined) {
      ctx.declaredGlobals.set(jsxRuntime.localFragment, { type: { kind: "externref" }, funcIdx });
      ctx.nodeBuiltinGlobals.set(jsxRuntime.localFragment, funcIdx);
    }
  }
}

/** Check if source code references DOM globals (document, window) */
const LIB_GLOBALS = new Set([
  "document",
  "window",
  "Date",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "RegExp",
  "Error",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  // #1065 — ambient builtin constructors that need host-global resolution
  // for bare-identifier uses (e.g. `x.constructor === Array`). Call-site
  // fast paths intercept before identifier resolution runs.
  "Array",
  "Object",
  "Function",
  "Number",
  "String",
  "Boolean",
  "Symbol",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  // (#4394) Kept in step with AMBIENT_BUILTIN_CTORS — this gate decides whether
  // `collectDeclaredGlobals` runs at all, so a name missing here is never even
  // offered to that loop. A module referencing ONLY `EvalError` skipped the
  // whole pass and the bare read fell to `ref.null.extern`.
  "EvalError",
  "URIError",
  "AggregateError",
  "BigInt",
  "Proxy",
  "SharedArrayBuffer",
  "Atomics",
  // #1018 — additional builtins whose .prototype access needs host resolution
  "Promise",
  "Math",
  "JSON",
  "Reflect",
  "ArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

export function sourceUsesLibGlobals(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && LIB_GLOBALS.has(node.text)) {
      found = true;
      return;
    }
    // RegExp literals (/pattern/flags) implicitly use the RegExp extern class
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  for (const stmt of sourceFile.statements) {
    forEachChild(stmt, visit);
    if (found) break;
  }
  return found;
}

/**
 * In WASI mode, scan source for DOM-only globals and report compile errors.
 * DOM globals require a browser host and are not available in standalone Wasm.
 */
export function checkWasiDomUsage(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && DOM_ONLY_GLOBALS.has(node.text)) {
      if (!found.has(node.text)) {
        found.add(node.text);
        reportError(
          ctx,
          node,
          `Codegen error: DOM global '${node.text}' is not available in WASI target — DOM requires a browser host`,
        );
      }
    }
    forEachChild(node, visit);
  };
  for (const stmt of sourceFile.statements) {
    forEachChild(stmt, visit);
  }
}

/**
 * Timer / event-loop globals that have no equivalent in standalone WASI.
 * Reported as compile-time errors under `--target wasi` so users do not get
 * silent runtime hangs or `unknown import` instantiation failures (#1484).
 *
 * NOTE: `requestAnimationFrame` / `cancelAnimationFrame` are already covered
 * by DOM_ONLY_GLOBALS above, so they are not duplicated here.
 */
// #2632 Phase 1 — setTimeout/setInterval/clearTimeout/clearInterval and
// queueMicrotask are now LOWERED onto the timer-heap + run-loop reactor under
// --target wasi (see ensureTimerHeap / emitTimerAdd). Only `setImmediate`
// remains rejected: its Node "check phase" ordering (after I/O poll, distinct
// from a 0ms timer) is a later-phase concern not modelled by the Phase-1 loop.
const WASI_REJECTED_TIMER_GLOBALS = new Set(["setImmediate"]);

/**
 * In WASI mode, scan source for timer / event-loop globals (setTimeout etc.)
 * and emit compile errors. WASI has no event loop, so these would either
 * silently no-op (if shimmed) or fail to instantiate (env::setTimeout import
 * unresolved). See #1484. The poll_oneoff-based `__wasi_sleep_ms` helper
 * provides a synchronous-sleep building block but does not (yet) wire into
 * setTimeout/setInterval call sites — until that lands, reject the calls.
 */
export function rejectTimersUnderWasi(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const found = new Set<string>();
  /**
   * Returns true if the identifier appears in a non-expression "name slot"
   * (a member name, declaration binding, property assignment key, etc.).
   * Bare global-identifier references and call-site identifiers are NOT
   * filtered by this predicate.
   */
  const isNameSlot = (id: ts.Identifier): boolean => {
    const parent = id.parent as ts.Node | undefined;
    if (!parent) return false;
    // `obj.setTimeout` — the `.name` slot of a property access.
    if (ts.isPropertyAccessExpression(parent) && parent.name === id) return true;
    // `class C { setTimeout() {} }` — method/property/getter/setter name slot.
    if (
      (ts.isMethodDeclaration(parent) ||
        ts.isMethodSignature(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isShorthandPropertyAssignment(parent) ||
        ts.isEnumMember(parent) ||
        ts.isBindingElement(parent) ||
        ts.isParameter(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isImportSpecifier(parent) ||
        ts.isExportSpecifier(parent) ||
        ts.isNamedImports(parent) ||
        ts.isNamedExports(parent) ||
        ts.isTypeReferenceNode(parent) ||
        ts.isQualifiedName(parent)) &&
      (parent as { name?: ts.Node }).name === id
    ) {
      return true;
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && WASI_REJECTED_TIMER_GLOBALS.has(node.text) && !isNameSlot(node)) {
      if (!found.has(node.text)) {
        found.add(node.text);
        reportError(
          ctx,
          node,
          `Codegen error: '${node.text}' is not available under --target wasi — WASI has no event loop. ` +
            `Use a synchronous loop, or split work across discrete _start invocations. ` +
            `(A poll_oneoff-based sleep helper is available internally but not yet wired into ${node.text}.)`,
        );
      }
    }
    forEachChild(node, visit);
  };
  for (const stmt of sourceFile.statements) {
    forEachChild(stmt, visit);
  }
}

// ── Regular declaration collection ───────────────────────────────────

/** Collect enum declarations into ctx.enumValues / ctx.enumStringValues */
export function collectEnumDeclarations(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const stringEnumLiterals: string[] = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isEnumDeclaration(stmt)) continue;
    const enumName = stmt.name.text;
    let nextValue = 0;
    for (const member of stmt.members) {
      const memberName = (member.name as ts.Identifier).text;
      const key = `${enumName}.${memberName}`;
      if (member.initializer) {
        if (ts.isStringLiteral(member.initializer)) {
          // String enum member — store in enumStringValues
          const strVal = member.initializer.text;
          ctx.enumStringValues.set(key, strVal);
          if (!ctx.stringGlobalMap.has(strVal)) {
            stringEnumLiterals.push(strVal);
          }
          continue;
        }
        if (ts.isNumericLiteral(member.initializer)) {
          nextValue = Number(member.initializer.text.replace(/_/g, ""));
        } else if (
          ts.isPrefixUnaryExpression(member.initializer) &&
          member.initializer.operator === ts.SyntaxKind.MinusToken &&
          ts.isNumericLiteral(member.initializer.operand)
        ) {
          nextValue = -Number((member.initializer.operand as ts.NumericLiteral).text.replace(/_/g, ""));
        }
      }
      ctx.enumValues.set(key, nextValue);
      nextValue++;
    }
  }

  // Register string enum literals as string constant globals
  if (stringEnumLiterals.length > 0) {
    if (ctx.nativeStrings) {
      ensureNativeStringHelpers(ctx);
      for (const value of stringEnumLiterals) {
        if (!ctx.stringGlobalMap.has(value)) ctx.stringGlobalMap.set(value, -1);
      }
    } else {
      addStringImports(ctx);
      for (const value of stringEnumLiterals) {
        addStringConstantGlobal(ctx, value);
      }
    }
  }
}
