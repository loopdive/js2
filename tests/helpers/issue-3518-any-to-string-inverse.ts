// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import ts from "typescript";
import { createHash } from "node:crypto";

const generatorNames = new Set([
  "numberArm",
  "objectTag",
  "objectOrErrorTagInner",
  "objectOrErrorTagBase",
  "objectOrErrorTag",
  "stringifyBoxedExtern",
  "recoverNonStringExtern",
]);
const blockArrows = new Set(["objectTag", "objectOrErrorTag"]);
function parsed(text: string) {
  return ts.createSourceFile("inverse.ts", text, ts.ScriptTarget.Latest, true);
}
function reverseSyntax(text: string): string {
  // Parse moved statements in their real generator context so yield* is syntax,
  // including the top-level body group (not an identifier/product expression).
  const prefix = "function* inverseTransport() {\n";
  text = prefix + text + "\n}";
  const source = parsed(text);
  const container = source.statements[0];
  if (!container || !ts.isFunctionDeclaration(container) || !container.body) throw Error("missing inverse context");
  function render(node: ts.Node): string {
    if (ts.isParenthesizedExpression(node) && ts.isYieldExpression(node.expression)) return render(node.expression);
    if (ts.isYieldExpression(node) && node.asteriskToken && node.expression) return render(node.expression);
    if (ts.isFunctionDeclaration(node) && node.name && generatorNames.has(node.name.text)) {
      if (!node.asteriskToken || !node.body) throw Error("missing exact generator form");
      const name = node.name.text;
      const params = node.parameters.map(render).join(", ");
      let body: string;
      if (blockArrows.has(name)) body = render(node.body);
      else {
        const only = node.body.statements[0];
        if (node.body.statements.length !== 1 || !only || !ts.isReturnStatement(only) || !only.expression)
          throw Error("unexpected expression generator statements");
        body = render(only.expression);
      }
      return `const ${name} = (${params}): Instr[] => ${body};`;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "objectOrErrorTag" &&
      node.arguments.length === 1 &&
      ts.isArrayLiteralExpression(node.arguments[0]!)
    )
      return `objectOrErrorTag(() => ${render(node.arguments[0]!)})`;
    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    let result = "",
      position = node.getStart(source);
    for (const child of children) {
      const start = child.getStart(source);
      if (start < position) continue;
      result += text.slice(position, start) + render(child);
      position = child.end;
    }
    return result + text.slice(position, node.end);
  }
  let result = "",
    position = prefix.length;
  for (const statement of container.body.statements) {
    result += text.slice(position, statement.getStart(source)) + render(statement);
    position = statement.end;
  }
  return result + text.slice(position, -2);
}
function tokens(text: string): { kind: ts.SyntaxKind; text: string; start: number; end: number }[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text),
    result = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan())
    if (kind !== ts.SyntaxKind.WhitespaceTrivia && kind !== ts.SyntaxKind.NewLineTrivia)
      result.push({ kind, text: scanner.getTokenText(), start: scanner.getTokenPos(), end: scanner.getTextPos() });
  return result;
}
/** Original whitespace is a transport envelope; every code AND comment token comes from the inverse. */
function restoreWhitespace(original: string, inverse: string): string {
  const expected = tokens(original),
    actual = tokens(inverse);
  if (expected.length !== actual.length) throw Error(`inverse token count ${actual.length} != ${expected.length}`);
  let result = "",
    position = 0;
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i]!,
      e = expected[i]!;
    if (a.kind !== e.kind || a.text !== e.text)
      throw Error(`inverse token ${i}: ${JSON.stringify(a.text)} != ${JSON.stringify(e.text)}`);
    result += original.slice(position, e.start) + a.text;
    position = e.end;
  }
  return result + original.slice(position);
}
function group(source: string, name: string, firstName: string, lastName: string, leading: boolean) {
  const file = parsed(source);
  const fn = file.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!fn?.body) throw Error("missing runtime body factory");
  function statementName(node: ts.Statement) {
    if (ts.isFunctionDeclaration(node)) return node.name?.text;
    if (ts.isVariableStatement(node)) return node.declarationList.declarations[0]?.name.getText(file);
    return undefined;
  }
  const first = fn.body.statements.find((node) => statementName(node) === firstName),
    last = fn.body.statements.find((node) => statementName(node) === lastName);
  if (!first || !last) throw Error("missing exact moved statement range");
  const start = leading ? first.getFullStart() : first.getStart(file),
    end = last.end;
  return {
    text: source.slice(start, end),
    scaffold: source.slice(0, start) + "\n/* MOVED DONOR RANGE */\n" + source.slice(end),
  };
}
export interface AnyToStringInverseInputs {
  object: string;
  recovery: string;
  body: string;
  types: string;
}
export function anyToStringScaffoldHashes(inputs: AnyToStringInverseInputs): Record<string, string> {
  const groups = {
    object: group(inputs.object, "createAnyToStringObjectArms", "numberArm", "objectOrErrorTag", false),
    recovery: group(inputs.recovery, "createAnyToStringRecoveryArms", "toPrimitiveIdx", "recoverNonStringExtern", true),
    body: group(inputs.body, "buildAnyToStringBody", "tagEq", "body", false),
  };
  return Object.fromEntries([
    ...Object.entries(groups).map(([key, value]) => [key, createHash("sha256").update(value.scaffold).digest("hex")]),
    ["types", createHash("sha256").update(inputs.types).digest("hex")],
  ]);
}
export function inverseAnyToStringGroups(original: string, inputs: AnyToStringInverseInputs): string {
  const start = original.indexOf("  const litStr =", original.indexOf("export function ensureAnyToStringHelper"));
  const number = original.indexOf("  const numberArm =", start),
    recovery = original.indexOf("  // #1910/#1472 S2 — recover the string", number),
    tag = original.indexOf("  const tagEq =", recovery),
    end = original.indexOf("  const typeIdx = addFuncType(ctx, [anyref]", tag);
  if ([start, number, recovery, tag, end].some((value) => value < 0)) throw Error("missing exact donor ranges");
  let object = reverseSyntax(
    group(inputs.object, "createAnyToStringObjectArms", "numberArm", "objectOrErrorTag", false).text,
  );
  object = object
    .replaceAll("bindings.classToPrimIdx", 'ctx.funcMap.get("__class_to_primitive")')
    .replaceAll("bindings.boxNumTerminalIdx", "ctx.nativeBoxNumberTypeIdx")
    .replaceAll("bindings.boxBoolTerminalIdx", "ctx.nativeBoxBooleanTypeIdx")
    .replaceAll("bindings.argumentsVecTypeIdx", "getArgumentsVecTypeIdx(ctx)")
    .replaceAll("readArgumentsBrand()", 'ctx.funcMap.get("__args_is_branded")')
    .replaceAll("loadRef: readonly Instr[]", "loadRef: () => Instr[]")
    .replaceAll("loadRef.map((instruction) => ({ ...instruction }))", "loadRef()");
  let recovered = reverseSyntax(
    group(inputs.recovery, "createAnyToStringRecoveryArms", "toPrimitiveIdx", "recoverNonStringExtern", true).text,
  );
  recovered = recovered
    .replaceAll("bindings.toPrimitiveIdx", 'ctx.funcMap.get("__to_primitive")')
    .replaceAll("bindings.objectRuntimePresent", "ctx.objectRuntimeTypes")
    .replaceAll("bindings.boxNumIdxEarly", "ctx.nativeBoxNumberTypeIdx")
    .replaceAll("bindings.boxBoolIdxEarly", "ctx.nativeBoxBooleanTypeIdx")
    .replaceAll("readObjectType()", "objectRtTypes.objectTypeIdx")
    .replace(/&& objectRtTypes\s*\?/g, "&& objectRtTypes !== undefined ?");
  let body = reverseSyntax(group(inputs.body, "buildAnyToStringBody", "tagEq", "body", false).text);
  body = body.replace(
    "const { boxNumIdx, boxBoolIdx } = readResidualBoxTypes();",
    "const boxNumIdx = ctx.nativeBoxNumberTypeIdx;\nconst boxBoolIdx = ctx.nativeBoxBooleanTypeIdx;",
  );
  return (
    original.slice(start, number) +
    restoreWhitespace(original.slice(number, recovery), object) +
    restoreWhitespace(original.slice(recovery, tag), recovered) +
    restoreWhitespace(original.slice(tag, end), body)
  );
}
