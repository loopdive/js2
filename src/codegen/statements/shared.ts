// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared utilities used across all statement sub-modules.
 * No dependencies on other statement sub-modules or on statements.ts itself.
 */
import { ts } from "../../ts-api.js";
import type { Instr } from "../../ir/types.js";
import type { CodegenContext, FunctionContext, NullGuardFact } from "../context/types.js";

/**
 * Adjust the depth of all entries in the catchRethrowStack by `delta`.
 * Called wherever breakStack entries are bulk-adjusted for block nesting changes.
 */
export function adjustRethrowDepth(fctx: FunctionContext, delta: number): void {
  if (fctx.catchRethrowStack) {
    for (let i = 0; i < fctx.catchRethrowStack.length; i++) {
      fctx.catchRethrowStack[i]!.depth += delta;
    }
  }
}

/**
 * Collect instructions emitted by `emitFn` into a separate array without
 * appending them to the current `fctx.body`.  This replaces the pervasive
 * "save body / swap / restore" pattern that was duplicated dozens of times.
 */
export function collectInstrs(fctx: FunctionContext, emitFn: () => void): Instr[] {
  const saved = fctx.body;
  // Register saved body so late import shifts can find it (#801).
  // Without this, ensureLateImport/shiftLateImportIndices during emitFn
  // would miss the saved body when updating function indices.
  fctx.savedBodies.push(saved);
  fctx.body = [];
  emitFn();
  const instrs = fctx.body;
  fctx.body = saved;
  fctx.savedBodies.pop();
  return instrs;
}

// ---------------------------------------------------------------------------
// Block scope helpers — used by loops, exceptions, and the dispatcher
// ---------------------------------------------------------------------------

/** Saved state for a block scope: localMap + optional TDZ/const flags */
export interface BlockScopeSave {
  locals: Map<string, number> | null;
  tdzFlags: Map<string, number> | null;
  constBindings: Map<string, boolean> | null;
  nullGuardAliases: Map<string, NullGuardFact | null> | null;
  /**
   * #2825 — entry-state snapshot of the module-level captured-global maps for
   * this block's block-scoped names. A block-nested class's capture-promotion
   * (`promoteAccessorCapturesToGlobals`) registers `ctx.capturedGlobals[name]`
   * (a `__captured_<name>` module global) and is name-keyed with no scope
   * discrimination. Without scoping, that registration LEAKS past the block:
   * a later same-named (outer / sibling-block) binding's class capture hits the
   * `capturedGlobals.has(name)` short-circuit and wrongly reuses the inner
   * block's global. We snapshot the entry-state (value or `undefined`/`false`
   * for "absent") here, read-only, and on block exit delete/restore any entry
   * the block's nested-class promotion added or changed. Maps the block-scoped
   * name → its pre-block value (`undefined` = was absent).
   */
  capturedGlobals: Map<string, number | undefined> | null;
  tdzGlobals: Map<string, number | undefined> | null;
  capturedGlobalsWidened: Map<string, boolean> | null;
}

function collectBindingPatternNames(pattern: ts.BindingPattern, names: string[]): void {
  for (const el of pattern.elements) {
    if (ts.isOmittedExpression(el)) continue;
    if (ts.isIdentifier(el.name)) {
      names.push(el.name.text);
    } else if (ts.isObjectBindingPattern(el.name) || ts.isArrayBindingPattern(el.name)) {
      collectBindingPatternNames(el.name, names);
    }
  }
}

/**
 * Collect the names of block-scoped (let/const) variable declarations that
 * are direct children of a block (not nested blocks — those handle their own).
 */
export function collectBlockScopedNames(stmt: ts.Block): string[] {
  const names: string[] = [];
  for (const s of stmt.statements) {
    if (!ts.isVariableStatement(s)) continue;
    const flags = s.declarationList.flags;
    // let/const/using/await-using create block-scoped bindings (not var). #1177
    if (
      !(flags & ts.NodeFlags.Let) &&
      !(flags & ts.NodeFlags.Const) &&
      !(flags & ts.NodeFlags.Using) &&
      !(flags & ts.NodeFlags.AwaitUsing)
    )
      continue;
    for (const decl of s.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) {
        names.push(decl.name.text);
      }
      // For destructuring patterns, collect all bound names
      else if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
        collectBindingPatternNames(decl.name, names);
      }
    }
  }
  return names;
}

/**
 * Save localMap (and TDZ flag) entries for block-scoped names that shadow
 * existing locals.  Also removes the shadow entries from localMap (and
 * tdzFlagLocals) so that compileVariableStatement will allocate fresh locals.
 * Returns the saved state to restore after the block.
 */
export function saveBlockScopedShadows(
  ctx: CodegenContext,
  fctx: FunctionContext,
  block: ts.Block,
): BlockScopeSave | null {
  const blockNames = collectBlockScopedNames(block);
  if (blockNames.length === 0) return null;

  let savedLocals: Map<string, number> | null = null;
  let savedTdz: Map<string, number> | null = null;
  let savedConstBindings: Map<string, boolean> | null = null;
  let savedNullGuardAliases: Map<string, NullGuardFact | null> | null = null;
  // #2825 — entry-state snapshot of the module-level captured-global maps for
  // this block's names (read-only; we do NOT clear at entry so existing byte
  // output is unchanged). Block exit reconciles against this to undo any
  // block-scoped capture-global a nested class registered.
  let savedCapturedGlobals: Map<string, number | undefined> | null = null;
  let savedTdzGlobals: Map<string, number | undefined> | null = null;
  let savedCapturedGlobalsWidened: Map<string, boolean> | null = null;
  for (const name of blockNames) {
    if (!savedConstBindings) savedConstBindings = new Map();
    savedConstBindings.set(name, fctx.constBindings?.has(name) ?? false);
    fctx.constBindings?.delete(name);
    if (!savedNullGuardAliases) savedNullGuardAliases = new Map();
    savedNullGuardAliases.set(name, fctx.nullGuardAliases?.get(name) ?? null);
    fctx.nullGuardAliases?.delete(name);

    if (!savedCapturedGlobals) savedCapturedGlobals = new Map();
    savedCapturedGlobals.set(name, ctx.capturedGlobals.get(name));
    if (!savedTdzGlobals) savedTdzGlobals = new Map();
    savedTdzGlobals.set(name, ctx.tdzGlobals.get(name));
    if (!savedCapturedGlobalsWidened) savedCapturedGlobalsWidened = new Map();
    savedCapturedGlobalsWidened.set(name, ctx.capturedGlobalsWidened.has(name));

    const existing = fctx.localMap.get(name);
    if (existing !== undefined) {
      if (!savedLocals) savedLocals = new Map();
      savedLocals.set(name, existing);
      // Remove from localMap so the inner declaration allocates a fresh local
      fctx.localMap.delete(name);
      // Also save and remove any TDZ flag for this name
      if (fctx.tdzFlagLocals) {
        const tdzIdx = fctx.tdzFlagLocals.get(name);
        if (tdzIdx !== undefined) {
          if (!savedTdz) savedTdz = new Map();
          savedTdz.set(name, tdzIdx);
          fctx.tdzFlagLocals.delete(name);
        }
      }
    }
  }
  return {
    locals: savedLocals,
    tdzFlags: savedTdz,
    constBindings: savedConstBindings,
    nullGuardAliases: savedNullGuardAliases,
    capturedGlobals: savedCapturedGlobals,
    tdzGlobals: savedTdzGlobals,
    capturedGlobalsWidened: savedCapturedGlobalsWidened,
  };
}

/**
 * Restore localMap (and TDZ flag) entries that were saved before entering
 * a block scope.
 */
export function restoreBlockScopedShadows(
  ctx: CodegenContext,
  fctx: FunctionContext,
  saved: BlockScopeSave | null,
): void {
  if (!saved) return;
  if (saved.locals) {
    for (const [name, idx] of saved.locals) {
      fctx.localMap.set(name, idx);
    }
  }
  if (saved.tdzFlags) {
    if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
    for (const [name, idx] of saved.tdzFlags) {
      fctx.tdzFlagLocals.set(name, idx);
    }
  }
  if (saved.constBindings) {
    if (!fctx.constBindings) fctx.constBindings = new Set();
    for (const [name, hadConstBinding] of saved.constBindings) {
      if (hadConstBinding) fctx.constBindings.add(name);
      else fctx.constBindings.delete(name);
    }
  }
  if (saved.nullGuardAliases) {
    if (!fctx.nullGuardAliases) fctx.nullGuardAliases = new Map();
    for (const [name, alias] of saved.nullGuardAliases) {
      if (alias) fctx.nullGuardAliases.set(name, alias);
      else fctx.nullGuardAliases.delete(name);
    }
  }
  // #2825 — reconcile the module-level captured-global maps against the
  // block-entry snapshot. A block-nested class's `promoteAccessorCapturesToGlobals`
  // may have registered a `__captured_<name>` global keyed only by name; that
  // entry is block-scoped and must NOT leak past the block, or a later
  // same-named (outer / sibling-block) binding's class capture would reuse it
  // (the `capturedGlobals.has(name)` short-circuit). For each block-scoped name:
  // if the current entry differs from the pre-block snapshot, the block added or
  // shadowed it → delete (was absent) or restore the outer value (was present).
  // No-op when the block registered nothing (the common case), keeping existing
  // output byte-identical.
  if (saved.capturedGlobals) {
    for (const [name, prev] of saved.capturedGlobals) {
      const curr = ctx.capturedGlobals.get(name);
      if (curr === prev) continue;
      if (prev === undefined) ctx.capturedGlobals.delete(name);
      else ctx.capturedGlobals.set(name, prev);
    }
  }
  if (saved.tdzGlobals) {
    for (const [name, prev] of saved.tdzGlobals) {
      const curr = ctx.tdzGlobals.get(name);
      if (curr === prev) continue;
      if (prev === undefined) ctx.tdzGlobals.delete(name);
      else ctx.tdzGlobals.set(name, prev);
    }
  }
  if (saved.capturedGlobalsWidened) {
    for (const [name, had] of saved.capturedGlobalsWidened) {
      const has = ctx.capturedGlobalsWidened.has(name);
      if (has === had) continue;
      if (had) ctx.capturedGlobalsWidened.add(name);
      else ctx.capturedGlobalsWidened.delete(name);
    }
  }
}
