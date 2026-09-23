// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  buildRyuPowerTables,
  buildRyuInverseSplit,
  buildRyuSplit,
} from "../src/runtime/wasmgc/values/number-ryu-tables.js";
import {
  ryuMulShiftSignature,
  ryuDigitsSignature,
  ryuToBufferSignature,
} from "../src/runtime/wasmgc/values/number-ryu-signatures.js";
import { createEmptyModule } from "../src/ir/types.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import * as registryTypes from "../src/codegen/registry/types.js";
import * as functionSpace from "../src/codegen/func-space.js";
import * as currentRyu from "../src/codegen/number-ryu.js";
import { sourceInput } from "./helpers/typed-program-fixtures.js";

const root = "../src/runtime/wasmgc/values/";
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const donor = JSON.parse(read("./fixtures/issue-3518-native-ryu-donor.json")) as { source: string; sha256: string };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function take(text: string, start: string, end: string): string {
  const a = text.indexOf(start),
    b = text.indexOf(end, a);
  if (a < 0 || b < 0) throw Error("missing exact donor boundary");
  return text.slice(a, b);
}
function replace(text: string, before: string, after: string): string {
  if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before))
    throw Error("missing/duplicate inverse span");
  return text.replace(before, after);
}
function parsed(text: string) {
  return ts.createSourceFile("receipt.ts", text, ts.ScriptTarget.Latest, true);
}
function fn(text: string, name: string): ts.FunctionDeclaration {
  const matches = parsed(text).statements.filter(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (matches.length !== 1 || !matches[0]!.body) throw Error("missing/duplicate body " + name);
  const node = matches[0]!;
  if (
    node.asteriskToken ||
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword || m.kind === ts.SyntaxKind.DefaultKeyword)
  )
    throw Error("changed body header");
  return node;
}
function inside(text: string, name: string): string {
  return fn(text, name).body!.getText().slice(1, -1);
}
function restoreWriterArguments(text: string): string {
  const edits: { start: number; end: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === "writeChar" || name === "writeStoredDigit" || name === "writeDigitFromTmp") {
        const arity = name === "writeDigitFromTmp" ? 1 : 2;
        expect(node.arguments).toHaveLength(arity);
        const binding = node.arguments[arity - 1]!;
        expect(binding.getText()).toBe("strDataTypeIdx");
        // Remove only the explicit relocated binding argument. A formatter's
        // trailing comma is punctuation, not another argument or instruction.
        edits.push({ start: arity === 1 ? node.arguments.pos : node.arguments[0]!.end, end: node.arguments.end });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed(text));
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + text.slice(edit.end);
  return text;
}
function beforeFinalReturn(text: string, name: string): string {
  const body = fn(text, name).body!;
  const statements = body.statements;
  const last = statements[statements.length - 1];
  if (!last || !ts.isReturnStatement(last) || statements.slice(0, -1).some(ts.isReturnStatement))
    throw Error("changed return population");
  return text.slice(body.getStart() + 1, last.getStart());
}
function checkPrivateHeader(text: string, name: string, params: string): void {
  const node = fn(text, name);
  expect(syntaxReceipt(text.slice(node.getStart(), node.body!.getStart()) + "{}")).toBe(
    syntaxReceipt(`function ${name}(${params}): Instr[] {}`),
  );
}
function locals(text: string, name: string): string {
  const node = fn(text, name),
    statements = node.body!.statements;
  const last = statements[statements.length - 1];
  if (!last || !ts.isReturnStatement(last) || !last.expression || !ts.isObjectLiteralExpression(last.expression))
    throw Error("changed final body return");
  const properties = last.expression.properties;
  if (properties.length !== 2 || properties[0]!.name?.getText() !== "locals" || properties[1]!.getText() !== "body")
    throw Error("changed body output");
  return properties[0]!.getText() + ",\nbody,\n";
}
function syntaxReceipt(text: string): string {
  const sf = parsed(text),
    tokens: string[] = [],
    comments = new Map<number, string>();
  const visit = (node: ts.Node): void => {
    for (const pos of [node.pos, node.end, node.getFullStart()])
      for (const range of [
        ...(ts.getLeadingCommentRanges(text, pos) ?? []),
        ...(ts.getTrailingCommentRanges(text, pos) ?? []),
      ])
        comments.set(range.pos, text.slice(range.pos, range.end));
    const children = node.getChildren(sf);
    if (
      !children.length &&
      ![ts.SyntaxKind.EndOfFileToken, ts.SyntaxKind.CommaToken, ts.SyntaxKind.SemicolonToken].includes(node.kind)
    )
      tokens.push(node.getText(sf));
    else children.forEach(visit);
  };
  visit(sf);
  return JSON.stringify({ tokens, comments: [...comments].sort(([a], [b]) => a - b).map(([, value]) => value) });
}
function canonicalInputs() {
  return {
    adapter: read("../src/codegen/number-ryu.ts"),
    tables: read(root + "number-ryu-tables.ts"),
    mul: read(root + "number-ryu-bodies.ts"),
    digits: read(root + "number-ryu-digits.ts"),
    buffer: read(root + "number-ryu-to-buffer.ts"),
  };
}
type Inputs = ReturnType<typeof canonicalInputs>;
function checkBuilderHeader(text: string, name: string, params: string): void {
  const node = fn(text, name),
    sf = node.getSourceFile();
  const header = text.slice(node.getStart(sf), node.body!.getStart(sf));
  expect(syntaxReceipt(header + "{}")).toBe(syntaxReceipt(`export function ${name}(${params}): NativeRyuBody {}`));
}
function checkCanonicalEnvelopes(input: Inputs): void {
  checkBuilderHeader(input.mul, "buildRyuMulShiftBody", "");
  checkBuilderHeader(input.digits, "buildRyuDigitsBody", "resources: RyuDigitsResources");
  checkBuilderHeader(input.buffer, "buildRyuToBufferBody", "resources: RyuToBufferResources");
  for (const name of ["emitE2NonNegative", "emitE2Negative", "emitCommonPath", "emitSlowPath"]) {
    checkPrivateHeader(input.digits, name, name.startsWith("emitE2") ? "resources: RyuDigitsResources" : "");
  }
  checkPrivateHeader(input.buffer, "buildPrologue", "resources: RyuToBufferResources");
  for (const name of ["A", "B", "C", "D"])
    checkPrivateHeader(input.buffer, "buildCase" + name, "strDataTypeIdx: number");
  const expectedFunctions: Record<keyof Omit<Inputs, "adapter">, readonly string[]> = {
    tables: [
      "pow5",
      "log2floor",
      "computePow5",
      "computeInvPow5",
      "toSignedI64",
      "buildInvSplit",
      "buildSplit",
      "buildRyuPowerTables",
      "buildRyuInverseSplit",
      "buildRyuSplit",
      "createRyuPowerArrayType",
    ],
    mul: ["buildRyuMulShiftBody"],
    digits: ["emitE2NonNegative", "emitE2Negative", "emitCommonPath", "emitSlowPath", "buildRyuDigitsBody"],
    buffer: ["buildPrologue", "buildCaseA", "buildCaseB", "buildCaseC", "buildCaseD", "buildRyuToBufferBody"],
  };
  const expectedRoutes = {
    tables: `import type { ArrayTypeDef } from "../../../wasm/model/module-records.js";
      import { RYU_I64 } from "./number-ryu-signatures.js";`,
    mul: `import type { Instr } from "../../../wasm/model/instructions.js";
      import { RYU_I32 as I32, RYU_I64 as I64, type NativeRyuBody } from "./number-ryu-signatures.js";
      export { buildRyuDigitsBody } from "./number-ryu-digits.js";
      export { buildRyuToBufferBody } from "./number-ryu-to-buffer.js";
      export { ryuMulShiftSignature, ryuDigitsSignature, ryuToBufferSignature } from "./number-ryu-signatures.js";
      export type { NativeRyuBody, RyuDigitsResources, RyuToBufferResources } from "./number-ryu-signatures.js";`,
    digits: `import type { Instr } from "../../../wasm/model/instructions.js";
      import { RYU_I32 as I32, RYU_I64 as I64, type NativeRyuBody, type RyuDigitsResources } from "./number-ryu-signatures.js";
      import { DOUBLE_POW5_INV_BITCOUNT, DOUBLE_POW5_BITCOUNT } from "./number-ryu-tables.js";
      export type { RyuDigitsResources } from "./number-ryu-signatures.js";`,
    buffer: `import type { Instr } from "../../../wasm/model/instructions.js";
      import { RYU_I32 as I32, RYU_I64 as I64, type NativeRyuBody, type RyuToBufferResources } from "./number-ryu-signatures.js";
      export type { RyuToBufferResources } from "./number-ryu-signatures.js";`,
  };
  for (const key of ["tables", "mul", "digits", "buffer"] as const) {
    const statements = parsed(input[key]).statements;
    expect(statements.filter(ts.isFunctionDeclaration).map((node) => node.name?.text)).toEqual(expectedFunctions[key]);
    expect(
      statements.every(
        (node) =>
          ts.isImportDeclaration(node) ||
          ts.isExportDeclaration(node) ||
          ts.isVariableStatement(node) ||
          ts.isFunctionDeclaration(node),
      ),
    ).toBe(true);
    const routes = statements.filter((node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node));
    expect(syntaxReceipt(routes.map((node) => node.getText()).join("\n"))).toBe(syntaxReceipt(expectedRoutes[key]));
    const firstFunction = statements.findIndex(ts.isFunctionDeclaration);
    expect(statements.slice(firstFunction).every(ts.isFunctionDeclaration)).toBe(true);
    if (key === "mul") expect(statements.some(ts.isVariableStatement)).toBe(false);
    else {
      const firstVariable = statements.find(ts.isVariableStatement)!;
      const expectedFirst = { tables: "DOUBLE_POW5_INV_BITCOUNT", digits: "P_VALUE", buffer: "C_ZERO" }[key];
      expect(firstVariable.declarationList.declarations[0]!.name.getText()).toBe(expectedFirst);
    }
  }
  expect(syntaxReceipt(fn(input.tables, "buildRyuPowerTables").body!.getText())).toBe(
    syntaxReceipt("{ return { inverse: buildRyuInverseSplit(), powers: buildRyuSplit() }; }"),
  );
  expect(syntaxReceipt(fn(input.tables, "buildRyuInverseSplit").body!.getText())).toBe(
    syntaxReceipt("{ return buildInvSplit(); }"),
  );
  expect(syntaxReceipt(fn(input.tables, "buildRyuSplit").body!.getText())).toBe(
    syntaxReceipt("{ return buildSplit(); }"),
  );
  expect(syntaxReceipt(fn(input.tables, "createRyuPowerArrayType").body!.getText())).toBe(
    syntaxReceipt('{ return { kind: "array", name: "__ryu_i64_arr", element: RYU_I64, mutable: false }; }'),
  );
}
function reconstruct(input: Inputs): string {
  expect(hash(donor.source)).toBe("053b4b0b4e6e3c600b4eccde3e68f507780dc12ad23ee8852541ffc052373724");
  checkCanonicalEnvelopes(input);
  const canonicalImports = parsed(input.adapter).statements.filter(
    (node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.includes("/number-ryu-"),
  );
  expect(syntaxReceipt(canonicalImports.map((node) => node.getText()).join("\n"))).toBe(
    syntaxReceipt(`
    import { buildRyuInverseSplit, buildRyuSplit, createRyuPowerArrayType } from "../runtime/wasmgc/values/number-ryu-tables.js";
    import { buildRyuMulShiftBody, buildRyuDigitsBody, buildRyuToBufferBody, ryuMulShiftSignature, ryuDigitsSignature, ryuToBufferSignature } from "../runtime/wasmgc/values/number-ryu-bodies.js";
  `),
  );
  const assembly = beforeFinalReturn(input.buffer, "buildRyuToBufferBody");
  expect(syntaxReceipt(assembly)).toBe(
    syntaxReceipt(`
    const body = buildPrologue(resources);
    body.push(...buildCaseA(resources.stringDataTypeIdx));
    body.push(...buildCaseB(resources.stringDataTypeIdx));
    body.push(...buildCaseC(resources.stringDataTypeIdx));
    body.push(...buildCaseD(resources.stringDataTypeIdx));
  `),
  );
  let out = input.adapter;
  const sf = parsed(out);
  for (const statement of [...sf.statements].reverse())
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.includes("/number-ryu-")
    ) {
      const route = statement.moduleSpecifier.text;
      if (
        !["../runtime/wasmgc/values/number-ryu-tables.js", "../runtime/wasmgc/values/number-ryu-bodies.js"].includes(
          route,
        )
      )
        throw Error("wrong canonical import route");
      out = out.slice(0, statement.getStart(sf)) + out.slice(statement.end);
    }
  const tableSlice = take(input.tables, "export const DOUBLE_POW5_INV_BITCOUNT", "export function buildRyuPowerTables");
  const relocationSeparator = "// ---------------------------------------------------------------------------";
  const splitEnd = fn(input.tables, "buildSplit").end;
  expect(input.tables.slice(splitEnd, input.tables.indexOf("export function buildRyuPowerTables")).trim()).toBe(
    relocationSeparator,
  );
  const tableSource = replace(tableSlice, relocationSeparator, "").replaceAll("export const ", "const ");
  const emitterMarker = "// ---------------------------------------------------------------------------\n// Emitters";
  out = replace(out, emitterMarker, tableSource + emitterMarker);
  out = replace(
    out,
    'const RYU_INV_GLOBAL = "__ryu_pow5_inv";',
    'const I32: ValType = { kind: "i32" };\nconst I64: ValType = { kind: "i64" };\nconst F64: ValType = { kind: "f64" };\n\nconst RYU_INV_GLOBAL = "__ryu_pow5_inv";',
  );
  out = replace(
    out,
    "ctx.mod.types.push(createRyuPowerArrayType());",
    'ctx.mod.types.push({ kind: "array", name: RYU_I64_ARR, element: I64, mutable: false });',
  );
  out = replace(out, "const inv = buildRyuInverseSplit();", "const inv = buildInvSplit();");
  out = replace(out, "const pw = buildRyuSplit();", "const pw = buildSplit();");
  const mulSetup = beforeFinalReturn(input.mul, "buildRyuMulShiftBody");
  let digitSetup = take(input.digits, "// param 0: value (f64)", "export function buildRyuDigitsBody");
  digitSetup = digitSetup
    .replace("globalIdx: number, arrType: number", "globalIdx: number")
    .replace("mExpr: Instr[], mulShiftIdx: number", "mExpr: Instr[]");
  digitSetup = digitSetup.replace(
    /function (emitE2NonNegative|emitE2Negative)\(resources: RyuDigitsResources\)/g,
    "function $1()",
  );
  digitSetup = digitSetup.replace(
    / {2}const \{ (inverseGlobalIdx: invIdx|powersGlobalIdx: powIdx), tableTypeIdx: arrType, mulShift: mulShiftIdx \} = resources;\n/g,
    "",
  );
  digitSetup = digitSetup
    .replaceAll("loadFactor(invIdx, arrType)", "loadFactor(invIdx)")
    .replaceAll("loadFactor(powIdx, arrType)", "loadFactor(powIdx)")
    .replaceAll(", mulShiftIdx)", ")");
  const digitBody = beforeFinalReturn(input.digits, "buildRyuDigitsBody")
    .replaceAll("emitE2NonNegative(resources)", "emitE2NonNegative()")
    .replaceAll("emitE2Negative(resources)", "emitE2Negative()");
  let bufferSetup = take(input.buffer, "const C_ZERO = 48;", "function buildPrologue");
  bufferSetup = bufferSetup
    .replace("writeDigitFromTmp = (strDataTypeIdx: number)", "writeDigitFromTmp = ()")
    .replace("code: number, strDataTypeIdx: number", "code: number")
    .replace("idxExpr: Instr[], strDataTypeIdx: number", "idxExpr: Instr[]")
    .replaceAll("writeDigitFromTmp(strDataTypeIdx)", "writeDigitFromTmp()");
  let bufferBody = inside(input.buffer, "buildPrologue")
    .replace(/\s*const \{ digits: digitsIdx, stringDataTypeIdx: strDataTypeIdx \} = resources;/, "")
    .replace("return [", "const body: Instr[] = [");
  for (const name of ["A", "B", "C", "D"]) {
    let fragment = inside(input.buffer, "buildCase" + name).replace("return [", "body.push(");
    const last = fragment.lastIndexOf("];");
    if (last < 0) throw Error("missing case return");
    fragment = fragment.slice(0, last) + ");" + fragment.slice(last + 2);
    bufferBody += fragment;
  }
  bufferBody = restoreWriterArguments(bufferBody);
  const rows = [
    [
      "emitRyuMulShift",
      input.mul,
      "buildRyuMulShiftBody",
      mulSetup,
      "const typeIdx = addFuncType(ctx, [I64, I64, I64, I32], [I64]);",
    ],
    [
      "emitRyuDigits",
      input.digits,
      "buildRyuDigitsBody",
      digitSetup + digitBody,
      "const typeIdx = addFuncType(ctx, [F64], [I64, I32]);",
    ],
    [
      "emitRyuToBuf",
      input.buffer,
      "buildRyuToBufferBody",
      bufferSetup + bufferBody,
      'const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };\nconst typeIdx = addFuncType(ctx, [F64, I32, strDataRef, I32], [I32]);',
    ],
  ];
  for (const [name, canonical, builder, construction, typeCall] of rows) {
    const live = fn(out, name!).getText();
    const beforeRegistration = take(live, "  const definition =", "  const funcIdx =");
    const definitions: Record<string, string> = {
      emitRyuMulShift: "buildRyuMulShiftBody()",
      emitRyuDigits:
        "buildRyuDigitsBody({ mulShift: mulShiftIdx, tableTypeIdx: arrType, inverseGlobalIdx: invIdx, powersGlobalIdx: powIdx })",
      emitRyuToBuf: "buildRyuToBufferBody({ digits: digitsIdx, stringDataTypeIdx: strDataTypeIdx })",
    };
    const signatures: Record<string, string> = {
      emitRyuMulShift: "ryuMulShiftSignature()",
      emitRyuDigits: "ryuDigitsSignature()",
      emitRyuToBuf: 'ryuToBufferSignature({ kind: "ref", typeIdx: strDataTypeIdx })',
    };
    expect(syntaxReceipt(beforeRegistration)).toBe(
      syntaxReceipt(
        `const definition = ${definitions[name!]}; const signature = ${signatures[name!]}; const typeIdx = addFuncType(ctx, signature.params, signature.results);`,
      ),
    );
    let restored = replace(live, beforeRegistration, construction! + typeCall! + "\n");
    restored = replace(
      restored,
      "locals: definition.locals,\n    body: definition.body,",
      locals(canonical!, builder!),
    );
    out = replace(out, live, restored);
  }
  return out;
}
function assertInverse(input: Inputs): void {
  const actual = JSON.parse(syntaxReceipt(reconstruct(input))) as { tokens: string[]; comments: string[] };
  const expected = JSON.parse(syntaxReceipt(donor.source)) as typeof actual;
  for (const part of ["tokens", "comments"] as const) {
    const index = actual[part].findIndex((value, i) => value !== expected[part][i]);
    if (index !== -1)
      throw new Error(
        `donor ${part} mismatch at ${index}: ${JSON.stringify({ actual: actual[part].slice(index, index + 6), expected: expected[part].slice(index, index + 6) })}`,
      );
    expect(actual[part]).toHaveLength(expected[part].length);
  }
}

function checkReferenceType(expression: string): readonly ts.Diagnostic[] {
  const file = fileURLToPath(new URL("./__ryu_reference_type_control.ts", import.meta.url));
  const source = `import { ryuToBufferSignature } from "../src/runtime/wasmgc/values/number-ryu-signatures.js";\nryuToBufferSignature(${expression});`;
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
  };
  const host = ts.createCompilerHost(options),
    originalGetSource = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === file
      ? ts.createSourceFile(name, source, languageVersion, true)
      : originalGetSource(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([file], options, host);
  return ts.getPreEmitDiagnostics(program);
}
function originalEmitters(): Pick<typeof currentRyu, "emitRyuDigits" | "emitRyuToBuf"> {
  expect(hash(donor.source)).toBe("053b4b0b4e6e3c600b4eccde3e68f507780dc12ad23ee8852541ffc052373724");
  const emitted = ts.transpileModule(donor.source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  const imports = (path: string) => {
    if (path === "./registry/types.js") return registryTypes;
    if (path === "./func-space.js") return functionSpace;
    throw Error("unexpected original donor dependency " + path);
  };
  new Function("require", "exports", emitted)(imports, exports);
  return exports as Pick<typeof currentRyu, "emitRyuDigits" | "emitRyuToBuf">;
}
function legacyContext() {
  const input = sourceInput({ "./entry.ts": "export function run(): number { return 42; }" });
  const ctx = createCodegenContext(createEmptyModule(), input.checker, { standalone: true });
  return ctx;
}

describe("canonical Ryū donor ownership", () => {
  it.each(["cold", "digits-first", "array", "inverse", "powers"] as const)(
    "preserves complete real legacy module/cache observations for %s",
    (mode) => {
      const original = originalEmitters(),
        before = legacyContext(),
        after = legacyContext();
      if (["array", "inverse", "powers"].includes(mode)) {
        const seed = legacyContext();
        original.emitRyuDigits(seed);
        const tableIndex = seed.arrayTypeMap.get("__ryu_i64_arr")!;
        for (const ctx of [before, after]) {
          // Authentic old emitted type/global definitions, not surrogate bodies.
          ctx.mod.types.splice(0, ctx.mod.types.length, ...structuredClone(seed.mod.types.slice(0, tableIndex + 1)));
          ctx.arrayTypeMap.set("__ryu_i64_arr", tableIndex);
          const global = seed.mod.globals.find(
            (row) => row.name === (mode === "inverse" ? "__ryu_pow5_inv" : "__ryu_pow5"),
          );
          if (mode !== "array") ctx.mod.globals.push(structuredClone(global!));
        }
      }
      if (mode === "digits-first") {
        original.emitRyuDigits(before);
        currentRyu.emitRyuDigits(after);
      }
      expect(original.emitRyuToBuf(before, before.nativeStrDataTypeIdx!)).toBe(
        currentRyu.emitRyuToBuf(after, after.nativeStrDataTypeIdx!),
      );
      expect(after.mod).toEqual(before.mod);
      expect([...after.funcMap]).toEqual([...before.funcMap]);
      expect([...after.arrayTypeMap]).toEqual([...before.arrayTypeMap]);
      expect([...after.funcTypeCache]).toEqual([...before.funcTypeCache]);
      const objects = [after.mod.types.slice(), after.mod.globals.slice(), after.mod.functions.slice()];
      currentRyu.emitRyuToBuf(after, after.nativeStrDataTypeIdx!);
      original.emitRyuToBuf(before, before.nativeStrDataTypeIdx!);
      expect(after.mod).toEqual(before.mod);
      for (const [index, rows] of [after.mod.types, after.mod.globals, after.mod.functions].entries()) {
        expect(rows).toHaveLength(objects[index]!.length);
        rows.forEach((row, i) => expect(row).toBe(objects[index]![i]));
      }
    },
  );
  it("reconstructs the complete original donor including nested helpers, locals, order and comments", () =>
    assertInverse(canonicalInputs()));
  it.each([
    "limb",
    "local",
    "branch",
    "return",
    "route",
    "alias",
    "header",
    "extra",
    "table-order",
    "canonical-route",
    "trailing-initializer",
    "missing-block",
    "shadow-local",
    "extra-prefix",
    "private-default-param",
  ] as const)("rejects %s mutation after a real positive", (kind) => {
    const input = canonicalInputs();
    assertInverse(input);
    if (kind === "limb")
      input.tables = replace(input.tables, "const MASK64 = (1n << 64n) - 1n;", "const MASK64 = (1n << 63n) - 1n;");
    if (kind === "local") input.digits = replace(input.digits, 'name: "pad13"', 'name: "wrong13"');
    if (kind === "branch") input.digits = replace(input.digits, "then: emitSlowPath(),", "then: emitCommonPath(),");
    if (kind === "return")
      input.buffer = replace(
        input.buffer,
        "body.push(...buildCaseD(resources.stringDataTypeIdx));",
        "body.push(...buildCaseC(resources.stringDataTypeIdx));",
      );
    if (kind === "route")
      input.adapter = replace(
        input.adapter,
        'from "../runtime/wasmgc/values/number-ryu-bodies.js"',
        'from "../runtime/wasmgc/values/foreign.js"',
      );
    if (kind === "alias")
      input.adapter = replace(input.adapter, "buildRyuInverseSplit,", "buildRyuInverseSplit as other,");
    if (kind === "header")
      input.mul = replace(
        input.mul,
        "export function buildRyuMulShiftBody",
        "export async function buildRyuMulShiftBody",
      );
    if (kind === "extra") input.digits += "\nvoid 0;\n";
    if (kind === "table-order")
      input.tables = replace(
        input.tables,
        "inverse: buildRyuInverseSplit(), powers: buildRyuSplit()",
        "powers: buildRyuSplit(), inverse: buildRyuInverseSplit()",
      );
    if (kind === "canonical-route")
      input.digits = replace(input.digits, 'from "./number-ryu-tables.js"', 'from "./foreign-tables.js"');
    if (kind === "trailing-initializer") input.tables += "\nconst extra = buildRyuPowerTables();\n";
    if (kind === "missing-block")
      input.buffer = replace(input.buffer, "body.push(...buildCaseB(resources.stringDataTypeIdx));", "");
    if (kind === "shadow-local")
      input.digits = replace(
        input.digits,
        "export function buildRyuDigitsBody(resources: RyuDigitsResources): NativeRyuBody {",
        "export function buildRyuDigitsBody(resources: RyuDigitsResources): NativeRyuBody {\nconst L_BITS = 2;",
      );
    if (kind === "extra-prefix")
      input.buffer = replace(
        input.buffer,
        "export function buildRyuToBufferBody(resources: RyuToBufferResources): NativeRyuBody {",
        "export function buildRyuToBufferBody(resources: RyuToBufferResources): NativeRyuBody {\nvoid resources;",
      );
    if (kind === "private-default-param")
      input.buffer = replace(
        input.buffer,
        "function buildCaseA(strDataTypeIdx: number)",
        "function buildCaseA(strDataTypeIdx: number = 0)",
      );
    expect(() => assertInverse(input)).toThrow();
  });
  it("preserves table limb population and the combined generator order", () => {
    const tables = buildRyuPowerTables();
    expect(tables.inverse).toEqual(buildRyuInverseSplit());
    expect(tables.powers).toEqual(buildRyuSplit());
    expect([tables.inverse.length, tables.powers.length]).toEqual([582, 652]);
    expect([...tables.inverse, ...tables.powers].every((n) => n >= -(1n << 63n) && n < 1n << 63n)).toBe(true);
  });
  it("uses fresh signature tuples and the exact supplied nonnullable reference", () => {
    expect(ryuMulShiftSignature()).toEqual({
      params: [{ kind: "i64" }, { kind: "i64" }, { kind: "i64" }, { kind: "i32" }],
      results: [{ kind: "i64" }],
    });
    expect(ryuDigitsSignature()).toEqual({ params: [{ kind: "f64" }], results: [{ kind: "i64" }, { kind: "i32" }] });
    const data = { kind: "ref", typeKey: "data" } as const;
    expect(ryuToBufferSignature(data).params[2]).toBe(data);
    expect(ryuDigitsSignature().params).not.toBe(ryuDigitsSignature().params);
  });
  it("compiler-checks physical and symbolic nonnullable refs and rejects every invalid coordinate shape", () => {
    expect(checkReferenceType('{ kind: "ref", typeIdx: 7 }')).toEqual([]);
    expect(checkReferenceType('{ kind: "ref", typeKey: "data" }')).toEqual([]);
    for (const expression of [
      '{ kind: "ref_null", typeIdx: 7 }',
      '{ kind: "ref" }',
      '{ kind: "ref", typeIdx: 7, typeKey: "data" }',
      '{ kind: "anyref" }',
    ]) {
      const errors = checkReferenceType(expression);
      expect(
        errors.some(
          (error) =>
            error.file?.fileName.endsWith("__ryu_reference_type_control.ts") &&
            error.category === ts.DiagnosticCategory.Error,
        ),
      ).toBe(true);
    }
  });
});
