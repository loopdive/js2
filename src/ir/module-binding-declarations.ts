// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import { TsCheckerOracle, type TypeOracle } from "../checker/oracle.js";
type BindingQuerySource = ts.TypeChecker | Pick<TypeOracle, "valueDeclarationOf" | "declarationsOf">;

const checkerBindingOracles = new WeakMap<ts.TypeChecker, TsCheckerOracle>();

function bindingOracle(source: BindingQuerySource): Pick<TypeOracle, "valueDeclarationOf" | "declarationsOf"> {
  if ("valueDeclarationOf" in source && "declarationsOf" in source) return source;
  let oracle = checkerBindingOracles.get(source);
  if (!oracle) {
    oracle = new TsCheckerOracle(source);
    checkerBindingOracles.set(source, oracle);
  }
  return oracle;
}

/** Ordered declaration candidates: value declaration first, then the full
 * merged list — the exact priority the raw
 * `[symbol.valueDeclaration, ...symbol.declarations]` idiom encoded. */
export function bindingDeclarationCandidates(
  node: ts.Identifier,
  source: BindingQuerySource,
): readonly (ts.Declaration | undefined)[] {
  const oracle = bindingOracle(source);
  return [oracle.valueDeclarationOf(node), ...oracle.declarationsOf(node)];
}

export function uniqueTopLevelVariableDeclaration(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): ts.VariableDeclaration | undefined {
  const sourceFile = node.getSourceFile();
  const candidates = bindingDeclarationCandidates(node, checker);
  if (candidates.length === 0) return undefined;
  const directDeclarations = new Set<ts.VariableDeclaration>();
  for (const candidate of candidates) {
    if (!candidate || !ts.isVariableDeclaration(candidate)) continue;
    if (candidate.getSourceFile() !== sourceFile) continue;
    if (!ts.isIdentifier(candidate.name)) continue;
    const list = candidate.parent;
    if (!ts.isVariableDeclarationList(list)) continue;
    const statement = list.parent;
    if (!ts.isVariableStatement(statement) || statement.parent !== sourceFile) continue;
    directDeclarations.add(candidate);
  }
  if (directDeclarations.size !== 1) return undefined;
  return [...directDeclarations][0]!;
}
