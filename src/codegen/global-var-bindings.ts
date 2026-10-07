// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 T4) §9.1.1.4.17 CreateGlobalVarBinding — the `var` twin of
 * `global-function-bindings.ts`'s §9.1.1.4.18.
 *
 * ## The defect
 *
 * #4394 gave a SCRIPT's top-level FUNCTION declarations their own properties on
 * the realm object. Its `var` sibling was never done, so the two halves of
 * GlobalDeclarationInstantiation disagreed on this tree:
 *
 * ```js
 * function topFn() {}
 * var declaredVar;
 * for (var p in this) { … }   // yields "topFn", never "declaredVar"
 * ```
 *
 * Every reflective probe on a `var`-declared global therefore answered as if
 * the binding did not exist — `for…in` skipped it (`S12.2_A9`),
 * `hasOwnProperty` was false, `Object.keys(this)` omitted it — while the
 * ordinary identifier read worked fine. That asymmetry is the whole failure:
 * the value was reachable, the BINDING was not.
 *
 * ## Attributes and value
 *
 * `{ writable: true, enumerable: true, configurable: false }` — §9.1.1.4.17
 * with `D` false, identical to the function binding, and the `configurable:
 * false` half is what makes `delete this["v"]` answer `false` (`S12.2_A2`,
 * whose compile-time guard lives in `global-environment.ts`).
 *
 * The seeded VALUE is `undefined`, which is what GlobalDeclarationInstantiation
 * initialises a var binding to. In standalone (#6651 V13) the property is a
 * VIEW of the wasm module global instead — a branded non-configurable accessor
 * pair over that global, which reports itself as the data property above — so
 * a receiver only known at run time (`Array.from(a, f, this)` handing the
 * global object to a sloppy `f`) reads and writes the same cell as bare `v`.
 * Mechanism and MOP arms: `object-model/global-var-binding-exotic.ts`. WASI,
 * a carrier the view cannot convert (`i32`), and the shared-realm
 * `standaloneScriptVarBindings` mode (where the property IS the storage) keep
 * the plain `undefined` seed.

 * ## Why the guard is a RUNTIME `hasOwnProperty`, not a name list
 *
 * §9.1.1.4.17 step 2 creates the property only when the global object does not
 * already have it. The realm object is pre-seeded with builtins (`NaN`,
 * `Infinity`, `undefined`, `globalThis`, the §19.2 global functions, the
 * namespace objects) whose attributes differ, and a `var NaN;` must not
 * redefine them. A hardcoded skip-list would have to track every future seed;
 * the runtime `__hasOwnProperty` consult is the spec's own test and cannot
 * drift out of date.
 *
 * Names that are also top-level FUNCTION declarations are skipped at compile
 * time: `emitScriptGlobalFunctionBindings` runs first and its binding wins
 * (GDI initialises the function, not the var).
 *
 * Scripts only, standalone/WASI only — the same two gates the function twin
 * documents (in the host lane `globalThis` is the embedder's own object).
 */
import type { Instr, ValType } from "../ir/types.js";
import { forEachChild, ts } from "../ts-api.js";
import { isAnyValue, undefinedExternInstrs } from "./any-helpers.js";
import { emitNativeGlobalThisObject } from "./array-object-proto.js";
import { emitCachedFuncClosureExternref } from "./closures/method-trampolines.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import {
  type GlobalVarAccessor,
  globalVarAccessorSupports,
  markGlobalVarBindingInstrs,
} from "./object-model/global-var-binding-exotic.js";
import { addStringConstantGlobal, localGlobalIdx } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { coercionInstrs } from "./type-coercion.js";
import { isStrictContext } from "./helpers/is-strict-function.js";

/**
 * `{ writable: true, enumerable: true, configurable: false }` — the bit layout
 * `__defineProperty_value` reads (1 writable, 2 enumerable, 4 configurable).
 * Identical to `SCRIPT_FUNCTION_BINDING_FLAGS`; both are §9.1.1.4.x with
 * `D` false.
 */
const SCRIPT_VAR_BINDING_FLAGS = 0x03;

/**
 * (#6651 V13) The view's accessor define in the host flag encoding
 * `__defineProperty_accessor` reads: enumerable specified and true (bits 4/1),
 * configurable specified and false (bit 5), both halves specified (bits 8/9).
 */
const SCRIPT_VAR_VIEW_FLAGS = (1 << 1) | (1 << 4) | (1 << 5) | (1 << 8) | (1 << 9);

/** Names through which code can obtain the global object (`f.constructor` is `Function`). */
const REACHING_NAMES = new Set(["globalThis", "eval", "Function", "constructor"]);

/** Per-file memo for {@link globalObjectMayReachDynamically}. */
const globalObjectReachCache = new WeakMap<ts.SourceFile, boolean>();

/**
 * (#6651 V13) Can the global object reach code as a value the compiler does not
 * resolve statically? Only then can a `this.v` / `o[k]` read land on a script
 * `var`'s global-object property at run time, so only then is the live view
 * over the module global worth its getter/setter pair. The ways to obtain the
 * global object as a value: a top-level `this` (also through arrows), a
 * `this` inside a SLOPPY non-arrow function (a plain call binds it to the
 * global object), the `globalThis` name, and `eval` / `Function` code (also
 * reached as `f.constructor`). With none of those the view is unobservable.
 */
function globalObjectMayReachDynamically(sourceFile: ts.SourceFile): boolean {
  const cached = globalObjectReachCache.get(sourceFile);
  if (cached !== undefined) return cached;
  let found = false;
  const thisReachesGlobal = (node: ts.Node): boolean => {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isArrowFunction(current)) continue;
      if (ts.isSourceFile(current)) return true;
      if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) return false;
      if (ts.isFunctionLike(current)) return !isStrictContext(current, false);
    }
    return true;
  };
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      found = thisReachesGlobal(node);
    } else if (ts.isIdentifier(node)) {
      found = REACHING_NAMES.has(node.text);
    }
    if (!found) forEachChild(node, walk);
  };
  walk(sourceFile);
  globalObjectReachCache.set(sourceFile, found);
  return found;
}

/**
 * (#6651 V13) Reserve the getter/setter pair over `name`'s module global and
 * leave their closures, as externrefs, in `getter` / `setter`. The bodies are
 * valid placeholders until `installGlobalVarBindingArms` fills them against
 * the global's final type. `undefined` when the var has no convertible global.
 */
function reserveVarView(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
): { accessor: GlobalVarAccessor; closures: Instr[] } | undefined {
  if (!ctx.standalone || ctx.standaloneScriptVarBindings) return undefined;
  const globalIdx = ctx.moduleGlobals.get(name);
  const global = globalIdx === undefined ? undefined : ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
  // An AnyValue carrier takes a write only through its boxing helper; leave it
  // on the plain seed rather than drop every write in a guarded cast.
  if (global === undefined || !globalVarAccessorSupports(global) || isAnyValue(global.type, ctx)) return undefined;
  const ext: ValType = { kind: "externref" };
  // Settle the conversion helpers now, while emitting is still in progress;
  // the post-pass fill re-derives the instructions against the final type.
  const coerce = (from: ValType, to: ValType): Instr[] => coercionInstrs(ctx, from, to);
  coerce(global.type, ext);
  if (global.type.kind === "f64") coerce(ext, global.type);
  const accessor: GlobalVarAccessor = {
    global,
    getName: `__global_var_get_${name}`,
    setName: `__global_var_set_${name}`,
    coerce,
  };
  // Both closures go into ONE side body, getter then setter — the order the
  // accessor define consumes them — kept live so a shift reaches both.
  const saved = fctx.body;
  const closures: Instr[] = [];
  for (const [fnName, params] of [
    [accessor.getName, []],
    [accessor.setName, [ext]],
  ] as const) {
    let funcIdx = ctx.funcMap.get(fnName);
    if (funcIdx === undefined) {
      funcIdx = mintDefinedFunc(ctx);
      const typeIdx = addFuncType(ctx, [...params], [ext]);
      const body: Instr[] = [{ op: "ref.null.extern" }];
      pushDefinedFunc(ctx, funcIdx, { name: fnName, typeIdx, locals: [], body, exported: false });
      ctx.funcMap.set(fnName, funcIdx);
    }
    fctx.body = closures;
    ctx.liveBodies.add(saved);
    let ok = false;
    try {
      ok = emitCachedFuncClosureExternref(ctx, fctx, fnName, funcIdx, false);
    } finally {
      fctx.body = saved;
      ctx.liveBodies.delete(saved);
    }
    if (!ok) return undefined;
  }
  return { accessor, closures };
}

/**
 * Emit the global-object seeds for every top-level `var` declaration.
 *
 * Appends to `fctx.body`. Emits nothing at all for modules, for the host lane,
 * and when the script declares no top-level vars — so those modules stay
 * byte-identical.
 */
export function emitScriptGlobalVarBindings(
  ctx: CodegenContext,
  fctx: FunctionContext,
  sourceFile: ts.SourceFile,
): void {
  if (!ctx.standalone && !ctx.wasi) return;
  if (ctx.sourceIsModule) return;
  const varNames = ctx.globalObjectVarBindings;
  if (!varNames || varNames.size === 0) return;

  const seeds = [...varNames].filter((name) => !ctx.topLevelFunctionNames.has(name) && !ctx.classSet.has(name));
  if (seeds.length === 0) return;

  const undefinedValue = undefinedExternInstrs(ctx);
  if (undefinedValue === undefined) return;

  const objType = emitNativeGlobalThisObject(ctx, fctx);
  if (objType === null) return;
  const defineIdx = ctx.funcMap.get("__defineProperty_value");
  const hasOwnIdx = ctx.funcMap.get("__hasOwnProperty");
  if (defineIdx === undefined || hasOwnIdx === undefined) {
    // The object is on the stack and nothing below will consume it.
    fctx.body.push({ op: "drop" });
    return;
  }
  const objLocal = allocLocal(fctx, `__global_var_binding_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });
  const entryType = ctx.objectRuntimeTypes?.propEntryTypeIdx;
  const entryLocal =
    entryType === undefined ||
    !ctx.funcMap.has("__defineProperty_accessor") ||
    !globalObjectMayReachDynamically(sourceFile)
      ? -1
      : allocLocal(fctx, `__global_var_binding_entry_${fctx.locals.length}`, { kind: "ref_null", typeIdx: entryType });

  for (const name of seeds) {
    addStringConstantGlobal(ctx, name);
    const key = (): Instr[] => stringConstantExternrefInstrs(ctx, name);
    const view = entryLocal < 0 ? undefined : reserveVarView(ctx, fctx, name);
    const mark = view === undefined ? [] : markGlobalVarBindingInstrs(ctx, objLocal, key(), entryLocal, view.accessor);
    // Re-read every index AFTER the reservation, which may have shifted them.
    const defineAccessorIdx = ctx.funcMap.get("__defineProperty_accessor");
    const define: Instr[] =
      view === undefined || mark.length === 0 || defineAccessorIdx === undefined
        ? [
            { op: "local.get", index: objLocal },
            ...key(),
            ...(undefinedExternInstrs(ctx) ?? undefinedValue),
            { op: "f64.const", value: SCRIPT_VAR_BINDING_FLAGS },
            { op: "call", funcIdx: ctx.funcMap.get("__defineProperty_value") ?? defineIdx },
            { op: "drop" },
          ]
        : [
            { op: "local.get", index: objLocal },
            ...key(),
            ...view.closures,
            { op: "f64.const", value: SCRIPT_VAR_VIEW_FLAGS },
            { op: "call", funcIdx: defineAccessorIdx },
            { op: "drop" },
            ...mark,
          ];
    fctx.body.push(
      { op: "local.get", index: objLocal },
      ...key(),
      { op: "call", funcIdx: ctx.funcMap.get("__hasOwnProperty") ?? hasOwnIdx },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: define },
    );
  }
}
