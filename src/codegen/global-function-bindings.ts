// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4394) §9.1.1.4.18 CreateGlobalFunctionBinding — a SCRIPT's top-level
 * function declarations are own properties of the global object.
 *
 * We never implemented this. Measured on this tree, for a top-level
 * `function $DONE() {}`:
 *
 * | lane | `hasOwnProperty(globalThis, "$DONE")` | `typeof globalThis.$DONE` |
 * | --- | --- | --- |
 * | host/GC | false | "function" |
 * | standalone | false | — |
 *
 * The property access resolves (identifier lowering finds the function), but
 * the BINDING does not exist, so any reflective probe answers `false`. That is
 * 19 of the 50 standalone harness failures: `asyncHelpers.js` gates `asyncTest`
 * on `Object.prototype.hasOwnProperty.call(globalThis, "$DONE")` and throws
 * "asyncTest called without async flag" when it is absent. The GC lane only
 * passes those because the test262 runner *fakes* the own-property on its
 * sandbox.
 *
 * Seeding happens at the TOP of `__module_init`, before any user statement,
 * which is what function-declaration hoisting requires: the binding is created
 * and initialised during GlobalDeclarationInstantiation, ahead of script
 * evaluation.
 *
 * Scripts only. In an ES module the top-level declarations live in the module
 * environment record and are deliberately NOT global-object properties.
 */
import type { Instr } from "../ir/types.js";
import { emitNativeGlobalThisObject } from "./array-object-proto.js";
import { emitFuncRefAsClosure } from "./closures/funcref-as-closure.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";

/**
 * Property attributes for a script function binding: `{ writable: true,
 * enumerable: true, configurable: false }` (§9.1.1.4.18 with `D` false).
 *
 * Bit layout matches `__defineProperty_value`: 1 writable, 2 enumerable,
 * 4 configurable.
 */
const SCRIPT_FUNCTION_BINDING_FLAGS = 0x03;

/**
 * Emit the global-object seeds for every top-level function declaration.
 *
 * Appends to `fctx.body`. A no-op (and emits nothing at all) for modules, for
 * the host lane, and when the module declares no top-level functions.
 *
 * Host/GC is excluded on purpose for now: there `globalThis` is the embedder's
 * own object — in the test262 runner, the per-test sandbox — and defining ~50
 * properties on it per module is a visible change to a shared object that the
 * runner also seeds itself. Standalone owns its `$Object` outright, so the
 * seeding is contained. Extending this to the host lane (and dropping the
 * runner's `$DONE` stub) is the follow-up.
 *
 * KNOWN GAP: the seeded value is built by the per-site closure path, so it is a
 * distinct instance from the one an identifier read yields — `globalThis.f`
 * calls correctly but `globalThis.f === f` is false. Closing that needs the
 * function to carry a planned value-trampoline, which the IR only mints for
 * names it saw used as VALUES; a call-only name like `$DONE` has none, and
 * minting one here trips the ABI seal.
 */
export function emitScriptGlobalFunctionBindings(ctx: CodegenContext, fctx: FunctionContext): void {
  if (!ctx.standalone && !ctx.wasi) return;
  if (ctx.sourceIsModule) return;
  if (ctx.topLevelFunctionNames.size === 0) return;

  // Resolve every closure BEFORE touching the global object: both this and
  // `emitNativeGlobalThisObject` can register late imports, and a shift that
  // lands between the object's `local.set` and its readers would poison the
  // already-emitted indices.
  const seeds: { name: string; instrs: Instr[] }[] = [];
  for (const name of ctx.topLevelFunctionNames) {
    if (ctx.classSet.has(name)) continue;
    const funcIdx = ctx.funcMap.get(name);
    // Host imports have no in-module body and no closure to bind.
    if (funcIdx === undefined || funcIdx < ctx.numImportFuncs) continue;
    const probe: Instr[] = [];
    const saved = fctx.body;
    fctx.body = probe;
    // NOT `emitCachedFuncClosureAccess`: its memoized singleton is planned from
    // the IR's census of function-VALUE uses, and a name that only ever appears
    // as a callee (`$DONE(err)` — the case this exists for) has no planned
    // trampoline. Minting one here fails the ABI seal
    // ("would mutate sealed prepared scope"). The per-site path has no such
    // dependency. Cost: the seeded value is a distinct closure instance, so
    // `globalThis.f === f` is false — see the caveat in the doc-comment above.
    const closureType = emitFuncRefAsClosure(ctx, fctx, name, funcIdx);
    fctx.body = saved;
    if (closureType === null) continue;
    probe.push({ op: "extern.convert_any" });
    addStringConstantGlobal(ctx, name);
    seeds.push({ name, instrs: probe });
  }
  if (seeds.length === 0) return;

  const objType = emitNativeGlobalThisObject(ctx, fctx);
  if (objType === null) return;
  const defineIdx = ctx.funcMap.get("__defineProperty_value");
  if (defineIdx === undefined) {
    // The object is on the stack and nothing will consume it.
    fctx.body.push({ op: "drop" });
    return;
  }
  const objLocal = allocLocal(fctx, `__global_fn_binding_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });

  for (const seed of seeds) {
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push(...stringConstantExternrefInstrs(ctx, seed.name));
    fctx.body.push(...seed.instrs);
    fctx.body.push({ op: "f64.const", value: SCRIPT_FUNCTION_BINDING_FLAGS });
    fctx.body.push({ op: "call", funcIdx: defineIdx });
    fctx.body.push({ op: "drop" });
  }
}
