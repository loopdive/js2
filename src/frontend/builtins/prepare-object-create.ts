// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../typescript.js";
import { isCurrentCompilerLibrarySourceFile } from "../../checker/index.js";

/** The bounded source form whose argument has no evaluation effects. */
export function isDirectObjectCreateNullCall(call: ts.CallExpression): boolean {
  const access = call.expression;
  return (
    ts.isPropertyAccessExpression(access) &&
    ts.isIdentifier(access.expression) &&
    access.expression.text === "Object" &&
    access.name.text === "create" &&
    !access.questionDotToken &&
    !call.questionDotToken &&
    !call.typeArguments?.length &&
    call.arguments.length === 1 &&
    call.arguments[0]!.kind === ts.SyntaxKind.NullKeyword
  );
}

/**
 * Admit only original, current source calls to the compiler library's Object.create.
 * Every other use of the ambient constructor revokes the whole-source proof.
 */
export function prepareObjectCreateResolver(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  declaration: ts.FunctionDeclaration | readonly ts.Statement[],
): { readonly preparedObjectCreateCall: (call: ts.CallExpression) => "null" | undefined } {
  const files = [...sourceFiles];
  const roots = "kind" in declaration ? [declaration] : [...declaration];
  const calls = new WeakSet<ts.CallExpression>();
  const sourceNodes = new WeakSet<ts.Node>();
  const ambient = checker.resolveName("Object", undefined, ts.SymbolFlags.Value, false);
  const ambientDeclarations = [...(ambient?.declarations ?? [])];
  const ambientLocation = ambient?.valueDeclaration ?? ambientDeclarations[0];
  const member =
    ambient && ambientLocation
      ? checker.getTypeOfSymbolAtLocation(ambient, ambientLocation).getProperty("create")
      : undefined;
  const memberDeclarations = [...(member?.declarations ?? [])];

  // Scalar grammar fields and child identity catch AST edits even when SourceFile.text
  // is unchanged. Checker caches are deliberately not part of the source proof.
  const facts = (node: ts.Node) => {
    const lexical = node as ts.Node & { text?: string; escapedText?: string; isTypeOnly?: boolean };
    const source = ts.isSourceFile(node) ? node : undefined;
    return [
      node.kind,
      node.pos,
      node.end,
      node.flags,
      node.parent,
      lexical.text,
      lexical.escapedText,
      lexical.isTypeOnly,
      source?.fileName,
      source?.isDeclarationFile,
      source?.languageVersion,
      source?.languageVariant,
    ];
  };
  const snapshots: { node: ts.Node; facts: ReturnType<typeof facts> }[] = [];
  const capture = (node: ts.Node) => {
    sourceNodes.add(node);
    snapshots.push({ node, facts: facts(node) });
    ts.forEachChild(node, capture);
  };
  files.forEach(capture);
  const currentSource = () => {
    if (sourceFiles.length !== files.length || sourceFiles.some((file, i) => file !== files[i])) return false;
    let index = 0;
    let valid = true;
    const compare = (node: ts.Node) => {
      const snapshot = snapshots[index++];
      const current = facts(node);
      if (!snapshot || snapshot.node !== node || current.some((value, i) => value !== snapshot.facts[i])) valid = false;
      ts.forEachChild(node, compare);
    };
    files.forEach(compare);
    return valid && index === snapshots.length;
  };
  const currentDeclarations = (symbol: ts.Symbol | undefined, declarations: readonly ts.Declaration[]) =>
    !!symbol &&
    declarations.length > 0 &&
    symbol.declarations?.length === declarations.length &&
    declarations.every(
      (node, i) => symbol.declarations![i] === node && isCurrentCompilerLibrarySourceFile(node.getSourceFile()),
    );
  const canonical = () =>
    checker.resolveName("Object", undefined, ts.SymbolFlags.Value, false) === ambient &&
    currentDeclarations(ambient, ambientDeclarations) &&
    currentDeclarations(member, memberDeclarations) &&
    !!ambientLocation &&
    checker.getTypeOfSymbolAtLocation(ambient!, ambientLocation).getProperty("create") === member;
  const exactCall = (call: ts.CallExpression) => {
    if (!isDirectObjectCreateNullCall(call)) return false;
    const access = call.expression as ts.PropertyAccessExpression;
    if (
      checker.getSymbolAtLocation(access.expression) !== ambient ||
      checker.getSymbolAtLocation(access.name) !== member ||
      checker.getTypeAtLocation(access.expression).getProperty("create") !== member
    )
      return false;
    const signature = checker.getResolvedSignature(call);
    return (
      !!signature?.declaration &&
      memberDeclarations.includes(signature.declaration) &&
      isCurrentCompilerLibrarySourceFile(signature.declaration.getSourceFile())
    );
  };
  const ownedRoots = () => roots.every((root) => files.includes(root.getSourceFile()) && sourceNodes.has(root));
  const noEscapes = () => {
    let valid = true;
    const inspect = (node: ts.Node) => {
      // Dynamic constructors can also be obtained without naming Function.
      // This bounded proof excludes constructor extraction and computed keys
      // whose value is not an immediate non-constructor String/Number literal.
      if (ts.isPropertyAccessExpression(node) && node.name.text === "constructor") valid = false;
      if (ts.isElementAccessExpression(node)) {
        const key = node.argumentExpression;
        if ((!ts.isStringLiteral(key) && !ts.isNumericLiteral(key)) || key.text === "constructor") valid = false;
      }
      if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node) || ts.isComputedPropertyName(node))
        valid = false;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isObjectLiteralExpression(node.left) || ts.isArrayLiteralExpression(node.left))
      )
        valid = false;
      if (
        (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
        (ts.isObjectLiteralExpression(node.initializer) || ts.isArrayLiteralExpression(node.initializer))
      )
        valid = false;
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const memberName = ts.isPropertyAccessExpression(parent) && parent.name === node;
        // Shorthand/export names can resolve to a property/export symbol rather
        // than the escaping value. Spelling may revoke authority, never grant it.
        if (checker.getSymbolAtLocation(node) === ambient || (node.text === "Object" && !memberName)) {
          if (
            !ts.isPropertyAccessExpression(parent) ||
            parent.expression !== node ||
            !ts.isCallExpression(parent.parent) ||
            parent.parent.expression !== parent ||
            !exactCall(parent.parent)
          )
            valid = false;
        }
        // A global-object alias or dynamic source execution can replace Object
        // without referring directly to the constructor symbol in this source.
        if (
          !memberName &&
          ["globalThis", "global", "window", "self", "eval", "Function", "Reflect"].includes(node.text)
        )
          valid = false;
      }
      ts.forEachChild(node, inspect);
    };
    files.forEach(inspect);
    return valid;
  };
  const collect = (node: ts.Node) => {
    if (ts.isCallExpression(node) && exactCall(node)) calls.add(node);
    ts.forEachChild(node, collect);
  };
  if (ownedRoots() && canonical() && noEscapes()) roots.forEach(collect);
  // Record the settled parser facts after the initial checker queries.
  for (const snapshot of snapshots) snapshot.facts = facts(snapshot.node);
  return Object.freeze({
    preparedObjectCreateCall(call: ts.CallExpression): "null" | undefined {
      if (!calls.has(call)) return undefined;
      return currentSource() && ownedRoots() && canonical() && exactCall(call) && noEscapes() ? "null" : undefined;
    },
  });
}
