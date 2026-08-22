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
 * initialises a var binding to. It is not kept in sync afterwards, and that is
 * deliberate rather than overlooked: reads of the name — bare `v`, `this.v`
 * (#4500 Slice A), `this["v"]` (the bracket read/write pair) — all resolve to
 * the wasm module global, which is the single source of truth for the VALUE.
 * The realm property exists to answer the BINDING questions. The residual gap
 * is `Object.getOwnPropertyDescriptor(this, "v").value`, which reports the
 * initial `undefined` rather than the live value; closing it needs the module
 * global and the realm slot to become one cell, which is a representation
 * change, not a seeding change.
 *
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
import type { Instr } from "../ir/types.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import { emitNativeGlobalThisObject } from "./array-object-proto.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";

/**
 * `{ writable: true, enumerable: true, configurable: false }` — the bit layout
 * `__defineProperty_value` reads (1 writable, 2 enumerable, 4 configurable).
 * Identical to `SCRIPT_FUNCTION_BINDING_FLAGS`; both are §9.1.1.4.x with
 * `D` false.
 */
const SCRIPT_VAR_BINDING_FLAGS = 0x03;

/**
 * Emit the global-object seeds for every top-level `var` declaration.
 *
 * Appends to `fctx.body`. Emits nothing at all for modules, for the host lane,
 * and when the script declares no top-level vars — so those modules stay
 * byte-identical.
 */
export function emitScriptGlobalVarBindings(ctx: CodegenContext, fctx: FunctionContext): void {
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

  for (const name of seeds) {
    addStringConstantGlobal(ctx, name);
    const define: Instr[] = [
      { op: "local.get", index: objLocal },
      ...stringConstantExternrefInstrs(ctx, name),
      ...undefinedValue,
      { op: "f64.const", value: SCRIPT_VAR_BINDING_FLAGS },
      { op: "call", funcIdx: defineIdx },
      { op: "drop" },
    ];
    fctx.body.push(
      { op: "local.get", index: objLocal },
      ...stringConstantExternrefInstrs(ctx, name),
      { op: "call", funcIdx: hasOwnIdx },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: define },
    );
  }
}
