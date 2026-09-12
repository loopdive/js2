// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3518: the canonical assembly edge and the exact legacy type forwarder.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export const DIALECT_NAMES = Object.freeze(
  [
    "IrInstrAsyncReturn",
    "IrInstrAsyncThrow",
    "IrInstrAwait",
    "IrInstrDynEq",
    "IrInstrDynMemberGet",
    "IrInstrDynMemberSet",
    "IrInstrDynToNumber",
    "IrInstrDynTruthy",
    "IrInstrExternCall",
    "IrInstrExternNew",
    "IrInstrExternProp",
    "IrInstrExternPropSet",
    "IrInstrForOfIter",
    "IrInstrForOfString",
    "IrInstrGenEpilogue",
    "IrInstrGenPush",
    "IrInstrGenSetReturn",
    "IrInstrGenYieldStar",
    "IrInstrIterDone",
    "IrInstrIterNew",
    "IrInstrIterNext",
    "IrInstrIterReturn",
    "IrInstrIterValue",
    "IrInstrRegExpLiteral",
    "IrInstrStringCharAt",
    "IrInstrStringCharCodeAt",
    "IrInstrStringRepeat",
  ].sort(),
);

export function checkCanonicalIrDialect(sourceRoot) {
  const root = path.resolve(sourceRoot);
  const canonical = path.join(root, "ir/core/dialect/js.ts");
  const legacy = path.join(root, "ir/dialect/js.ts");
  const host = path.join(root, "ir/core/nodes.ts");
  const failures = [];
  const files = new Map();
  const display = (file) => path.join(sourceRoot, path.relative(root, file));
  const fail = (file, node, message) => {
    const line = node ? node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1 : 1;
    failures.push(`${display(file)}:${line}: ${message}`);
  };
  function walk(directory) {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (file.endsWith(".ts")) {
        const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
        files.set(file, sf);
        for (const diagnostic of sf.parseDiagnostics)
          fail(file, null, `unreadable source syntax: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
      }
    }
  }
  try {
    walk(root);
  } catch (error) {
    failures.push(`cannot inventory ${sourceRoot}: ${error.message}`);
  }
  for (const file of [canonical, legacy, host])
    if (!files.has(file)) fail(file, null, "required canonical dialect boundary source is missing");

  function target(specifier, from) {
    if (!specifier?.startsWith(".")) return null;
    return path.resolve(path.dirname(from), specifier).replace(/\.js$/, ".ts");
  }
  function typeExports(sf, destination) {
    const names = [];
    for (const statement of sf?.statements ?? []) {
      if (
        !ts.isExportDeclaration(statement) ||
        !statement.isTypeOnly ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        target(statement.moduleSpecifier.text, sf.fileName) !== destination ||
        !statement.exportClause ||
        !ts.isNamedExports(statement.exportClause)
      )
        continue;
      for (const element of statement.exportClause.elements) {
        if (element.propertyName && element.propertyName.text !== element.name.text) continue;
        names.push(element.name.text);
      }
    }
    return names.sort();
  }
  const sameNames = (names) => JSON.stringify(names) === JSON.stringify(DIALECT_NAMES);
  const declared = (files.get(canonical)?.statements ?? [])
    .filter(
      (statement) =>
        ts.isInterfaceDeclaration(statement) &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
    )
    .map((statement) => statement.name.text)
    .sort();
  if (!sameNames(declared)) fail(canonical, null, "requires exactly the 27 reviewed dialect interfaces");
  if (!sameNames(typeExports(files.get(host), canonical)))
    fail(host, null, "does not explicitly type-re-export every canonical dialect declaration exactly once");
  const legacySource = files.get(legacy);
  if (legacySource?.statements.length !== 1 || !sameNames(typeExports(legacySource, canonical)))
    fail(legacy, null, "must be the exact 27-name type-only compatibility forwarder, with no implementation");

  const dialectDirectories = [path.dirname(canonical), path.dirname(legacy)];
  for (const [file, sf] of files) {
    function visit(node) {
      let specifier;
      let typeOnly = false;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        specifier = node.moduleSpecifier;
        typeOnly = ts.isImportDeclaration(node) ? !!node.importClause?.isTypeOnly : node.isTypeOnly;
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
      else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      )
        specifier = node.arguments[0];
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
        specifier = node.moduleReference.expression;
      if (specifier && (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier))) {
        const destination = target(specifier.text, file);
        if (destination && dialectDirectories.some((directory) => destination.startsWith(`${directory}${path.sep}`))) {
          const allowed = destination === canonical && typeOnly && (file === host || file === legacy);
          if (!allowed)
            fail(
              file,
              node,
              "imports the JS dialect outside the sole canonical type-assembly edge or exact legacy forwarder",
            );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
  }
  return { failures, declarations: declared.length };
}
