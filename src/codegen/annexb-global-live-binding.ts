// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#4182) Annex B B.3.3.2 — Changes to GlobalDeclarationInstantiation, for
 * MODULE-SCOPE (global-code) block-nested sloppy function declarations.
 *
 * A top-level `{ function f() {} }` / `if (x) function f() {}` /
 * `switch … case: function f() {}` used to bind STATICALLY through
 * `ctx.funcMap`: a bare `f` read compiled before the block already saw the
 * compiled function (spec: `undefined` until the declaration EVALUATES,
 * B.3.3.2.b CreateGlobalFunctionBinding(F, undefined)), and the
 * evaluation-point `SetMutableBinding` (B.3.3.2.c.vi) never happened at all —
 * so an outer `function f(){…}` was never updated by a later block `f`, and a
 * second block `f` was silently skipped (`funcMap.has` early-return).
 *
 * The function-scope Annex B machinery (`fctx.annexBOuterBindings` TDZ locals,
 * the #4131 existing-var update) writes `fctx.localMap` LOCALS and therefore
 * cannot fire at module scope, where the bindings are module GLOBALS.
 *
 * This module reuses the #2931 live-binding-global mechanism instead:
 *  1. `registerAnnexBGlobalLiveBindings` (run after `collectDeclarations`,
 *     before any body compiles) backs each eligible name with a mutable
 *     `externref` module global and marks it in `ctx.annexBModuleBindings` +
 *     `ctx.liveFuncBindingGlobals`, so every read/write/typeof/call routes
 *     through the global.
 *  2. The `__module_init` seed loop (declarations.ts) seeds the global with the
 *     closure of a REAL top-level `function f` when one exists (GDI initializes
 *     that one normally) and leaves it null (= `undefined`) otherwise — the
 *     `annexBModuleGlobalSeedsFromTopLevel` split below.
 *  3. `tryCompileAnnexBModuleBlockFnEvaluation` (statements.ts
 *     FunctionDeclaration arm) implements the B.3.3.2.c evaluation step:
 *     compile the block function as its OWN Wasm function (each declaration
 *     separately — duplicates included) and `global.set` its closure at the
 *     declaration's textual position in `__module_init`.
 *
 * Deliberately NOT touched: function-code B.3.3.1 (#2200 Phase 2 — a previous
 * attempt cost −1180) and eval-code (#4137). Everything here is gated on
 * `ctx.annexBModuleBindings` (normally empty) + `fctx.name === "__module_init"`,
 * so programs without a module-scope sloppy block function are byte-identical.
 */

import type { Instr } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { annexBDeclaringRange, enclosingVarScope, hasInterveningLexicalBinder } from "./annexb-cancel.js";
import { emitCachedFuncClosureAccess } from "./closures.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { isStrictContext } from "./helpers/is-strict-function.js";
import { localGlobalIdx, nextModuleGlobalIdx } from "./registry/imports.js";
import { emitRuntimeEvalAotCallableAdapter } from "./runtime-eval-callable.js";
import { compileNestedFunctionDeclaration } from "./statements/nested-declarations.js";

/** Var-scope / class boundaries the module-scope walk must not descend into. */
function isScopeOrClassBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isClassStaticBlockDeclaration(node) ||
    ts.isModuleDeclaration(node)
  );
}

/** Top-level `let`/`const`/`class` binder for `name` (B.3.3.2.a — creating the
 * web-compat var binding would be an early error, so no binding is created). */
function topLevelLexicallyBinds(sf: ts.SourceFile, name: string): boolean {
  for (const s of sf.statements) {
    if (ts.isVariableStatement(s) && (s.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0) {
      for (const d of s.declarationList.declarations) {
        if (bindingNameBinds(d.name, name)) return true;
      }
    }
    if (ts.isClassDeclaration(s) && s.name?.text === name) return true;
  }
  return false;
}

function bindingNameBinds(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  for (const el of binding.elements) {
    if (!ts.isOmittedExpression(el) && bindingNameBinds(el.name, name)) return true;
  }
  return false;
}

/**
 * Is `name` REASSIGNED anywhere inside `range` (including nested function
 * bodies)? The spec keeps the block-LOCAL lexical binding distinct from the
 * global var binding — `{ function f() { f = 123; } }` mutates only the block
 * binding (the `*-block-scoping` files assert exactly this). One shared global
 * cannot model that split, so a reassigned name keeps today's static path.
 * Deliberately over-broad (any write anywhere in the declaring range excludes
 * the name): an excluded name is byte-identical to main.
 */
function nameReassignedInRange(range: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      found = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand) &&
      node.operand.text === name
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(range);
  return found;
}

/**
 * Collect every module-scope Annex-B-eligible block-nested `function f` in
 * `sf`, keyed by name. A declaration is eligible when it sits in an Annex B
 * statement position whose enclosing var scope is the SourceFile itself and no
 * intervening lexical binder cancels the web-compat binding.
 */
function collectModuleBlockFunctions(sf: ts.SourceFile): Map<string, ts.FunctionDeclaration[]> {
  const byName = new Map<string, ts.FunctionDeclaration[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.text;
      if (
        name !== undefined &&
        node.body !== undefined &&
        annexBDeclaringRange(node) !== null &&
        enclosingVarScope(node) === sf &&
        !hasInterveningLexicalBinder(node.parent, name, sf)
      ) {
        const list = byName.get(name);
        if (list) list.push(node);
        else byName.set(name, [node]);
      }
      return; // its body is a nested var scope — nothing below is module-scope
    }
    if (node !== sf && isScopeOrClassBoundary(node)) return;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return byName;
}

/**
 * Registration pass — run after `collectDeclarations` (module globals + the
 * top-level `funcMap` entries exist) and BEFORE any body / module-init
 * statement compiles, mirroring #2931's `registerReassignedFunctionGlobals`.
 */
export function registerAnnexBGlobalLiveBindings(ctx: CodegenContext, sourceFiles: readonly ts.SourceFile[]): void {
  for (const sf of sourceFiles) {
    if (sf.isDeclarationFile) continue;
    // Strict global code has no B.3.3.2 web-compat extension. Under the default
    // `inferModuleStrict` a genuine ES module is strict, which confines this
    // pass to script-mode compiles (the test262 sloppy lane).
    if (isStrictContext(sf, ctx.inferModuleStrictArguments ?? true)) continue;
    const byName = collectModuleBlockFunctions(sf);
    if (byName.size === 0) continue;
    for (const [name, decls] of byName) {
      if (topLevelLexicallyBinds(sf, name)) continue; // B.3.3.2.a — no binding
      if (ctx.classSet.has(name)) continue;
      if (decls.some((fd) => nameReassignedInRange(annexBDeclaringRange(fd) ?? fd, name))) continue;
      const bindings = (ctx.annexBModuleBindings ??= new Set<string>());
      if (bindings.has(name)) continue;
      let globalIdx = ctx.moduleGlobals.get(name);
      if (globalIdx === undefined) {
        globalIdx = nextModuleGlobalIdx(ctx);
        ctx.mod.globals.push({
          name: `__mod_${name}`,
          type: { kind: "externref" },
          mutable: true,
          init: [{ op: "ref.null.extern" }],
        });
        ctx.moduleGlobals.set(name, globalIdx);
      } else {
        const global = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
        if (!global) continue;
        if (global.type.kind !== "externref") {
          // Only widen the value-typed carriers (`var f = 123`). A ref-typed
          // global (e.g. a struct-shaped `var f = {…}`) has readers compiled
          // against its heap type — leave such names on today's path.
          if (global.type.kind !== "f64" && global.type.kind !== "i32") continue;
          global.type = { kind: "externref" };
          global.init = [{ op: "ref.null.extern" }] as Instr[];
        }
      }
      bindings.add(name);
      (ctx.liveFuncBindingGlobals ??= new Set<string>()).add(name);
      // CreateGlobalFunctionBinding makes an enumerable, non-configurable
      // global-object property — expose it to the global-object read path and
      // the runtime-eval script-binding sync like any script `var`.
      (ctx.globalObjectVarBindings ??= new Set<string>()).add(name);
    }
  }
}

/** Seed-loop split (declarations.ts `__module_init` prologue): a name declared
 * ONLY in blocks starts `undefined`; one that also has a real top-level
 * `function f` is initialized with that closure by GDI. */
export function annexBModuleGlobalSeedsFromTopLevel(ctx: CodegenContext, name: string): boolean {
  if (!ctx.annexBModuleBindings?.has(name)) return true; // not ours — seed as before (#2931)
  return ctx.topLevelFunctionDeclarations.has(name);
}

/**
 * B.3.3.2.c — the evaluation step, emitted at the declaration's textual
 * position while compiling `__module_init`. Compiles THIS declaration node as
 * its own Wasm function (idempotent across the #2965 two-pass init compile via
 * a per-node cache) and stores its closure into the live-binding global.
 * Returns true when the statement was fully handled.
 */
export function tryCompileAnnexBModuleBlockFnEvaluation(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.FunctionDeclaration,
): boolean {
  const name = stmt.name?.text;
  if (name === undefined || !ctx.annexBModuleBindings?.has(name)) return false;
  if (fctx.name !== "__module_init") return false;
  if (annexBDeclaringRange(stmt) === null) return false; // the top-level twin follows the normal path
  const globalIdx = ctx.moduleGlobals.get(name);
  if (globalIdx === undefined) return false;

  const cache = (ctx.annexBModuleFnIdxByDecl ??= new WeakMap<ts.FunctionDeclaration, number>());
  let fnIdx = cache.get(stmt);
  if (fnIdx === undefined) {
    // Compile this declaration as its OWN function. `funcMap` is keyed by bare
    // name, so temporarily clear the entry (a top-level `function f` or an
    // earlier same-named block declaration) to force a fresh registration, then
    // restore top-level ownership: the seed loop and the static fallbacks must
    // keep resolving the GDI winner, not the last block declaration.
    const savedIdx = ctx.funcMap.get(name);
    const savedOwner = ctx.funcMapOwnerDecl.get(name);
    ctx.funcMap.delete(name);
    ctx.funcMapOwnerDecl.delete(name);
    compileNestedFunctionDeclaration(ctx, fctx, stmt);
    const newIdx = ctx.funcMap.get(name);
    if (ctx.topLevelFunctionDeclarations.has(name) && savedIdx !== undefined) {
      ctx.funcMap.set(name, savedIdx);
      if (savedOwner !== undefined) ctx.funcMapOwnerDecl.set(name, savedOwner);
      else ctx.funcMapOwnerDecl.delete(name);
    }
    if (newIdx === undefined) {
      // Compilation failed — restore and fall back to the legacy path.
      if (savedIdx !== undefined) ctx.funcMap.set(name, savedIdx);
      if (savedOwner !== undefined) ctx.funcMapOwnerDecl.set(name, savedOwner);
      return false;
    }
    fnIdx = newIdx;
    cache.set(stmt, fnIdx);
  }

  // benvRec.GetBindingValue(F) → fobj ; genvRec.SetMutableBinding(F, fobj).
  const closureType = emitCachedFuncClosureAccess(ctx, fctx, name, fnIdx);
  if (closureType === null) return true; // no safe closure — leave the binding untouched
  if (closureType.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
  if (ctx.runtimeEvalGlobalFunctionBindings) emitRuntimeEvalAotCallableAdapter(ctx, fctx);
  fctx.body.push({ op: "global.set", index: globalIdx });
  return true;
}
