// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3364) Per-declaration keys for the empty-object shape-widening maps
 * (`widenedTypeProperties` / `widenedVarStructMap`).
 *
 * These maps record the synthesized struct shape for a `var x = {}` that later
 * receives out-of-shape property writes (`x.a = …`). They were originally keyed
 * by the BARE variable name (`x`). That collides across functions: acorn's
 * parser reuses generic local names (`node`, `type`, `parent`, …) in many
 * functions, each building an object with a DIFFERENT field set. With bare-name
 * keying the LAST widening for a given name overwrote all the others, so every
 * other same-named var built the WRONG (foreign) struct — its real field values
 * were dropped at `struct.new`, and reads of the missing ref/string fields
 * (`.callee`, `.type`, `.arguments`, …) returned null. A full recursive in-Wasm
 * walk over such objects then mis-descended and ran away (#3364 / #3308).
 *
 * The fix keys the maps by name PLUS the declaration's source start offset,
 * which is unique per declaration site within a module. The SET side (the
 * widening pre-pass and the literal builder) has the declaration identifier
 * directly; USE sites (member reads/writes, delete, typeof, `in`) resolve the
 * receiver identifier's symbol to its `valueDeclaration` and recompute the same
 * key, so both sides agree. When a use site cannot be resolved to a widened
 * declaration the lookup simply misses — identical to the previous
 * bare-name-miss behavior — and the value stays on the dynamic `$Object` path.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/**
 * Build the per-declaration key for a widened `{}` variable, given its
 * declaration-site name identifier. Uses the identifier's source start offset,
 * which is stable and unique per declaration within the source file.
 */
export function widenedVarKeyFromDecl(name: ts.Identifier): string {
  // getStart() is safe for real source nodes (all widened decls are). Fall back
  // to `pos` defensively for any synthesized node.
  let offset: number;
  try {
    offset = name.getStart();
  } catch {
    offset = name.pos;
  }
  return `${name.text}@${offset}`;
}

/**
 * Resolve a USE-site receiver identifier to the per-declaration key of the
 * widened variable it refers to, or `undefined` when it does not resolve to a
 * simple `var/let/const <name>` declaration (in which case the caller treats it
 * as a non-widened receiver, exactly like the old bare-name miss).
 */
export function resolveWidenedVarKey(ctx: CodegenContext, ident: ts.Identifier): string | undefined {
  const sym = ctx.checker.getSymbolAtLocation(ident);
  const decl = sym?.valueDeclaration;
  if (decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
    return widenedVarKeyFromDecl(decl.name);
  }
  return undefined;
}

/**
 * Convenience: the registered widened struct name for a USE-site receiver
 * identifier, or `undefined` when the receiver is not a widened `{}` variable.
 * Combines {@link resolveWidenedVarKey} with the `widenedVarStructMap` lookup.
 */
export function widenedStructNameForUse(ctx: CodegenContext, ident: ts.Identifier): string | undefined {
  const key = resolveWidenedVarKey(ctx, ident);
  return key === undefined ? undefined : ctx.widenedVarStructMap.get(key);
}

/**
 * (#3403) The per-declaration key for the object-INTEGRITY tracking maps
 * (`frozenVars` / `sealedVars` / `nonExtensibleVars` and the `varName`-half of
 * the `definedPropertyFlags` / `widenedDefinePropertyKeys` composite keys).
 *
 * These maps were originally keyed by the BARE identifier text, module-wide, so
 * a `const o = {}; Object.freeze(o)` in one function poisoned every other
 * function's `o` (spurious "assign to frozen" / "cannot redefine" throws —
 * #3403, same archetype as #3364's shape maps). This resolves the receiver
 * identifier to its declaration-scoped key (`name@declStart`) via
 * {@link resolveWidenedVarKey}, so same-named locals in different functions get
 * DISTINCT keys.
 *
 * Falls back to the bare `ident.text` when the identifier does NOT resolve to a
 * local `var/let/const` declaration — i.e. module-level / ambient globals with
 * no `valueDeclaration` keep exactly today's behavior (they cannot collide
 * cross-function anyway). SET and USE sites both route through this (or through
 * {@link widenedVarKeyFromDecl} at a declaration site), so the two agree on the
 * same key for the same variable.
 */
export function integrityVarKey(ctx: CodegenContext, ident: ts.Identifier): string {
  return resolveWidenedVarKey(ctx, ident) ?? ident.text;
}
