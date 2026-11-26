// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4489) Every module-scope `var` reads as `undefined` before its declaration.
 *
 * ## The defect
 *
 * §9.1.1.4.18 CreateGlobalVarBinding (and §10.2.11 for the hoist itself)
 * instantiates every module-scope `var` with the value `undefined` BEFORE the
 * first top-level statement runs, so a read that precedes the declaration — or
 * any assignment — must answer `undefined`.
 *
 * A module global can only be given a CONSTANT initializer (see
 * `registerModuleGlobal`), and the only constant externref is
 * `ref.null.extern`. Under the #2106 S1 regime that is `null`: a genuinely
 * DIFFERENT value from the tag-1 `$undefined` singleton, not a spelling of it.
 * Measured on the compiled module before this seed existed, for a plain
 * `var x;` read at module scope:
 *
 * ```
 * x === undefined   false   (spec: true)
 * x === null        true    (spec: false)
 * x()               did not throw   (spec + `undefined()`: TypeError)
 * ```
 *
 * The nullish-intent consumers (`x == null`, `String(x)`, `x + ""`,
 * `typeof x`, `"s".concat(x)`) already answered as if `undefined`, because the
 * #2106 S1 sweep widened them to `is_null ∨ is-singleton`. That widening is
 * what kept the defect narrow — and also what kept it hidden.
 *
 * ## Why it was worth a corpus-wide change
 *
 * `ref.null.extern` is ALSO the reflective-closure ABI's "argument not passed"
 * pad (`string-proto-concat.ts`, §22.1.3.5 step 3). A genuine trailing
 * `undefined` sourced from such a slot is therefore indistinguishable from an
 * absent argument, and gets DROPPED rather than stringified — #4465's R1
 * residual, the largest single group of its 27 remaining rows.
 *
 * ## Scope, and the two things this deliberately does NOT do
 *
 * - **Only `var`.** `let`/`const` are not seeded: their correct pre-init state
 *   is the TDZ, enforced by the separate `__tdz_<name>` flag (or elided
 *   entirely by `computeElidableTopLevelTdzNames`, which only elides when no
 *   read can observe the pre-init value). Seeding them `undefined` would be
 *   dead at best and a wrong answer at worst.
 * - **Only externref slots.** A slot the type inference narrowed to a primitive
 *   (`var n = 42` ⇒ `(mut f64)`, `var s = "a"` ⇒ a native-string ref) cannot
 *   physically hold the singleton and keeps its wasm zero-init. That is the
 *   module-scope twin of #684 (which the function-local hoister answers by
 *   seeding `f64.const NaN`) and of #4264 point 2 (which answers it by WIDENING
 *   the slot to externref for `with`-body vars). Both remedies are slot-type
 *   changes with their own blast radius; recorded as this issue's residual.
 *
 * This SUBSUMES the #4264 `with`-body seed rather than sitting beside it:
 * `scriptVarBindingNames` walks the same region (top-level code, never a
 * function or class body) over the same declaration kinds (`var`, binding
 * patterns included), so `withBodyHoistedModuleVarNames` is a strict subset of
 * it. That module is still consulted for its other, independent job — the slot
 * widening above.
 *
 * Host/gc mode is excluded on #4264's grounds: there `undefined` IS the null
 * extern, and the singleton would surface to host helpers as an object.
 */
import { ts } from "../../ts-api.js";
import { emitUndefinedExtern } from "../any-helpers.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { localGlobalIdx } from "../registry/imports.js";
import { forEachScriptVarDeclaration, scriptVarBindingNames } from "../source-scan-predicates.js";
import { f64MayHoldUndefined, pushUndefF64 } from "../value-tags.js";

/**
 * Emit `global.set $__mod_<name> (undefined)` for every externref module global
 * backed by a module-scope `var`, into the `__module_init` PROLOGUE.
 *
 * The caller must invoke this BEFORE the function-binding seeds (#2931 live
 * bindings, #4394 script global functions, #4182 Annex B block functions):
 * §9.1.1.4.18 creates a `var` binding with `undefined` only when the name is
 * not already present, and GlobalDeclarationInstantiation initialises the
 * function bindings afterwards — so a name that is both a `var` and a function
 * declaration must end up holding the FUNCTION, not this seed.
 */
/** (#6894) Names whose module global the prologue seed wrote, per compile. */
const seededModuleVarNames = new WeakMap<CodegenContext, Set<string>>();

export function emitModuleVarUndefinedSeeds(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  initFctx: FunctionContext,
): void {
  // Context-owned object-record bindings are created only when absent by
  // emitScriptGlobalVarBindings. A private-slot seed would reset a prior
  // Script's live value after all accesses are routed to the shared record.
  if (ctx.standaloneScriptVarBindings && !ctx.sourceIsModule) return;
  const seeded = new Set<number>();
  let seededNames = seededModuleVarNames.get(ctx);
  if (seededNames === undefined) seededModuleVarNames.set(ctx, (seededNames = new Set()));
  for (const varName of scriptVarBindingNames(sourceFile)) {
    const globalIdx = ctx.moduleGlobals.get(varName);
    if (globalIdx === undefined || seeded.has(globalIdx)) continue;
    if (ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type.kind !== "externref") continue;
    if (!emitUndefinedExtern(ctx, initFctx)) continue;
    initFctx.body.push({ op: "global.set", index: globalIdx });
    seeded.add(globalIdx);
    seededNames.add(varName);
  }
}

/**
 * (#7366) The f64 twin of the seed above: a module-scope `var`, an initializer-less top-level `let` or an
 * initializer-less static field whose f64 slot can hold `undefined` (`let g: number | undefined;`) starts as the exact
 * {@link pushUndefF64} sentinel instead of the constant initializer's `0`. A Wasm global initializer is a constant
 * expression, and `f64.const` cannot carry the sentinel's signaling-NaN bits reliably, so the value is stored here.
 * For a `let` the TDZ flag still guards every read before the declaration; the seed is the value its `let g;`
 * statement binds.
 */
export function emitModuleF64UndefinedSeeds(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  initFctx: FunctionContext,
): void {
  for (const globalIdx of moduleF64UndefinedSeedGlobals(ctx, sourceFile)) {
    pushUndefF64(initFctx.body);
    initFctx.body.push({ op: "global.set", index: globalIdx });
  }
}

/** (#7366) `staticProps` keys of the static fields {@link emitModuleF64UndefinedSeeds} seeds, per compile. */
const staticF64UndefinedSeedKeys = new WeakMap<CodegenContext, Set<string>>();

/**
 * Record a static field whose f64 global starts as `undefined`. Keyed by its `staticProps` name, not its global
 * index: a late import shifts the index, and `staticProps` is the map that shift keeps current.
 */
export function noteStaticF64UndefinedSeed(ctx: CodegenContext, staticPropKey: string): void {
  let keys = staticF64UndefinedSeedKeys.get(ctx);
  if (keys === undefined) staticF64UndefinedSeedKeys.set(ctx, (keys = new Set()));
  keys.add(staticPropKey);
}

/**
 * The globals {@link emitModuleF64UndefinedSeeds} stores into, over every source of the graph (one `__module_init`
 * runs them all; `sourceFile` stands in where no graph is recorded):
 * - every module-scope `var`, initialised or not: the binding is created holding `undefined` (§9.1.1.4.18) and its
 *   initializer only assigns later. Skipped where a Script's shared record owns the `var`s, as in
 *   {@link emitModuleVarUndefinedSeeds};
 * - an initializer-less top-level `let` (one with an initializer is unreadable before it runs);
 * - the static fields recorded by {@link noteStaticF64UndefinedSeed}.
 */
export function moduleF64UndefinedSeedGlobals(ctx: CodegenContext, sourceFile: ts.SourceFile): Set<number> {
  const declarations: ts.VariableDeclaration[] = [];
  const scriptRecordOwnsVars = ctx.standaloneScriptVarBindings && !ctx.sourceIsModule;
  for (const source of ctx.callableSourceFiles ?? [sourceFile]) {
    if (source.isDeclarationFile) continue;
    if (!scriptRecordOwnsVars) forEachScriptVarDeclaration(source, (declaration) => declarations.push(declaration));
    for (const statement of source.statements)
      if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Let) !== 0)
        declarations.push(...statement.declarationList.declarations.filter((declaration) => !declaration.initializer));
  }
  const globals = new Set<number>();
  for (const { name } of declarations) {
    if (!ts.isIdentifier(name)) continue;
    const globalIdx = ctx.moduleGlobals.get(name.text);
    const type = globalIdx === undefined ? undefined : ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type;
    if (globalIdx !== undefined && type && f64MayHoldUndefined(ctx, name, type)) globals.add(globalIdx);
  }
  for (const staticPropKey of staticF64UndefinedSeedKeys.get(ctx) ?? []) {
    const globalIdx = ctx.staticProps.get(staticPropKey);
    if (globalIdx !== undefined) globals.add(globalIdx);
  }
  return globals;
}

/**
 * (#6894) True when `emitModuleVarUndefinedSeeds` wrote `undefined` into the
 * module global backing the `var <name>` in the `__module_init` prologue. That
 * slot is fully instantiated before the first statement runs, so evaluating an
 * initializer-less `var <name>;` at its statement position is a no-op
 * (§14.3.2.1) and must emit NO store. A store would clobber whatever the
 * binding holds by then: the hoisted `function <name>` seeded right after this
 * prologue (§9.1.1.4.17 CreateGlobalVarBinding never resets an existing
 * binding), or an assignment that ran earlier (`x = 5; var x;`).
 */
export function moduleVarSlotIsUndefinedSeeded(ctx: CodegenContext, name: string): boolean {
  return seededModuleVarNames.get(ctx)?.has(name) === true;
}
