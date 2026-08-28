// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5096) "Is this symbol a USER binding that shadows the ambient intrinsic of
// the same name?"
//
// Several independent places in the compiler decide what a value IS by matching
// its symbol's NAME against a set of intrinsic spellings — the type-fact
// classifier's `BUILTIN_NAMES` (checker/oracle.ts), `resolveWasmType`'s
// `Date`/`Map`/`Set`/TypedArray/wrapper arms (codegen/index.ts), and the
// `new`-dispatch arms keyed on the callee's text. Per §9.1 a spelling match is
// not a claim: any lexical/var binding in scope shadows the global, so
// `class Date { … }` owns the name `Date` for every reference below it.
//
// This module is the ONE definition of that question, shared so the answer
// cannot drift between the sites that ask it. Each caller keeps its own notion
// of WHICH names it claims; this only answers whether the binding behind a
// given symbol is the intrinsic or the user's.
import { ts } from "../ts-api.js";

const cache = new WeakMap<ts.Symbol, boolean>();

/**
 * True when `sym` has a USER **value** declaration — a declaration outside a
 * `.d.ts` that actually BINDS the name.
 *
 * The "value binding" qualifier is the load-bearing part, not a detail. A
 * global AUGMENTATION (`declare global { interface Map<K,V> { … } }`, or a
 * `.ts` file adding a member to `Array`) merges a user-file declaration onto
 * the INTRINSIC's own symbol without introducing a new binding. Reading that as
 * a shadow would drop every `Map`/`Array` lowering in a program that merely
 * augments a lib type — a much larger blast radius than the bug this predicate
 * exists to fix. So interface/type-alias/namespace/enum merges deliberately do
 * NOT count; only class, function, `var`/`let`/`const`, parameter, destructured
 * binding, and imports of the name do.
 *
 * Conservative in the safe direction: anything it cannot see answers `false`,
 * which is the historical (intrinsic-claiming) behaviour.
 */
export function symbolShadowsBuiltinGlobal(sym: ts.Symbol | undefined): boolean {
  if (sym === undefined) return false;
  const cached = cache.get(sym);
  if (cached !== undefined) return cached;
  let shadowed = false;
  for (const decl of sym.declarations ?? []) {
    let sf: ts.SourceFile | undefined;
    try {
      sf = decl.getSourceFile();
    } catch {
      continue;
    }
    if (sf === undefined || sf.isDeclarationFile) continue;
    if (
      ts.isClassDeclaration(decl) ||
      ts.isClassExpression(decl) ||
      ts.isFunctionDeclaration(decl) ||
      ts.isFunctionExpression(decl) ||
      ts.isVariableDeclaration(decl) ||
      ts.isParameter(decl) ||
      ts.isBindingElement(decl) ||
      ts.isImportClause(decl) ||
      ts.isImportSpecifier(decl) ||
      ts.isNamespaceImport(decl) ||
      ts.isImportEqualsDeclaration(decl)
    ) {
      shadowed = true;
      break;
    }
  }
  cache.set(sym, shadowed);
  return shadowed;
}
