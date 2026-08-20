// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1888 S6 — demand-driven built-in namespace values for standalone.
 *
 * This is intentionally a small static-global surface, not a `globalThis`
 * emulator. Each supported built-in static method is compiled to a cached
 * Wasm closure, and each supported namespace (`Array`, `Object`) is a lazy
 * `$Object` singleton populated only with those supported properties.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3b) stable-regime minting
import { ts } from "../ts-api.js";
import { emitCachedFuncClosureAccess } from "./closures.js";
import { pushBuiltinCtorOwnPropSeed } from "./builtin-ctor-own-props.js";
import { BUILTIN_STATIC_METHOD_ARITY, pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import { ensureStandaloneBuiltinStaticMethodClosure } from "./builtin-value-read.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

const SUPPORTED_STATIC_PROPS: ReadonlyMap<string, readonly string[]> = new Map([
  ["Array", ["isArray"]],
  ["Object", ["keys"]],
  // #2907 — bare-value carriers for the well-known namespace globals. An EMPTY
  // supported-prop list means: materialize a native extensible `$Object`
  // singleton for the bare identifier (`Math`, `JSON`, `Reflect` used as a
  // VALUE — `Object.isFrozen(Math)`, `[].filter(fn, JSON)` thisArg,
  // `Object.getPrototypeOf(Reflect)`), WITHOUT claiming any supported static
  // property. `isSupportedBuiltinStaticProperty(ns, m)` stays false for these,
  // so `Math.PI` / `JSON.stringify` / `Reflect.ownKeys` keep their existing
  // property-access fast paths (those are intercepted at the property-access
  // site, before identifier resolution of the receiver). This only affects the
  // bare-identifier value read, which previously leaked `env.global_<Name>`.
  ["Math", []],
  ["JSON", []],
  ["Proxy", []],
  ["Reflect", []],
  // #2907 — Error-family constructors as bare-value carriers. `expectedError =
  // TypeError`, `[TypeError, RangeError]`, `Object.isFrozen(TypeError)`. A `new
  // TypeError(...)` / `TypeError(...)` callee and `e instanceof TypeError` are
  // resolved BEFORE identifier resolution (native-error construction /
  // static builtin-tag registry), so the carrier only backs the bare-value read
  // — which previously leaked `env.global_<Name>` or fell to a null default.
  ["Error", []],
  ["TypeError", []],
  ["RangeError", []],
  ["SyntaxError", []],
  ["ReferenceError", []],
  ["EvalError", []],
  ["URIError", []],
  ["AggregateError", []],
]);

export function isSupportedBuiltinNamespace(name: string): boolean {
  return SUPPORTED_STATIC_PROPS.has(name);
}

/**
 * (#3006) Builtin CONSTRUCTOR names that get a GENUINE, identity-stable reified
 * constructor-object carrier in standalone mode — the substrate #2963's issue
 * plan calls for ("synthesize … a `$Object`-backed … module-level singleton
 * slot per reified builtin; the same builtin reference must yield the same
 * object"). Both the bare identifier read (`… === Set`) AND the
 * `<Builtin>.prototype.constructor` / `(new <Builtin>()).constructor` read route
 * to the SAME per-name `__builtin_ctor_<Name>` singleton, so
 * `Set.prototype.constructor === Set` is GENUINELY true (same object) while the
 * swap-wrong-builtin cross-check `Set.prototype.constructor === Map` is GENUINELY
 * false (distinct per-name singletons) — NOT a null≡null tautology.
 *
 * This is deliberately the narrow subset of `BUILTIN_CTOR_NAMES` whose bare value
 * currently resolves to the null-externref carrier standalone (verified: all read
 * falsy today, no native constructor-object identity) and whose `.constructor`
 * read otherwise leaks the `env::Object_get_constructor` host import (#2999
 * round-5 leak analysis). It EXCLUDES builtins that already carry a genuine
 * bare-value identity — `Math`/`JSON`/`Reflect` and the `Error` family
 * (namespace-object carriers, #2907), `Array`/`Object` (namespace objects),
 * native-error-tag constructors, etc. — so those keep their existing lowering
 * untouched.
 */
export const BUILTIN_CONSTRUCTOR_IDENTITY_NAMES: ReadonlySet<string> = new Set([
  "Set",
  "Map",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "RegExp",
  "FinalizationRegistry",
  "DisposableStack",
  "AsyncDisposableStack",
  "SuppressedError",
  // (#4223) The primitive-WRAPPER constructors. #3006 left them out and #4200
  // recorded the consequence explicitly: with no carrier, the bare identifier
  // read `null` while `<B>.prototype.constructor` read `undefined`, so
  // `Object(5).constructor === Number` compared `undefined === null` — false on
  // BOTH sides, and no amount of work on the wrapper's `.constructor` read
  // could have made it true. The carrier is what makes the RHS a real object.
  //
  // Safe by the same argument as the Error family above: every SYNTACTIC use of
  // these names is intercepted before identifier resolution — `Number(x)` /
  // `new Number(x)` at the call/construct site, `Number.MAX_VALUE` and
  // `Number.prototype` at the property-access site, `typeof Number` at the
  // typeof fold, `x instanceof Number` at the instanceof lowering. Only the
  // BARE-VALUE read changes, and it changes from `ref.null.extern` (a value no
  // conforming program can observe as the constructor) to the carrier.
  "Number",
  "String",
  "Boolean",
]);

export function isBuiltinConstructorIdentityName(name: string): boolean {
  return BUILTIN_CONSTRUCTOR_IDENTITY_NAMES.has(name);
}

/**
 * (#3006) Emit a GENUINE, identity-stable reified builtin-constructor object.
 *
 * One `externref` mutable global per constructor name (`__builtin_ctor_<Name>`),
 * lazily materialized once on first read to a fresh `$Object`
 * (`__new_plain_object`) behind an `if (ref.is_null) { … }` guard, then read via
 * `global.get`. Every read of the same builtin — whether the bare identifier
 * (`Set`) or a `.prototype.constructor` / instance `.constructor` read — yields
 * the SAME object ref, so `===` (WasmGC `ref.eq` identity, preserved even across
 * the externref-widening `assert.sameValue(a, b)` harness boundary — verified) is
 * genuinely true for the same builtin and genuinely false across distinct
 * builtins.
 *
 * The materialization is emitted directly into `fctx.body` (a shift-covered
 * array) and contains only a `call __new_plain_object` — no `ref.func` operand —
 * so it is immune to the late-import funcidx-shift hazard that forced #2963's
 * static-method singleton to avoid a const-init global. Keyed in the shared
 * `builtinObjectGlobals` map under a `ctor:` prefix so it never collides with the
 * namespace-object carriers (`emitBuiltinNamespaceObject`), which key by bare
 * name.
 *
 * Stack: `[] → [externref]`.
 */
export function emitBuiltinConstructorIdentity(
  ctx: CodegenContext,
  fctx: FunctionContext,
  builtinName: string,
): ValType {
  ensureObjectRuntime(ctx);
  const newObjectIdx = ctx.funcMap.get("__new_plain_object")!;

  const key = `ctor:${builtinName}`;
  let globalIdx = ctx.builtinObjectGlobals.get(key);
  if (globalIdx === undefined) {
    globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: `__builtin_ctor_${builtinName}`,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.builtinObjectGlobals.set(key, globalIdx);
  }

  // (#2984 ctor-carrier own props) The carrier is materialized through a local
  // so the §17/§20 own data properties (`length`/`name`/`prototype`) can be
  // installed on it before it is published to the global. Without them the
  // carrier is an EMPTY `$Object`, and every RUNTIME descriptor query
  // test262's `verifyProperty` makes through its any-typed harness parameter
  // (`hasOwnProperty`, `gOPD`, for-in, write, delete) answers "absent".
  const objLocal = allocLocal(fctx, `__builtin_ctor_${builtinName}_obj_${fctx.locals.length}`, {
    kind: "externref",
  });
  const initBody: Instr[] = [
    { op: "call", funcIdx: newObjectIdx },
    { op: "local.set", index: objLocal },
  ];

  // (#2182 pattern) `savedBody` is detached during the swap; register it in
  // `liveBodies` so a late-import funcidx shift walks it too.
  const savedBody = fctx.body;
  fctx.body = initBody;
  ctx.liveBodies.add(savedBody);
  try {
    pushBuiltinCtorOwnPropSeed(ctx, fctx, builtinName, objLocal);
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "global.set", index: globalIdx });
  } finally {
    fctx.body = savedBody;
    ctx.liveBodies.delete(savedBody);
  }

  fctx.body.push({ op: "global.get", index: globalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: initBody, else: [] });
  fctx.body.push({ op: "global.get", index: globalIdx });
  return { kind: "externref" };
}

export function isSupportedBuiltinStaticProperty(builtinName: string, propName: string): boolean {
  return SUPPORTED_STATIC_PROPS.get(builtinName)?.includes(propName) ?? false;
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isTypeAssertionExpression(expr)
  ) {
    expr = ts.isParenthesizedExpression(expr)
      ? expr.expression
      : ts.isAsExpression(expr)
        ? expr.expression
        : ts.isNonNullExpression(expr)
          ? expr.expression
          : (expr as ts.TypeAssertion).expression;
  }
  return expr;
}

export function resolveBuiltinNamespaceValueName(ctx: CodegenContext, expr: ts.Expression): string | undefined {
  const unwrapped = unwrapExpression(expr);
  if (!ts.isIdentifier(unwrapped)) return undefined;
  if (isSupportedBuiltinNamespace(unwrapped.text)) return unwrapped.text;

  const sym = ctx.checker.getSymbolAtLocation(unwrapped);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
  const init = unwrapExpression(decl.initializer);
  if (ts.isIdentifier(init) && isSupportedBuiltinNamespace(init.text)) return init.text;
  return undefined;
}

/**
 * Resolve a const object-binding alias of a builtin static method.
 *
 * Deno's primordials bootstrap snapshots intrinsics with declarations such as
 * `const { ownKeys: ReflectOwnKeys } = Reflect`. The binding is stored through
 * the ordinary externref object-destructuring path, while TypeScript describes
 * its return using the lib declaration's structural array type. Call lowering
 * needs the canonical builtin closure signature instead: for example the
 * native Reflect.ownKeys closure returns the object runtime's externref key
 * vector. Keeping that representation prevents generic callable dispatch from
 * replacing the live result with a mismatched typed-array default.
 */
export function resolveBuiltinStaticBindingAlias(
  ctx: CodegenContext,
  expr: ts.Expression,
): { builtinName: string; propName: string } | undefined {
  const unwrapped = unwrapExpression(expr);
  if (!ts.isIdentifier(unwrapped)) return undefined;
  const symbol = ctx.checker.getSymbolAtLocation(unwrapped);
  const declaration = symbol?.valueDeclaration;
  if (!declaration || !ts.isBindingElement(declaration) || declaration.dotDotDotToken) return undefined;
  const pattern = declaration.parent;
  if (!ts.isObjectBindingPattern(pattern)) return undefined;
  const variable = pattern.parent;
  if (!ts.isVariableDeclaration(variable) || variable.name !== pattern || !variable.initializer) return undefined;
  const list = variable.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return undefined;

  const builtinName = resolveBuiltinNamespaceValueName(ctx, variable.initializer);
  if (!builtinName) return undefined;
  const property = declaration.propertyName ?? declaration.name;
  const propName =
    ts.isIdentifier(property) || ts.isStringLiteral(property) || ts.isNumericLiteral(property)
      ? property.text
      : undefined;
  if (!propName || BUILTIN_STATIC_METHOD_ARITY[builtinName]?.[propName] === undefined) return undefined;
  return { builtinName, propName };
}

function hiddenName(builtinName: string, propName: string): string {
  return `__builtin_static_${builtinName}_${propName}`;
}

function ensureArrayIsArrayFunc(ctx: CodegenContext): number {
  const name = hiddenName("Array", "isArray");
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$builtin_Array_isArray_type");
  const vecTypeIdxs = Array.from(new Set(ctx.vecTypeMap.values()));

  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];

  if (vecTypeIdxs.length === 0) {
    body.push({ op: "i32.const", value: 0 });
  } else {
    for (let i = 0; i < vecTypeIdxs.length; i++) {
      body.push({ op: "local.get", index: 1 });
      body.push({ op: "ref.test", typeIdx: vecTypeIdxs[i]! });
      if (i > 0) body.push({ op: "i32.or" });
    }
  }

  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: [{ name: "any", type: { kind: "anyref" } }],
    body,
    exported: false,
  } as WasmFunction);
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}

function ensureObjectKeysFunc(ctx: CodegenContext): number {
  const name = hiddenName("Object", "keys");
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  ensureObjectRuntime(ctx);
  const objectKeysIdx = ctx.funcMap.get("__object_keys")!;
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$builtin_Object_keys_type");
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: objectKeysIdx },
    ],
    exported: false,
  } as WasmFunction);
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}

function ensureBuiltinStaticFunc(ctx: CodegenContext, builtinName: string, propName: string): number | undefined {
  if (builtinName === "Array" && propName === "isArray") return ensureArrayIsArrayFunc(ctx);
  if (builtinName === "Object" && propName === "keys") return ensureObjectKeysFunc(ctx);
  return undefined;
}

export function emitBuiltinStaticMethodValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  builtinName: string,
  propName: string,
): ValType | null {
  const closure = ensureStandaloneBuiltinStaticMethodClosure(ctx, builtinName, propName);
  if (closure) {
    fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, closure));
    return closure.type;
  }
  const funcIdx = ensureBuiltinStaticFunc(ctx, builtinName, propName);
  if (funcIdx === undefined) return null;
  return emitCachedFuncClosureAccess(ctx, fctx, hiddenName(builtinName, propName), funcIdx);
}

function coerceTopToExternref(fctx: FunctionContext, valueType: ValType | null): void {
  if (!valueType || valueType.kind === "externref") return;
  if (valueType.kind === "ref" || valueType.kind === "ref_null") {
    fctx.body.push({ op: "extern.convert_any" });
  }
}

/**
 * Install the runtime-visible own properties of the JSON namespace carrier.
 *
 * Direct `JSON.parse` / `JSON.stringify` reads have dedicated compiler paths,
 * but test262's descriptor helpers pass `JSON` through an `any`-typed
 * parameter. That loses the syntactic namespace identity and reaches the
 * native `$Object` MOP, where the carrier used to be empty. Seed the same
 * identity-stable builtin-function singletons used by direct VALUE reads so
 * dynamic gOPD/hasOwn/property access observe genuine own method properties.
 *
 * This deliberately does NOT add the methods to `SUPPORTED_STATIC_PROPS`:
 * doing so would reroute direct calls through the older Array/Object-only
 * `emitBuiltinStaticMethodValue` path. The carrier seed is a separate runtime
 * reflection surface.
 */
function pushJsonNamespaceOwnPropSeed(ctx: CodegenContext, fctx: FunctionContext, objLocal: number): void {
  if (!ctx.standalone && !ctx.wasi) return;
  const defineIdx = ctx.funcMap.get("__defineProperty_value");
  if (defineIdx === undefined) return;

  // §17 builtin methods: { writable:true, enumerable:false,
  // configurable:true }.
  const METHOD_FLAGS = 0x01 | 0x04;
  for (const prop of ["parse", "stringify", "rawJSON", "isRawJSON"] as const) {
    const closure = ensureStandaloneBuiltinStaticMethodClosure(ctx, "JSON", prop);
    if (!closure) continue;
    fctx.body.push({ op: "local.get", index: objLocal });
    addStringConstantGlobal(ctx, prop);
    fctx.body.push(...stringConstantExternrefInstrs(ctx, prop));
    fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, closure));
    fctx.body.push({ op: "extern.convert_any" });
    fctx.body.push({ op: "f64.const", value: METHOD_FLAGS });
    fctx.body.push({ op: "call", funcIdx: defineIdx });
    fctx.body.push({ op: "drop" });
  }

  // §25.5.3 JSON[@@toStringTag] = "JSON":
  // { writable:false, enumerable:false, configurable:true }.
  const boxSymbolIdx = ensureLateImport(ctx, "__box_symbol", [{ kind: "i32" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (boxSymbolIdx === undefined) return;
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "i32.const", value: 4 }); // Symbol.toStringTag
  fctx.body.push({ op: "call", funcIdx: boxSymbolIdx });
  addStringConstantGlobal(ctx, "JSON");
  fctx.body.push(...stringConstantExternrefInstrs(ctx, "JSON"));
  fctx.body.push({ op: "f64.const", value: 0x04 });
  fctx.body.push({ op: "call", funcIdx: defineIdx });
  fctx.body.push({ op: "drop" });
}

export function emitBuiltinNamespaceObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  builtinName: string,
): ValType | null {
  const baselineProps = SUPPORTED_STATIC_PROPS.get(builtinName);
  if (!baselineProps) return null;
  // A namespace carrier is materialized only when the namespace is used as a
  // value. At that demand point, source its complete function-valued own
  // surface from the same canonical registry that drives static value
  // metadata/closure materialization. This lets runtime reflection through
  // stored/uncurried helpers observe the same ownership as direct access.
  const props = Array.from(
    new Set([
      ...baselineProps,
      ...(builtinName === "JSON" ? [] : Object.keys(BUILTIN_STATIC_METHOD_ARITY[builtinName] ?? {})),
    ]),
  );

  ensureObjectRuntime(ctx);
  const newObjectIdx = ctx.funcMap.get("__new_plain_object")!;
  const defineValueIdx = ctx.funcMap.get("__defineProperty_value")!;

  let globalIdx = ctx.builtinObjectGlobals.get(builtinName);
  if (globalIdx === undefined) {
    globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: `__builtin_${builtinName}`,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.builtinObjectGlobals.set(builtinName, globalIdx);
  }

  const objLocal = allocLocal(fctx, `__builtin_${builtinName}_obj_${fctx.locals.length}`, { kind: "externref" });
  const initBody: Instr[] = [
    { op: "call", funcIdx: newObjectIdx },
    { op: "local.set", index: objLocal },
  ];

  const savedBody = fctx.body;
  fctx.body = initBody;
  // (#2182) `savedBody` is the outer body, detached for the duration of the
  // swap. `emitBuiltinStaticMethodValue` below can trigger a late import (e.g.
  // a host builtin), and `shiftLateImportIndices` only walks `fctx.body` (=
  // initBody here) plus the registered body sets — NOT this raw local. Register
  // it in `liveBodies` so any `call` funcIdx already accumulated in the outer
  // body is shifted too; otherwise a late import here would over-shift it.
  ctx.liveBodies.add(savedBody);
  try {
    for (const prop of props) {
      fctx.body.push({ op: "local.get", index: objLocal });
      addStringConstantGlobal(ctx, prop);
      fctx.body.push(...stringConstantExternrefInstrs(ctx, prop));
      const valueType = emitBuiltinStaticMethodValue(ctx, fctx, builtinName, prop);
      coerceTopToExternref(fctx, valueType);
      // Builtin static methods are writable, non-enumerable, configurable.
      // Host descriptor encoding: value bits 0b101 + all three specified bits
      // + hasValue = 0xBD.
      fctx.body.push({ op: "f64.const", value: 0xbd });
      fctx.body.push({ op: "call", funcIdx: defineValueIdx });
      fctx.body.push({ op: "drop" });
    }
    if (builtinName === "JSON") {
      pushJsonNamespaceOwnPropSeed(ctx, fctx, objLocal);
    }
    // (#2984 ctor-carrier own props) The Error-family / `Array` / `Object`
    // carriers are CONSTRUCTOR objects, so they also own `length`/`name`/
    // `prototype`. No-op for the true namespaces (`Math`/`JSON`/`Reflect`),
    // which own none of the three.
    pushBuiltinCtorOwnPropSeed(ctx, fctx, builtinName, objLocal);
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "global.set", index: globalIdx });
  } finally {
    fctx.body = savedBody;
    ctx.liveBodies.delete(savedBody);
  }

  fctx.body.push({ op: "global.get", index: globalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: initBody, else: [] });
  fctx.body.push({ op: "global.get", index: globalIdx });
  return { kind: "externref" };
}
