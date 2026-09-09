// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const concatPath = "src/runtime/wasmgc/values/string-concat-bodies.ts";
const stdoutPath = "src/runtime/wasmgc/values/stdout-bodies.ts";
const batchPath = "src/codegen/native-batched-concat.ts";
const basicsPath = "src/codegen/native-strings-basics.ts";
const legacyStdoutPath = "src/codegen/native-strings.ts";
const paths = [concatPath, stdoutPath, batchPath, basicsPath, legacyStdoutPath];
const read = () => Object.fromEntries(paths.map((p) => [p, readFileSync(new URL("../" + p, import.meta.url), "utf8")]));
const parse = (s: string) => ts.createSourceFile("receipt.ts", s, ts.ScriptTarget.Latest, true);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
// Pinned from the complete files at 721cd33a828c89cfc04c851b011f910b76a4d2c5.
// No git executable or historical object availability is needed in CI.
const originals = {
  [batchPath]: {
    raw: "52a1aaace8b89e85cb5862ad0ee7df86a2ccccd9e9664516bf747a4600bf7bb1",
    receipt: "2a6f1a7dfff5a3d5a0da680469c540752094e821f46fa55e15d48f6917e8d3d0",
  },
  [basicsPath]: {
    raw: "d35ac41d78a1e12d3109d3001112fa6ef97e9548d1006e73241531f40c84865d",
    receipt: "46d125901e67458657d6510eff8b3da75a309372a458cefdc96b63a078bff5bb",
  },
  [legacyStdoutPath]: {
    raw: "b29419deb584cc1e285a19f89a4ab7f3394215fb3d5fa7fe5c037b5be0c44173",
    receipt: "e1f7d82020519c76ec2542dac9c6c0e387fb3be4f4ff4885d1f08d2b89ddca20",
  },
};
// Preserve every parser-owned token and every comment. Only formatting,
// optional commas and statement semicolons are ignored.
function receipt(text: string): string {
  const sf = parse(text),
    tokens: string[] = [],
    comments = new Map<number, string>();
  const visit = (node: ts.Node) => {
    for (const pos of [node.pos, node.end, node.getFullStart()])
      for (const range of [
        ...(ts.getLeadingCommentRanges(text, pos) ?? []),
        ...(ts.getTrailingCommentRanges(text, pos) ?? []),
      ])
        comments.set(range.pos, text.slice(range.pos, range.end));
    const children = node.getChildren(sf);
    if (
      !children.length &&
      node.kind !== ts.SyntaxKind.EndOfFileToken &&
      ![ts.SyntaxKind.CommaToken, ts.SyntaxKind.SemicolonToken].includes(node.kind)
    )
      tokens.push(node.getText(sf));
    else children.forEach(visit);
  };
  visit(sf);
  return JSON.stringify({ tokens, comments: [...comments.values()].sort() });
}
function exact(actual: string, expected: string): void {
  if (receipt(actual) !== receipt(expected)) throw Error("changed canonical header, dependency or forwarding contract");
}
function fn(sf: ts.SourceFile, name: string): ts.FunctionDeclaration & { body: ts.Block } {
  const found = sf.statements.filter(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name,
  );
  if (found.length !== 1 || !found[0]!.body) throw Error("missing/duplicate function " + name);
  return found[0] as ts.FunctionDeclaration & { body: ts.Block };
}
function prop(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment {
  const found = object.properties.filter((p) => p.name?.getText() === name);
  const selected = found[0];
  if (found.length !== 1 || !selected || !ts.isPropertyAssignment(selected))
    throw Error("missing/duplicate property " + name);
  return selected;
}
function parts(sf: ts.SourceFile, name: string, header: string, prefix: string, prefixCount: number) {
  const f = fn(sf, name),
    statements = f.body.statements;
  exact(sf.text.slice(f.getStart(sf), f.body.getStart(sf)), header);
  exact(
    statements
      .slice(0, prefixCount)
      .map((s) => s.getText(sf))
      .join("\n"),
    prefix,
  );
  const ret = statements.at(-1);
  if (!ret || !ts.isReturnStatement(ret) || !ret.expression || !ts.isObjectLiteralExpression(ret.expression))
    throw Error("missing canonical definition return");
  exact(ret.expression.properties.map((p) => p.name?.getText(sf)).join(","), "locals,body");
  const body = ret.expression.properties[1];
  if (!body || !ts.isShorthandPropertyAssignment(body) || body.name.text !== "body")
    throw Error("changed returned body");
  const locals = prop(ret.expression, "locals").initializer;
  if (!ts.isArrayLiteralExpression(locals)) throw Error("locals not explicit");
  if (statements.length <= prefixCount + 1) throw Error("empty canonical construction");
  return {
    construction: sf.text.slice(statements[prefixCount]!.getFullStart(), statements.at(-2)!.end),
    locals: locals.getText(sf),
  };
}
function canonical(files: Record<string, string>) {
  const c = parse(files[concatPath]!),
    s = parse(files[stdoutPath]!);
  const allowed = ["../../../wasm/model/instructions.js"];
  for (const [sf, count] of [
    [c, 2],
    [s, 3],
  ] as const) {
    if (sf.statements.filter(ts.isFunctionDeclaration).length !== count) throw Error("changed executable population");
    if (
      sf.statements.filter(ts.isImportDeclaration).length !== 1 ||
      sf.statements.filter(ts.isVariableStatement).length !== (sf === c ? 1 : 0)
    )
      throw Error("changed import/initializer population");
    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement)) {
        if (
          !statement.importClause?.isTypeOnly ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          !allowed.includes(statement.moduleSpecifier.text)
        )
          throw Error("forbidden executable dependency");
        exact(
          statement.getText(sf),
          sf === c
            ? 'import type { FuncHandle, Instr, LocalDef, TypeHandle, ValType } from "../../../wasm/model/instructions.js";'
            : 'import type { FuncHandle, GlobalHandle, Instr, LocalDef, TypeHandle } from "../../../wasm/model/instructions.js";',
        );
      } else if (ts.isVariableStatement(statement)) {
        if (sf !== c) throw Error("unexpected initializer");
        exact(statement.getText(sf), "const FLAT_CONCAT_LIMIT = 64;");
      } else if (!ts.isInterfaceDeclaration(statement) && !ts.isFunctionDeclaration(statement))
        throw Error("unexpected top-level execution");
    }
  }
  return [
    parts(
      c,
      "buildStringConcatDefinition",
      "export function buildStringConcatDefinition(layout: StringConcatLayout, resources: StringConcatResources): { locals: LocalDef[]; body: Instr[] }",
      'const { strTypeIdx, strDataTypeIdx, anyStrTypeIdx, consStrTypeIdx } = layout; const { flattenIdx, emptyIdentity } = resources; const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };',
      3,
    ),
    parts(
      c,
      "buildStringBatchedConcatDefinition",
      'export function buildStringBatchedConcatDefinition(layout: Pick<StringConcatLayout, "strTypeIdx" | "strDataTypeIdx" | "anyStrTypeIdx">, arity: number, resources: StringBatchedConcatResources): { locals: LocalDef[]; body: Instr[] }',
      'if (!Number.isInteger(arity) || arity < 2 || resources.undefinedLiterals.length !== arity) throw new Error("native batched concat: literal population must match arity"); for (let index = 0; index < arity; index++) if (!Array.isArray(resources.undefinedLiterals[index])) throw new Error("native batched concat: missing literal sequence"); const { strTypeIdx, strDataTypeIdx, anyStrTypeIdx } = layout; const { flattenIdx, concatIdx } = resources; const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };',
      5,
    ),
    parts(
      s,
      "buildStdoutAppendDefinition",
      "export function buildStdoutAppendDefinition(resources: StdoutAppendResources): { locals: LocalDef[]; body: Instr[] }",
      "const { accGlobalIdx, concatIdx } = resources;",
      1,
    ),
    parts(
      s,
      "buildStdoutPrepareDefinition",
      "export function buildStdoutPrepareDefinition(resources: StdoutPrepareResources): { locals: LocalDef[]; body: Instr[] }",
      "const { accGlobalIdx, flatGlobalIdx, flatTypeIdx, flattenIdx } = resources;",
      1,
    ),
    parts(
      s,
      "buildStdoutCharDefinition",
      "export function buildStdoutCharDefinition(resources: StdoutCharResources): { locals: LocalDef[]; body: Instr[] }",
      "const { flatGlobalIdx, flatTypeIdx, dataTypeIdx } = resources;",
      1,
    ),
  ];
}
type Edit = { start: number; end: number; text: string };
function restoreAdapter(text: string, names: readonly string[], definitions: ReturnType<typeof canonical>) {
  const sf = parse(text),
    edits: Edit[] = [];
  const imports = sf.statements
    .filter(ts.isImportDeclaration)
    .filter(
      (s) =>
        ts.isStringLiteral(s.moduleSpecifier) &&
        /\/(string-concat-bodies|stdout-bodies)\.js$/.test(s.moduleSpecifier.text),
    );
  if (imports.length !== 1) throw Error("missing/duplicate forwarding import");
  const imp = imports[0]!;
  if (
    imp.importClause?.isTypeOnly ||
    !imp.importClause?.namedBindings ||
    !ts.isNamedImports(imp.importClause.namedBindings)
  )
    throw Error("non-value import");
  const imported = imp.importClause.namedBindings.elements;
  if (
    imported.some((s) => s.isTypeOnly || s.propertyName) ||
    imported.map((s) => s.name.text).join(",") !== names.join(",")
  )
    throw Error("changed imported binding");
  edits.push({ start: imp.getFullStart(), end: imp.end, text: "" });
  let used = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && names.includes(node.expression.getText(sf))) {
      const name = node.expression.getText(sf),
        position = names.indexOf(name);
      const d = definitions[position]!;
      const declaration = node.parent;
      if (
        !ts.isVariableDeclaration(declaration) ||
        declaration.name.getText(sf) !== "definition" ||
        !ts.isVariableDeclarationList(declaration.parent) ||
        !ts.isVariableStatement(declaration.parent.parent)
      )
        throw Error("changed adapter definition");
      const statement = declaration.parent.parent;
      const container = statement.parent;
      if (!ts.isBlock(container)) throw Error("unexpected registration container");
      let start = statement.getFullStart(),
        restored = d.construction;
      const argumentsByName: Record<string, string> = {
        buildStringConcatDefinition:
          '{ strTypeIdx, strDataTypeIdx, anyStrTypeIdx, consStrTypeIdx }, { flattenIdx, emptyIdentity: process.env.JS2WASM_STR_CONCAT_EMPTY_IDENTITY !== "0" }',
        buildStringBatchedConcatDefinition:
          "{ strTypeIdx, strDataTypeIdx, anyStrTypeIdx }, arity, { flattenIdx, concatIdx, undefinedLiterals }",
        buildStdoutAppendDefinition: "{ accGlobalIdx, concatIdx }",
        buildStdoutPrepareDefinition: "{ accGlobalIdx, flatGlobalIdx, flatTypeIdx, flattenIdx }",
        buildStdoutCharDefinition: "{ flatGlobalIdx, flatTypeIdx, dataTypeIdx }",
      };
      exact(node.arguments.map((a) => a.getText(sf)).join(","), argumentsByName[name]!);
      if (name === "buildStringConcatDefinition") {
        if (restored.split("!emptyIdentity").length !== 2) throw Error("changed empty switch");
        restored = restored.replace("!emptyIdentity", 'process.env.JS2WASM_STR_CONCAT_EMPTY_IDENTITY === "0"');
      }
      if (name === "buildStringBatchedConcatDefinition") {
        const index = container.statements.indexOf(statement),
          first = container.statements[index - 2]!,
          second = container.statements[index - 1]!;
        exact(first.getText(sf), "const undefinedLiterals: Instr[][] = [];");
        exact(
          second.getText(sf),
          'for (let index = 0; index < arity; index++) undefinedLiterals.push(nativeStringLiteralInstrs(ctx, "undefined"));',
        );
        start = first.getFullStart();
        if (restored.split("structuredClone(resources.undefinedLiterals[index]!)").length !== 2)
          throw Error("changed detached literal read");
        restored = restored.replace(
          "structuredClone(resources.undefinedLiterals[index]!)",
          'nativeStringLiteralInstrs(ctx, "undefined")',
        );
      }
      edits.push({ start, end: statement.end, text: restored });
      const pushes = container.statements
        .filter(ts.isExpressionStatement)
        .map((s) => s.expression)
        .filter(
          (e): e is ts.CallExpression => ts.isCallExpression(e) && e.expression.getText(sf) === "pushDefinedFunc",
        );
      if (pushes.length !== 1) throw Error("changed registration population");
      let record = pushes[0]!.arguments[2]!;
      if (ts.isAsExpression(record)) record = record.expression;
      if (!ts.isObjectLiteralExpression(record)) throw Error("missing registration record");
      for (const key of ["locals", "body"]) {
        const p = prop(record, key);
        exact(p.initializer.getText(sf), "definition." + key);
        edits.push({ start: p.getStart(sf), end: p.end, text: key === "body" ? "body" : "locals: " + d.locals });
      }
      used++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (used !== names.length) throw Error("changed forwarding call population");
  for (const e of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  if (names.includes("buildStringBatchedConcatDefinition")) {
    const marker = "const MAX_BATCHED_CONCAT_ARITY = STRING_CONCAT_MANY_NATIVE_ARITY.max;";
    if (text.split(marker).length !== 2) throw Error("changed original arity authority");
    text = text.replace(marker, marker + "\nconst FLAT_CONCAT_LIMIT = 64;");
  }
  return text;
}
function verify(files: Record<string, string>) {
  const d = canonical(files);
  const reconstructed = {
    [basicsPath]: restoreAdapter(files[basicsPath]!, ["buildStringConcatDefinition"], [d[0]!]),
    [batchPath]: restoreAdapter(files[batchPath]!, ["buildStringBatchedConcatDefinition"], [d[1]!]),
    [legacyStdoutPath]: restoreAdapter(
      files[legacyStdoutPath]!,
      ["buildStdoutAppendDefinition", "buildStdoutPrepareDefinition", "buildStdoutCharDefinition"],
      d.slice(2),
    ),
  };
  for (const [p, text] of Object.entries(reconstructed))
    if (sha(receipt(text)) !== originals[p]!.receipt) throw Error("donor preservation mismatch: " + p);
  return reconstructed;
}

describe("native string output complete donor reconstruction", () => {
  it("reconstructs all three entire legacy files, including untouched helpers and registration order", () => {
    const result = verify(read());
    expect(Object.keys(result)).toHaveLength(3);
    expect(Object.values(originals).every((r) => r.raw.length === 64 && r.receipt.length === 64)).toBe(true);
  });
  const mutations: [string, string, string, string][] = [
    ["unsigned concat threshold", concatPath, '{ op: "i32.const", value: 64 }', '{ op: "i32.const", value: 65 }'],
    [
      "rope operand order",
      concatPath,
      '{ op: "local.get", index: 0 }, // left = a',
      '{ op: "local.get", index: 1 }, // left = a',
    ],
    [
      "flat copy offset",
      concatPath,
      '{ op: "local.get", index: 2 }, // dstOffset = lenA',
      '{ op: "i32.const", value: 0 }, // dstOffset = lenA',
    ],
    [
      "scratch nullability",
      concatPath,
      'name: "newArr", type: { kind: "ref_null"',
      'name: "newArr", type: { kind: "ref"',
    ],
    ["construction refinement", concatPath, '{ op: "ref.as_non_null" },', '{ op: "nop" },'],
    ["empty-identity switch", basicsPath, 'EMPTY_IDENTITY !== "0"', 'EMPTY_IDENTITY === "0"'],
    ["undefined guard", concatPath, "then: [...structuredClone(resources.undefinedLiterals[index]!),", "then: ["],
    [
      "literal creation ordering",
      batchPath,
      'undefinedLiterals.push(nativeStringLiteralInstrs(ctx, "undefined"))',
      'undefinedLiterals.unshift(nativeStringLiteralInstrs(ctx, "undefined"))',
    ],
    ["null append branch", stdoutPath, 'then: [{ op: "return" }]', 'then: [{ op: "nop" }]'],
    [
      "accumulator target",
      stdoutPath,
      '{ op: "global.set", index: accGlobalIdx }',
      '{ op: "global.set", index: accGlobalIdx + 1 }',
    ],
    ["signed lower bound", stdoutPath, '{ op: "i32.lt_s" }', '{ op: "i32.lt_u" }'],
    ["upper bound", stdoutPath, '{ op: "i32.ge_s" }', '{ op: "i32.gt_s" }'],
    ["read offset", stdoutPath, "fieldIdx: 1 }, // off", "fieldIdx: 0 }, // off"],
    [
      "unsigned code unit",
      stdoutPath,
      '{ op: "array.get_u", typeIdx: dataTypeIdx }',
      '{ op: "array.get_s", typeIdx: dataTypeIdx }',
    ],
    [
      "async builder header",
      concatPath,
      "export function buildStringConcatDefinition(",
      "export async function buildStringConcatDefinition(",
    ],
    [
      "generator builder header",
      concatPath,
      "export function buildStringConcatDefinition(",
      "export function* buildStringConcatDefinition(",
    ],
    [
      "extra execution",
      stdoutPath,
      "const { accGlobalIdx, concatIdx } = resources;",
      'const { accGlobalIdx, concatIdx } = resources; throw Error("extra");',
    ],
    [
      "type-only adapter",
      basicsPath,
      "import { buildStringConcatDefinition }",
      "import type { buildStringConcatDefinition }",
    ],
    [
      "aliased adapter",
      basicsPath,
      "import { buildStringConcatDefinition }",
      "import { foreign as buildStringConcatDefinition }",
    ],
    ["untouched growth donor", basicsPath, "value: 16", "value: 17"],
    ["stdout publication name", legacyStdoutPath, 'name: "__stdout_prepare", desc:', 'name: "foreign", desc:'],
    ["missing batch constant", concatPath, "const FLAT_CONCAT_LIMIT = 64;", ""],
    [
      "rebound global index type",
      stdoutPath,
      "FuncHandle, GlobalHandle, Instr",
      "FuncHandle, TypeHandle as GlobalHandle, Instr",
    ],
  ];
  it.each(mutations)("rejects positive-first %s mutation", (_name, path, before, after) => {
    const files = read();
    verify(files);
    expect(files[path]).toContain(before);
    files[path] = files[path]!.replace(before, after);
    expect(() => verify(files)).toThrow();
  });
});
