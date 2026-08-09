// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#743) `.d.ts` entrypoint seeding — front-end seed collection.
//
// Problem: a `.js`/`.mjs` package entry's EXPORTED functions have no internal
// call sites (they are called from outside the module), so neither the IR
// fixpoint (`src/ir/propagate.ts`) nor the legacy call-site scan
// (`src/codegen/declarations/param-return-inference.ts`) ever gets a seed for
// their parameters — every inference chain starting at an entrypoint bottoms
// out at `dynamic`. But packages that SHIP declarations (acorn:
// `dist/acorn.d.ts` says `parse(input: string, options: Options)`) state
// exactly what those parameters are.
//
// This module turns a shipped sibling `.d.ts` into a per-export, per-parameter
// SEED map that both inference lanes consult from the SAME object, so the two
// lanes cannot see different seeds (the "function typeIdx parity mismatch"
// hazard). Seeds are claims, not proofs:
//
//  - SEED, do not force — the IR fixpoint starts a seeded parameter at the
//    declared atom and still JOINS every internal call site's evidence on top,
//    so a conflicting internal caller widens per the lattice (evidence beats
//    the claim). The legacy lane consults the seed only in its
//    `sawCallSite === false` arm (#3471's exported-entrypoint case) — any
//    internal call site wins outright.
//  - TRUST BOUNDARY — a `.d.ts` is a claim an external caller can violate.
//    Seeded parameters therefore only narrow to types whose entry path is
//    already guarded by the WebAssembly boundary itself: `number` → an `f64`
//    param (the JS API applies ToNumber; a violating argument becomes NaN,
//    never a reinterpreted bit pattern) and `string` → the native-string ref
//    param (a violating argument fails the JS API's typed-reference conversion
//    with a TypeError before the body runs; in externref-string lanes the seed
//    is a no-op at the ABI). No other declared type is seeded in this slice —
//    interface/object types (`options: Options`) intentionally collect as
//    `null` (unseedable) so the report can name them.
//
// Everything is gated on `JS2WASM_DTS_ENTRYPOINT_SEEDS` (**ON by default since
// 2026-08-08**; `=0` disables): with the flag off, `resolveDtsEntryDeclarations`
// returns undefined, no extra Program root is added, no seed map exists, and
// compilation is byte-identical to the pre-flip compiler.

import { dtsEntrypointSeedsFlagEnabled } from "../derivation-flags.js";
import { getDefaultEnvironment } from "../env.js";
import { ts } from "../ts-api.js";

/** Synthetic Program root name for the entry's sibling declaration file. */
export const DTS_ENTRY_DECLS_NAME = "__entry_declarations__.d.ts";

/**
 * Seedable declared-parameter atoms. Deliberately only the two types whose
 * export boundary already carries a coercion/trap guard (see module doc).
 */
export type DtsSeedAtom = "f64" | "string";

/**
 * Per LOCAL top-level function name (the name both inference lanes key on),
 * the declared per-parameter seed — `null` marks an unseedable position
 * (no annotation, optional/rest, or a type outside the guarded set).
 */
export type DtsEntrypointSeeds = ReadonlyMap<string, readonly (DtsSeedAtom | null)[]>;

/**
 * **ON by default since 2026-08-08** (#743 derivation-defaults flip);
 * `JS2WASM_DTS_ENTRYPOINT_SEEDS=0` restores the pre-flip behaviour. Spelling
 * rule and rationale: `src/derivation-flags.ts`. Re-read per call so tests can
 * flip it.
 *
 * Default-ON widens this pass's reach beyond anything it was measured on: the
 * on-disk sibling discovery below fires for ANY `.js`/`.mjs`/`.cjs` entry with
 * a neighbouring declaration file, and the only corpus it was measured against
 * is acorn (where it moved nothing: census 54/1/41 unchanged, +336 B). What
 * bounds the risk is not the measurement but the seed restriction — only
 * `string`/`number`, the two declared types whose export boundary already
 * guards a violating external caller.
 */
export function dtsEntrypointSeedsEnabled(): boolean {
  return dtsEntrypointSeedsFlagEnabled();
}

/**
 * Resolve the declaration text for a `.js`/`.mjs`/`.cjs` entry, flag-gated.
 *
 * Precedence: an explicit `CompileOptions.entryDeclarations` string wins
 * (in-memory callers — the dogfood harness, tests); otherwise, when the entry
 * fileName is a real on-disk path, its sibling declaration file is read
 * (`x.mjs` → `x.d.mts` then `x.d.ts`; `x.js` → `x.d.ts`; `x.cjs` → `x.d.cts`
 * then `x.d.ts`). Returns undefined — and therefore changes nothing — when
 * the flag is off, the entry is not a JS file, or no declaration exists.
 */
export function resolveDtsEntryDeclarations(
  fileName: string | undefined,
  explicit: string | undefined,
): string | undefined {
  if (!dtsEntrypointSeedsEnabled()) return undefined;
  const ext = fileName?.match(/\.(js|mjs|cjs)$/)?.[1];
  if (ext === undefined) return undefined;
  if (explicit !== undefined) return explicit;
  const fs = getDefaultEnvironment().fs;
  if (!fs || fileName === undefined) return undefined;
  const stem = fileName.slice(0, -(ext.length + 1));
  const candidates =
    ext === "mjs"
      ? [`${stem}.d.mts`, `${stem}.d.ts`]
      : ext === "cjs"
        ? [`${stem}.d.cts`, `${stem}.d.ts`]
        : [`${stem}.d.ts`];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf-8");
    } catch {
      // Unreadable sibling — behave as if no declarations ship.
    }
  }
  return undefined;
}

function seedAtomOfTypeNode(node: ts.TypeNode): DtsSeedAtom | null {
  switch (node.kind) {
    case ts.SyntaxKind.NumberKeyword:
      return "f64";
    case ts.SyntaxKind.StringKeyword:
      return "string";
    default:
      return null;
  }
}

function paramSeeds(declaration: ts.FunctionDeclaration): (DtsSeedAtom | null)[] {
  return declaration.parameters.map((parameter) => {
    // Optional/defaulted/rest positions have under-application semantics an
    // unboxed seed cannot represent; leave them unseeded.
    if (parameter.questionToken || parameter.initializer || parameter.dotDotDotToken) return null;
    return parameter.type ? seedAtomOfTypeNode(parameter.type) : null;
  });
}

/** Position-wise agreement merge for overloads / aliased re-exports. */
function mergeSeeds(
  left: readonly (DtsSeedAtom | null)[],
  right: readonly (DtsSeedAtom | null)[],
): (DtsSeedAtom | null)[] {
  const merged: (DtsSeedAtom | null)[] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i] ?? null;
    const b = right[i] ?? null;
    merged.push(a === b ? a : null);
  }
  return merged;
}

function hasModifier(declaration: ts.FunctionDeclaration, kind: ts.SyntaxKind): boolean {
  return declaration.modifiers?.some((modifier) => modifier.kind === kind) === true;
}

/**
 * Map exported-name → LOCAL top-level function name for the compiled entry:
 * `export function f` contributes `f → f`; `export { local as pub }` (no
 * module specifier) contributes `pub → local` when `local` names a top-level
 * function declaration. Default exports are out of scope for this slice.
 */
function exportedFunctionLocals(entrySourceFile: ts.SourceFile): Map<string, string> {
  const topLevelFunctionNames = new Set<string>();
  for (const statement of entrySourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      topLevelFunctionNames.add(statement.name.text);
    }
  }
  const localByExported = new Map<string, string>();
  for (const statement of entrySourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      statement.body &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      !hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    ) {
      localByExported.set(statement.name.text, statement.name.text);
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const specifier of statement.exportClause.elements) {
        const local = (specifier.propertyName ?? specifier.name).text;
        if (topLevelFunctionNames.has(local)) localByExported.set(specifier.name.text, local);
      }
    }
  }
  return localByExported;
}

/**
 * Build the seed map from a parsed declaration file and the compiled entry.
 *
 * Only names that are BOTH declared as `export function` in the `.d.ts` AND
 * exported top-level function declarations of the entry module are seeded —
 * keyed by the LOCAL declaration name, which is what both inference lanes
 * match on. Returns undefined when nothing is seedable so callers can treat
 * "no declarations" and "declarations with nothing usable" identically.
 */
export function collectDtsEntrypointSeeds(
  dtsSourceFile: ts.SourceFile | undefined,
  entrySourceFile: ts.SourceFile,
): DtsEntrypointSeeds | undefined {
  if (!dtsSourceFile) return undefined;

  const declared = new Map<string, (DtsSeedAtom | null)[]>();
  for (const statement of dtsSourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    const name = statement.name.text;
    const seeds = paramSeeds(statement);
    const existing = declared.get(name);
    declared.set(name, existing ? mergeSeeds(existing, seeds) : seeds);
  }
  if (declared.size === 0) return undefined;

  const localByExported = exportedFunctionLocals(entrySourceFile);
  const out = new Map<string, (DtsSeedAtom | null)[]>();
  for (const [exportedName, seeds] of declared) {
    const local = localByExported.get(exportedName);
    if (local === undefined) continue;
    const existing = out.get(local);
    out.set(local, existing ? mergeSeeds(existing, seeds) : seeds);
  }
  for (const [local, seeds] of out) {
    if (!seeds.some((seed) => seed !== null)) out.delete(local);
  }
  return out.size > 0 ? out : undefined;
}
