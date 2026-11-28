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
 * - **Only externref slots here.** A slot the type inference narrowed to a
 *   primitive (`var s = "a"` ⇒ a native-string ref) cannot physically hold the
 *   singleton and keeps its wasm zero-init. An f64 slot that can hold
 *   `undefined` is seeded with the f64 sentinel by
 *   {@link emitModuleF64UndefinedSeeds} below (#7366/#7464).
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
import type { GlobalDef, Instr } from "../../ir/types.js";
import { absoluteGlobalIdx } from "../module-bindings/global-space.js";
import { moduleBindingOf } from "../module-bindings/module-binding-table.js";
import { localGlobalIdx } from "../registry/imports.js";
import { forEachScriptVarDeclaration } from "../source-scan-predicates.js";
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
/** (#6894) The module globals the prologue seed wrote, per compile. */
const seededModuleVarGlobals = new WeakMap<CodegenContext, Set<GlobalDef>>();

export function emitModuleVarUndefinedSeeds(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  initFctx: FunctionContext,
): void {
  // Context-owned object-record bindings are created only when absent by
  // emitScriptGlobalVarBindings. A private-slot seed would reset a prior
  // Script's live value after all accesses are routed to the shared record.
  if (ctx.standaloneScriptVarBindings && !ctx.sourceIsModule) return;
  let seeded = seededModuleVarGlobals.get(ctx);
  if (seeded === undefined) seededModuleVarGlobals.set(ctx, (seeded = new Set()));
  const seededNow = new Set<GlobalDef>();
  // (#7531) Every module's `var`s: one `__module_init` instantiates the whole graph.
  for (const source of ctx.callableSourceFiles ?? [sourceFile]) {
    if (source.isDeclarationFile) continue;
    forEachScriptVarDeclaration(source, (declaration) =>
      forEachBindingLeaf(declaration, (leaf) => {
        const globalIdx = declaredGlobalIdx(ctx, leaf);
        if (globalIdx === undefined) return;
        const global = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
        if (global === undefined || seededNow.has(global) || global.type.kind !== "externref") return;
        if (!emitUndefinedExtern(ctx, initFctx)) return;
        initFctx.body.push({ op: "global.set", index: globalIdx });
        seededNow.add(global);
        seeded.add(global);
      }),
    );
  }
}

type IdentifierLeaf = (ts.VariableDeclaration | ts.BindingElement) & { readonly name: ts.Identifier };

/** Visit every identifier-named leaf of `declaration`'s binding pattern, in source order. */
function forEachBindingLeaf(
  declaration: ts.VariableDeclaration | ts.BindingElement,
  visit: (leaf: IdentifierLeaf) => void,
): void {
  if (ts.isIdentifier(declaration.name)) visit(declaration as IdentifierLeaf);
  else {
    for (const element of declaration.name.elements) {
      if (!ts.isOmittedExpression(element)) forEachBindingLeaf(element, visit);
    }
  }
}

/**
 * The global `declaration` stores into: its own module binding's (#7470), or — for one that owns none, such as a
 * `var` merged into a function binding — whatever the bare name shows.
 */
function declaredGlobalIdx(ctx: CodegenContext, declaration: IdentifierLeaf): number | undefined {
  const binding = moduleBindingOf(ctx, declaration);
  return binding ? absoluteGlobalIdx(ctx, binding.value) : ctx.moduleGlobals.get(declaration.name.text);
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

/**
 * (#7366) The static fields {@link emitModuleF64UndefinedSeeds} seeds, per compile: `staticProps` key → declaration.
 */
const staticF64UndefinedSeeds = new WeakMap<CodegenContext, Map<string, ts.PropertyDeclaration>>();

/**
 * Record a static field whose f64 global starts as `undefined`. Keyed by its `staticProps` name, not its global
 * index: a late import shifts the index, and `staticProps` is the map that shift keeps current.
 */
export function noteStaticF64UndefinedSeed(
  ctx: CodegenContext,
  staticPropKey: string,
  declaration: ts.PropertyDeclaration,
): void {
  let seeds = staticF64UndefinedSeeds.get(ctx);
  if (seeds === undefined) staticF64UndefinedSeeds.set(ctx, (seeds = new Map()));
  seeds.set(staticPropKey, declaration);
}

/**
 * (#7464) Re-seed the `undefined` statics of a class declared in a function body. Each evaluation of the declaration
 * creates a fresh class (§15.7.14 ClassDefinitionEvaluation), but its statics share one global, so the module
 * prologue's seed alone would let one call see the value an earlier call assigned.
 */
export function emitClassStaticF64UndefinedSeeds(
  ctx: CodegenContext,
  body: Instr[],
  decl: ts.ClassLikeDeclaration,
): void {
  for (const [staticPropKey, declaration] of staticF64UndefinedSeeds.get(ctx) ?? []) {
    const globalIdx = ctx.staticProps.get(staticPropKey);
    if (declaration.parent !== decl || globalIdx === undefined) continue;
    pushUndefF64(body);
    body.push({ op: "global.set", index: globalIdx });
  }
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
  const globals = new Set<number>();
  for (const declaration of seedCandidateDeclarations(ctx, sourceFile)) {
    if (!ts.isIdentifier(declaration.name)) continue;
    const globalIdx = declaredGlobalIdx(ctx, declaration as IdentifierLeaf);
    const type = globalIdx === undefined ? undefined : ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type;
    if (globalIdx !== undefined && type && f64MayHoldUndefined(ctx, declaration.name, type)) globals.add(globalIdx);
  }
  for (const staticPropKey of staticF64UndefinedSeeds.get(ctx)?.keys() ?? []) {
    const globalIdx = ctx.staticProps.get(staticPropKey);
    if (globalIdx !== undefined) globals.add(globalIdx);
  }
  return globals;
}

/** The declarations {@link moduleF64UndefinedSeedGlobals} considers. Walked once per compile: its two callers ask
 * at different stages, but the source text they walk does not change between them. */
const seedCandidates = new WeakMap<CodegenContext, readonly ts.VariableDeclaration[]>();
function seedCandidateDeclarations(ctx: CodegenContext, sourceFile: ts.SourceFile): readonly ts.VariableDeclaration[] {
  const cached = seedCandidates.get(ctx);
  if (cached) return cached;
  const declarations: ts.VariableDeclaration[] = [];
  const scriptRecordOwnsVars = ctx.standaloneScriptVarBindings && !ctx.sourceIsModule;
  for (const source of ctx.callableSourceFiles ?? [sourceFile]) {
    if (source.isDeclarationFile) continue;
    if (!scriptRecordOwnsVars) forEachScriptVarDeclaration(source, (declaration) => declarations.push(declaration));
    for (const statement of source.statements)
      if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Let) !== 0)
        declarations.push(...statement.declarationList.declarations.filter((declaration) => !declaration.initializer));
  }
  seedCandidates.set(ctx, declarations);
  return declarations;
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
  const globalIdx = ctx.moduleGlobals.get(name);
  const global = globalIdx === undefined ? undefined : ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
  return global !== undefined && seededModuleVarGlobals.get(ctx)?.has(global) === true;
}
