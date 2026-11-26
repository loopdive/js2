// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7455/#7457) Which identifier writes reach a binding, answered from one index per source file. The file is
 * walked once, with the shared write-form enumerator `identifierWritesOf`, and each write is filed under the
 * de-aliased symbol its target resolves to. Route questions (the global object, dynamic code, `with`) are not
 * answered here; callers ask the predicates in `binding-writes.ts` and `intrinsic-prototype-writes.ts`.
 */
import { ts } from "../ts-api.js";
import { identifierWritesOf, type IdentifierWrite } from "./binding-writes.js";

/**
 * `symbol` with import aliases followed to the declaration they name, or `undefined` when the chain is cyclic,
 * deeper than 32, or unresolvable. A `var` or function declaration's symbol is not an alias and comes back as is.
 */
export function deAliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (!symbol) return undefined;
  let current = symbol;
  const seen = new Set<ts.Symbol>();
  for (let depth = 0; depth < 32 && current.flags & ts.SymbolFlags.Alias; depth++) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    try {
      const next = checker.getAliasedSymbol(current);
      if (!next || next === current) return undefined;
      current = next;
    } catch {
      return undefined;
    }
  }
  return current.flags & ts.SymbolFlags.Alias ? undefined : current;
}

type WriteIndex = ReadonlyMap<ts.Symbol, readonly IdentifierWrite[]>;

const indexes = new WeakMap<ts.TypeChecker, WeakMap<ts.SourceFile, WriteIndex>>();

/** Every identifier write in `files` whose target resolves to `symbol` (de-aliased), in file and source order. */
export function bindingWrites(
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  symbol: ts.Symbol,
): readonly IdentifierWrite[] {
  const binding = deAliasedSymbol(checker, symbol);
  if (!binding) return [];
  return files.flatMap((file) => writeIndex(checker, file).get(binding) ?? []);
}

function writeIndex(checker: ts.TypeChecker, file: ts.SourceFile): WriteIndex {
  let byFile = indexes.get(checker);
  if (!byFile) indexes.set(checker, (byFile = new WeakMap()));
  let index = byFile.get(file);
  if (!index) byFile.set(file, (index = buildWriteIndex(checker, file)));
  return index;
}

function buildWriteIndex(checker: ts.TypeChecker, file: ts.SourceFile): WriteIndex {
  const index = new Map<ts.Symbol, IdentifierWrite[]>();
  const visit = (node: ts.Node): void => {
    for (const write of identifierWritesOf(node)) {
      const symbol = deAliasedSymbol(checker, targetSymbol(checker, write.target));
      if (!symbol) continue;
      const writes = index.get(symbol);
      if (writes) writes.push(write);
      else index.set(symbol, [write]);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return index;
}

/**
 * The symbol a write target stores into. A shorthand target (`({ f } = o)`) names its property; the binding is
 * the shorthand's value symbol. A target the checker cannot resolve has no symbol and certifies nothing.
 */
function targetSymbol(checker: ts.TypeChecker, target: ts.Identifier): ts.Symbol | undefined {
  try {
    const { parent } = target;
    return ts.isShorthandPropertyAssignment(parent)
      ? checker.getShorthandAssignmentValueSymbol(parent)
      : checker.getSymbolAtLocation(target);
  } catch {
    return undefined;
  }
}
