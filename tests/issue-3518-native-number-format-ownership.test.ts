// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { createEmptyModule } from "../src/ir/types.js";
import { emitNativeNumberFormat, ensureIrNativeNumberToString } from "../src/codegen/number-format-native.js";
import * as registryTypes from "../src/codegen/registry/types.js";
import * as functionSpace from "../src/codegen/func-space.js";
import * as nativeStrings from "../src/codegen/native-strings.js";
import * as currentRyu from "../src/codegen/number-ryu.js";
import * as shared from "../src/codegen/shared.js";
import * as nodes from "../src/ir/nodes.js";
import * as selfhost from "../src/codegen/stdlib-selfhost.js";
import * as definition from "../src/stdlib/number-format.js";

const root = new URL("../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), "utf8");
const hash = (source: string): string => createHash("sha256").update(source).digest("hex");
const donor = JSON.parse(read("tests/fixtures/issue-3518-native-number-format-donor.json")) as {
  base: string;
  files: { path: string; sha256: string; source: string }[];
};
const receipts = [
  ["src/codegen/number-format-native.ts", "780f229fa2ea01fb33c2abf3070271b9e8d401a6b6096eec19d05af7f9b7c4ff"],
  ["src/codegen/number-format-selfhost.ts", "179ef0f195aae80f68a9a2320e80514445d8c5a2ae3cce6d5da1c6ad3633a582"],
  ["src/codegen/stdlib-selfhost.ts", "66cfa178f092dabdf7b4068ae8da61f61df9cbc40dbcf582b1ef62a2610d11e5"],
] as const;

function reconstructInline(adapter: string, runtime: string): string {
  const inline = functionSource(runtime, "buildInlineNativeStringLiteral");
  const remainder = replaceOnce(
    runtime,
    "/** Exact self-hosted inline WTF-16 literal, independent of primary UTF8 policy. */\n" + inline + "\n\n",
    "",
  );
  // Exact unchanged canonical module at efe352; no git access during collection.
  expect(hash(remainder)).toBe("9c02d9a8ebc735c66a7552c38ebd649fa2392d63f891cdbce7be1257dba0d12d");
  const declaration = runtime.match(
    /export function buildInlineNativeStringLiteral\(\n {2}types: \{ nativeStrDataTypeIdx: number; nativeStrTypeIdx: number \},\n {2}value: string,\n\): Instr\[\] \{\n([\s\S]*?)\n\}/,
  );
  if (!declaration) throw new Error("changed inline declaration");
  const importLine =
    'import { buildInlineNativeStringLiteral } from "../runtime/wasmgc/values/string-literal-bodies.js";\n';
  const call = "      return buildInlineNativeStringLiteral(ctx, value);";
  if (adapter.split(importLine).length !== 2 || adapter.split(call).length !== 2)
    throw new Error("changed inline adapter population");
  const body = declaration[1]!
    .replaceAll("types.nativeStr", "ctx.nativeStr")
    .split("\n")
    .map((line) => "    " + line)
    .join("\n");
  return adapter.replace(importLine, "").replace(call, body);
}

describe("D2 authenticated donor preservation", () => {
  it("pins the complete committed donor population without live git or fallback", () => {
    expect(donor.base).toBe("efe352fee8afc3feb6a28c34d00fc658dc1fb205");
    expect(donor.files.map(({ path, sha256 }) => [path, sha256])).toEqual(receipts);
    for (const file of donor.files) expect(hash(file.source)).toBe(file.sha256);
  });

  it("reconstructs the whole stdlib adapter from the actual inline body", () => {
    const adapter = read("src/codegen/stdlib-selfhost.ts");
    const runtime = read("src/runtime/wasmgc/values/string-literal-bodies.ts");
    const expected = donor.files[2]!;
    const reconstructed = reconstructInline(adapter, runtime);
    expect(reconstructed).toBe(expected.source);
    expect(hash(reconstructed)).toBe(expected.sha256);
    // Positive first; evaluate countermodels outside the expected comparison failure.
    for (const mutated of [
      runtime.replace("value.charCodeAt(i)", "value.codePointAt(i)"),
      runtime.replace("value: 0", "value: 1"),
      runtime.replace("  return ops;", "  ops.reverse();\n  return ops;"),
    ]) {
      expect(mutated).not.toBe(runtime);
      const candidate = reconstructInline(adapter, mutated);
      expect(() => expect(candidate).toBe(expected.source)).toThrow();
    }
    for (const mutated of [
      adapter.replace(importLineForTest(), ""),
      adapter.replace("buildInlineNativeStringLiteral(ctx", "renamedInline(ctx"),
    ]) {
      expect(() => reconstructInline(mutated, runtime)).toThrow("changed inline adapter population");
    }
  });
});

function importLineForTest(): string {
  return 'import { buildInlineNativeStringLiteral } from "../runtime/wasmgc/values/string-literal-bodies.js";\n';
}

function functionSource(source: string, name: string): string {
  const file = ts.createSourceFile("receipt.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const matches = file.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (matches.length !== 1 || !matches[0]!.body) throw new Error("missing or duplicated function " + name);
  return matches[0]!.getText(file);
}
function authenticateEnvelope(source: string, family: "format" | "radix"): void {
  const file = ts.createSourceFile("envelope.ts", source, ts.ScriptTarget.Latest, true);
  const imports =
    family === "format"
      ? [
          'import type { FuncHandle, Instr, LocalDef, ValType } from "../../../wasm/model/instructions.js";',
          'import type { NumberFormatStringTypes } from "./number-format-radix-bodies.js";',
        ]
      : [
          'import type { FuncHandle, Instr, ValType } from "../../../wasm/model/instructions.js";',
          'import type { NativeNumberFormatBody } from "./number-format-bodies.js";',
        ];
  const names =
    family === "format"
      ? [
          "NativeNumberFormatBody",
          "numberFormatSignatures",
          "BUF_CAP",
          "MAX_SAFE_INTEGER",
          "C_ZERO",
          "C_MINUS",
          "C_PLUS",
          "C_DOT",
          "C_LC_E",
          "putConst",
          "emitNonFinitePrologue",
          "emitIntegerDigits",
          "buildNumberFormatFinalizeBody",
          "buildNumberFormatToStringBody",
          "buildNumberFormatToFixedBody",
          "buildNumberFormatToExponentialBody",
          "buildNumberFormatToPrecisionBody",
          "buildExponentialNormalization",
          "buildNumberFormatNativeAdapterBody",
        ]
      : [
          "NumberFormatStringTypes",
          "L",
          "TRUNC",
          "buildNumberFormatNewBody",
          "buildNumberFormatGetBody",
          "buildNumberFormatSetBody",
          "buildNumberFormatTrapBody",
          "buildNumberFormatFinBody",
          "buildNumberFormatRadixThunkBody",
        ];
  expect(file.statements).toHaveLength(imports.length + names.length);
  imports.forEach((expected, index) => expect(tokens(file.statements[index]!.getText(file))).toEqual(tokens(expected)));
  const actualNames = file.statements.slice(imports.length).map((statement) => {
    if (ts.isVariableStatement(statement)) {
      expect(statement.modifiers?.length ?? 0).toBe(0);
      expect(statement.declarationList.flags & ts.NodeFlags.Const).toBe(ts.NodeFlags.Const);
      expect(statement.declarationList.declarations).toHaveLength(1);
      return statement.declarationList.declarations[0]!.name.getText(file);
    }
    if (ts.isInterfaceDeclaration(statement) || ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text;
      const exported =
        ts.isInterfaceDeclaration(statement) ||
        name === "numberFormatSignatures" ||
        name?.startsWith("buildNumberFormat");
      expect(statement.modifiers?.map((modifier) => modifier.kind) ?? []).toEqual(
        exported ? [ts.SyntaxKind.ExportKeyword] : [],
      );
      if (ts.isFunctionDeclaration(statement) && statement.asteriskToken) throw new Error("changed generator header");
      return name;
    }
    throw new Error("unexpected canonical top-level statement");
  });
  expect(actualNames).toEqual(names);
  const shape =
    family === "format"
      ? "export interface NativeNumberFormatBody { readonly locals: LocalDef[]; readonly body: Instr[]; }"
      : "export interface NumberFormatStringTypes { readonly dataTypeIdx: number; readonly nativeStringTypeIdx: number; readonly anyStringTypeIdx: number; }";
  expect(tokens(file.statements[imports.length]!.getText(file))).toEqual(tokens(shape));
}
function replaceOnce(source: string, before: string, after: string): string {
  if (before.startsWith("import ") && before.includes(" from ")) {
    const wanted = ts.createSourceFile("imports.ts", before, ts.ScriptTarget.Latest, true);
    const actual = ts.createSourceFile("actual.ts", source, ts.ScriptTarget.Latest, true);
    const first = actual.statements.findIndex(
      (node) => tokens(node.getText(actual)).join(" ") === tokens(wanted.statements[0]!.getText(wanted)).join(" "),
    );
    if (first < 0) throw new Error("changed inverse import span");
    wanted.statements.forEach((node, index) =>
      expect(tokens(actual.statements[first + index]!.getText(actual))).toEqual(tokens(node.getText(wanted))),
    );
    return (
      source.slice(0, actual.statements[first]!.getStart(actual)) +
      after +
      source.slice(actual.statements[first + wanted.statements.length - 1]!.end)
    );
  }
  if (source.split(before).length !== 2) throw new Error("changed inverse span: " + before);
  return source.replace(before, after);
}
function tokens(source: string): string[] {
  const file = ts.createSourceFile("tokens.ts", source, ts.ScriptTarget.Latest, true);
  const entries = new Map<number, string>();
  const visit = (node: ts.Node): void => {
    for (const position of [node.pos, node.end, node.getFullStart()]) {
      for (const range of [
        ...(ts.getLeadingCommentRanges(source, position) ?? []),
        ...(ts.getTrailingCommentRanges(source, position) ?? []),
      ])
        entries.set(range.pos, source.slice(range.pos, range.end));
    }
    const children = node.getChildren(file);
    if (children.length) children.forEach(visit);
    else if (node.kind !== ts.SyntaxKind.EndOfFileToken && node.end > node.getStart(file))
      entries.set(node.getStart(file), node.getText(file));
  };
  visit(file);
  const result = [...entries].sort(([a], [b]) => a - b).map(([, text]) => text);
  // Prettier may add a trailing list comma; preserve separators and array
  // elisions, which are semantic (including the one-element hole `[,]`).
  return result.filter(
    (token, index) =>
      !(
        token === "," &&
        ["}", ")", "]"].includes(result[index + 1] ?? "") &&
        !["[", ","].includes(result[index - 1] ?? "")
      ),
  );
}

function returnedField(source: string, name: string): string {
  const file = ts.createSourceFile("return.ts", source, ts.ScriptTarget.Latest, true);
  const fn = file.statements.find(ts.isFunctionDeclaration)!;
  const returned = fn.body!.statements.filter(ts.isReturnStatement);
  if (fn.body!.statements.at(-1) !== returned[0]) throw new Error("changed final return boundary");
  if (returned.length !== 1 || !returned[0]!.expression || !ts.isObjectLiteralExpression(returned[0]!.expression))
    throw new Error("changed builder return");
  const object = returned[0]!.expression;
  expect(object.properties.map((row) => row.name?.getText(file))).toEqual(["locals", "body"]);
  const field = object.properties.find((row) => row.name?.getText(file) === name);
  if (!field) throw new Error("missing return field");
  return ts.isPropertyAssignment(field) ? field.initializer.getText(file) : field.getText(file);
}

function inverseNative(adapter: string, runtime: string): string {
  authenticateEnvelope(runtime, "format");
  const importBlock =
    'import {\n  buildNumberFormatFinalizeBody, buildNumberFormatToStringBody, buildNumberFormatToFixedBody,\n  buildNumberFormatToExponentialBody, buildNumberFormatToPrecisionBody,\n  buildNumberFormatNativeAdapterBody, numberFormatSignatures,\n} from "../runtime/wasmgc/values/number-format-bodies.js";\nimport type { NumberFormatStringTypes } from "../runtime/wasmgc/values/number-format-radix-bodies.js";';
  let result = replaceOnce(adapter, importBlock, "");
  result = replaceOnce(result, "import type { ValType, WasmFunction }", "import type { Instr, ValType, WasmFunction }");
  const typesAdapter = functionSource(result, "numberFormatTypes");
  expect(tokens(typesAdapter)).toEqual(
    tokens(
      "function numberFormatTypes(ctx: CodegenContext): NumberFormatStringTypes { return { dataTypeIdx: ctx.nativeStrDataTypeIdx, nativeStringTypeIdx: ctx.nativeStrTypeIdx, anyStringTypeIdx: ctx.anyStrTypeIdx }; }",
    ),
  );
  const constants = runtime.slice(runtime.indexOf("const BUF_CAP"), runtime.indexOf("\nfunction putConst"));
  result = replaceOnce(result, typesAdapter, constants);
  for (const [name, nextDoc] of [
    ["putConst", "/**\n * Build the non-finite"],
    ["emitNonFinitePrologue", "/**\n * Emit a loop"],
    ["emitIntegerDigits", "/**\n * (#3912)"],
  ]) {
    let moved = functionSource(runtime, name!);
    if (name === "emitNonFinitePrologue")
      moved = replaceOnce(
        moved,
        "function emitNonFinitePrologue(\n",
        "function emitNonFinitePrologue(\n  ctx: CodegenContext,\n",
      );
    result = replaceOnce(result, nextDoc!, moved + "\n\n" + nextDoc);
  }
  for (const name of ["ToString", "ToFixed", "ToExponential", "ToPrecision"] as const) {
    const originalAdapter = functionSource(result, "emit" + name);
    const builder = functionSource(runtime, "buildNumberFormat" + name + "Body");
    const at = originalAdapter.indexOf("  const types = numberFormatTypes(ctx);");
    const end = originalAdapter.indexOf("  const typeIdx = addFuncType");
    if (at < 0 || end < at) throw new Error("changed formatter adapter construction");
    const plumbing = originalAdapter.slice(at, end);
    const args =
      name === "ToString"
        ? 'types, finalize: finalizeIdx, radix: radixIdx, ryuToBuffer: ryuToBufIdx, integerBeforeScratch: process.env.JS2WASM_NUMBER_TO_STRING_INTEGER_FASTPATH !== "0",'
        : name === "ToFixed"
          ? 'types, finalize: finalizeIdx, toString: ctx.funcMap.get("number_toString"),'
          : name === "ToPrecision"
            ? 'types, finalize: finalizeIdx, toFixed: ctx.funcMap.get("number_toFixed"), toExponential: ctx.funcMap.get("number_toExponential"), toString: ctx.funcMap.get("number_toString"),'
            : "types, finalize: finalizeIdx,";
    expect(tokens(plumbing)).toEqual(
      tokens(
        `const types = numberFormatTypes(ctx); const signature = numberFormatSignatures<ValType>({ data: bufType, nullableData: { kind: "ref_null", typeIdx: strDataTypeIdx }, anyString: { kind: "ref", typeIdx: ctx.anyStrTypeIdx } }).${name === "ToString" ? "toString" : "withDigits"}; const built = buildNumberFormat${name}Body({ ${args} });`,
      ),
    );
    let restored =
      originalAdapter.slice(0, at) + formatterConstruction(runtime, name) + "\n" + originalAdapter.slice(end);
    restored = replaceOnce(
      restored,
      "addFuncType(ctx, signature.params, signature.results)",
      `addFuncType(ctx, [${name === "ToString" ? "f64" : "f64, f64"}], [extern])`,
    );
    restored = replaceOnce(restored, "locals: built.locals", "locals: " + returnedField(builder, "locals"));
    expect(returnedField(builder, "body")).toBe("body");
    restored = replaceOnce(restored, "body: built.body", "body");
    result = replaceOnce(result, originalAdapter, restored);
  }
  const finalize = functionSource(result, "emitFinalize");
  const builder = functionSource(runtime, "buildNumberFormatFinalizeBody");
  const bodyStart = builder.indexOf("  const strTypeIdx");
  const bodyEnd = builder.lastIndexOf("\n  return {");
  expect(tokens(builder.slice(0, bodyStart))).toEqual(
    tokens("export function buildNumberFormatFinalizeBody(types: NumberFormatStringTypes): NativeNumberFormatBody {"),
  );
  let construction = builder
    .slice(bodyStart, bodyEnd)
    .replaceAll("types.nativeStringTypeIdx", "ctx.nativeStrTypeIdx")
    .replaceAll("types.dataTypeIdx", "ctx.nativeStrDataTypeIdx");
  construction = replaceOnce(
    construction,
    '  const i32: ValType = { kind: "i32" };',
    '  const i32: ValType = { kind: "i32" };\n  const extern: ValType = { kind: "externref" };',
  );
  const from = finalize.indexOf("  const types =");
  const to = finalize.indexOf("  const typeIdx =");
  const plumbing = finalize.slice(from, to);
  expect(tokens(plumbing)).toEqual(
    tokens(
      'const types = numberFormatTypes(ctx); const built = buildNumberFormatFinalizeBody(types); const signature = numberFormatSignatures<ValType>({data:{kind:"ref",typeIdx:types.dataTypeIdx},nullableData:{kind:"ref_null",typeIdx:types.dataTypeIdx},anyString:{kind:"ref",typeIdx:types.anyStringTypeIdx},}).finalize;',
    ),
  );
  let restored = finalize.slice(0, from) + construction + "\n" + finalize.slice(to);
  restored = replaceOnce(
    restored,
    "addFuncType(ctx, signature.params, signature.results)",
    "addFuncType(ctx, [bufType, i32], [extern])",
  );
  restored = replaceOnce(restored, "locals: built.locals", "locals: " + returnedField(builder, "locals"));
  expect(returnedField(builder, "body")).toBe("body");
  restored = replaceOnce(restored, "body: built.body", "body");
  result = replaceOnce(result, finalize, restored);
  const native = functionSource(result, "ensureIrNativeNumberToString");
  const sigStart = native.indexOf("  const signature =");
  const sigEnd = native.indexOf("  const funcIdx =", sigStart);
  expect(tokens(native.slice(sigStart, sigEnd))).toEqual(
    tokens(
      'const signature = numberFormatSignatures<ValType>({data:{kind:"ref",typeIdx:ctx.nativeStrDataTypeIdx},nullableData:{kind:"ref_null",typeIdx:ctx.nativeStrDataTypeIdx},anyString:{kind:"ref",typeIdx:anyStrTypeIdx},}).nativeToString; const sigIdx = addFuncType(ctx, signature.params, signature.results);',
    ),
  );
  let nativeRestored =
    native.slice(0, sigStart) +
    '  const sigIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "ref", typeIdx: anyStrTypeIdx }]);\n' +
    native.slice(sigEnd);
  const nativeBuilder = functionSource(runtime, "buildNumberFormatNativeAdapterBody");
  expect(tokens(nativeBuilder.slice(0, nativeBuilder.indexOf("  return {")))).toEqual(
    tokens(
      "export function buildNumberFormatNativeAdapterBody(resources: { readonly toString: FuncHandle; readonly anyStringTypeIdx: number; }): NativeNumberFormatBody {",
    ),
  );
  expect(returnedField(nativeBuilder, "locals")).toBe("[]");
  const nativeBody = returnedField(nativeBuilder, "body")
    .replaceAll("resources.toString", "inner")
    .replaceAll("resources.anyStringTypeIdx", "anyStrTypeIdx");
  nativeRestored = replaceOnce(
    nativeRestored,
    "const { body } = buildNumberFormatNativeAdapterBody({ toString: inner, anyStringTypeIdx: anyStrTypeIdx });",
    "const body: Instr[] = " + nativeBody + ";",
  );
  return replaceOnce(result, native, nativeRestored);
}

describe("whole native formatter inverse", () => {
  it("preserves all retained wrappers, documentation and executable construction", () => {
    const adapter = read("src/codegen/number-format-native.ts");
    const runtime = read("src/runtime/wasmgc/values/number-format-bodies.ts");
    const actual = inverseNative(adapter, runtime);
    expect(tokens(actual)).toEqual(tokens(donor.files[0]!.source));
    for (const changed of [
      adapter.replace("if (fuseCarrier) return inner;", "if (fuseCarrier) return null;"),
      adapter.replace('ctx.funcMap.set("number_toString", funcIdx);', 'ctx.funcMap.set("number_toString", 0);'),
    ]) {
      expect(changed).not.toBe(adapter);
      const candidate = inverseNative(changed, runtime);
      expect(() => expect(tokens(candidate)).toEqual(tokens(donor.files[0]!.source))).toThrow();
    }
  });
});

function inverseSelfhost(adapter: string, runtime: string): string {
  authenticateEnvelope(runtime, "radix");
  const imports =
    'import {\n  buildNumberFormatNewBody, buildNumberFormatGetBody, buildNumberFormatSetBody,\n  buildNumberFormatFinBody, buildNumberFormatTrapBody, buildNumberFormatRadixThunkBody,\n} from "../runtime/wasmgc/values/number-format-radix-bodies.js";\nimport { numberFormatSignatures } from "../runtime/wasmgc/values/number-format-bodies.js";';
  const constants = runtime.slice(runtime.indexOf("const L ="), runtime.indexOf("\n\nexport function"));
  let result = replaceOnce(adapter, imports, constants);
  const kernels = functionSource(result, "ensureNumFmtBufKernels");
  const firstComment = kernels.indexOf("  // __nfd_new");
  const prologueEnd = kernels.indexOf("  const types =");
  if (firstComment < prologueEnd || prologueEnd < 0) throw new Error("changed kernel adapter");
  const expectedPlumbing =
    'const types = { dataTypeIdx: ctx.nativeStrDataTypeIdx, nativeStringTypeIdx: ctx.nativeStrTypeIdx, anyStringTypeIdx: ctx.anyStrTypeIdx }; const signatures = numberFormatSignatures<ValType>({data:{kind:"ref",typeIdx:types.dataTypeIdx},nullableData:{kind:"ref_null",typeIdx:types.dataTypeIdx},anyString:{kind:"ref",typeIdx:types.anyStringTypeIdx},}); const emit = (name: string, signature: { params: ValType[]; results: ValType[] }, built: { locals: LocalDef[]; body: Instr[] }): void => { emitFunc(ctx, name, signature.params, signature.results, built.locals, built.body); };';
  expect(tokens(kernels.slice(prologueEnd, firstComment))).toEqual(tokens(expectedPlumbing));
  const originalTypes =
    'const strTypeIdx = ctx.nativeStrTypeIdx; const strDataTypeIdx = ctx.nativeStrDataTypeIdx; const bufRef: ValType = {kind:"ref_null",typeIdx:strDataTypeIdx}; const f64: ValType = {kind:"f64"}; const i32: ValType = {kind:"i32"}; const anyStrRef: ValType = {kind:"ref",typeIdx:ctx.anyStrTypeIdx};';
  let restored = kernels.slice(0, prologueEnd) + originalTypes + "\n" + kernels.slice(firstComment);
  for (const [role, name, params, results] of [
    ["New", "__nfd_new", "[f64]", "[bufRef]"],
    ["Get", "__nfd_get", "[bufRef, f64]", "[f64]"],
    ["Set", "__nfd_set", "[bufRef, f64, f64]", "[]"],
    ["Trap", "__num_fmt_trap", "[]", "[]"],
    ["Fin", "__nfd_fin", "[bufRef, f64]", "[anyStrRef]"],
  ] as const) {
    const builder = functionSource(runtime, "buildNumberFormat" + role + "Body");
    const returnAt = builder.indexOf(role === "Fin" ? "  const L_BUF" : "return {");
    const expectedPrefix =
      role === "Fin"
        ? 'export function buildNumberFormatFinBody(types: NumberFormatStringTypes): NativeNumberFormatBody { const strTypeIdx = types.nativeStringTypeIdx; const strDataTypeIdx = types.dataTypeIdx; const i32: ValType = {kind: "i32"};'
        : `export function buildNumberFormat${role}Body(${role === "Trap" ? "" : "types: NumberFormatStringTypes"}): NativeNumberFormatBody {`;
    expect(tokens(builder.slice(0, returnAt))).toEqual(tokens(expectedPrefix));
    const locals = returnedField(builder, "locals");
    const body = returnedField(builder, "body").replaceAll("types.dataTypeIdx", "strDataTypeIdx");
    let localConstants = "";
    if (role === "Fin") {
      localConstants = builder.slice(builder.indexOf("  const L_BUF"), builder.indexOf("  return {"));
      if (!localConstants.startsWith("  const L_BUF")) throw new Error("missing fin locals");
    }
    const comma = role === "Get" || role === "Set" || role === "Fin" ? "," : "";
    const call = `emit("${name}", signatures.${role.toLowerCase()}, buildNumberFormat${role}Body(${role === "Trap" ? "" : "types"}));`;
    restored = replaceOnce(
      restored,
      call,
      `${localConstants}emitFunc(ctx, "${name}", ${params}, ${results}, ${locals}, ${body}${comma});`,
    );
  }
  result = replaceOnce(result, kernels, restored);
  const thunk = functionSource(result, "emitSelfHostedToStringRadix");
  const at = thunk.indexOf("  const signature =");
  if (at < 0) throw new Error("missing thunk signature");
  expect(tokens(thunk.slice(at, -1))).toEqual(
    tokens(
      'const signature = numberFormatSignatures<ValType>({data:{kind:"ref",typeIdx:ctx.nativeStrDataTypeIdx},nullableData:{kind:"ref_null",typeIdx:ctx.nativeStrDataTypeIdx},anyString:{kind:"ref",typeIdx:ctx.anyStrTypeIdx},}).radixThunk; const built = buildNumberFormatRadixThunkBody(shIdx); emitFunc(ctx, "number_toString_radix", signature.params, signature.results, built.locals, built.body);',
    ),
  );
  const builder = functionSource(runtime, "buildNumberFormatRadixThunkBody");
  expect(tokens(builder.slice(0, builder.indexOf("return {")))).toEqual(
    tokens("export function buildNumberFormatRadixThunkBody(radixBody: FuncHandle): NativeNumberFormatBody {"),
  );
  const body = returnedField(builder, "body").replaceAll("radixBody", "shIdx");
  const locals = returnedField(builder, "locals");
  const restoredThunk =
    thunk.slice(0, at) +
    `const f64: ValType = {kind:"f64"}; emitFunc(ctx, "number_toString_radix", [f64,f64], [{kind:"externref"}], ${locals}, ${body},); }`;
  return replaceOnce(result, thunk, restoredThunk);
}

describe("whole selfhost kernel inverse", () => {
  it("reconstructs every retained donor statement and actual kernel body", () => {
    const adapter = read("src/codegen/number-format-selfhost.ts");
    const runtime = read("src/runtime/wasmgc/values/number-format-radix-bodies.ts");
    const actual = inverseSelfhost(adapter, runtime);
    expect(tokens(actual)).toEqual(tokens(donor.files[1]!.source));
    for (const mutated of [
      runtime.replace('op: "array.get_u"', 'op: "array.get_s"'),
      runtime.replace("const L_I = 4", "const L_I = 5"),
      runtime.replace('op: "i32.trunc_sat_f64_s"', 'op: "i32.trunc_f64_s"'),
    ]) {
      expect(mutated).not.toBe(runtime);
      const candidate = inverseSelfhost(adapter, mutated);
      expect(() => expect(tokens(candidate)).toEqual(tokens(donor.files[1]!.source))).toThrow();
    }
  });
});

describe("retained real legacy formatter callers", () => {
  it.each(["0", "1"])("retains cold/cache-hit and partial-family order with integer switch %s", (switchValue) => {
    vi.stubEnv("JS2WASM_NUMBER_TO_STRING_INTEGER_FASTPATH", switchValue);
    try {
      const checker = ts.createProgram([], {}).getTypeChecker();
      const ctx = createCodegenContext(createEmptyModule(), checker, { standalone: true });
      const before = createCodegenContext(createEmptyModule(), checker, { standalone: true });
      const original = originalFormatterEmitters();
      const compare = () => {
        expect(ctx.mod).toEqual(before.mod);
        expect([...ctx.funcMap]).toEqual([...before.funcMap]);
        expect([...ctx.arrayTypeMap]).toEqual([...before.arrayTypeMap]);
        expect([...ctx.funcTypeCache]).toEqual([...before.funcTypeCache]);
      };
      original.emitNativeNumberFormat(before, new Set(["number_toString"]));
      emitNativeNumberFormat(ctx, new Set(["number_toString"]));
      compare();
      const functions = [...ctx.mod.functions];
      const types = [...ctx.mod.types];
      const globals = [...ctx.mod.globals];
      const names = [...ctx.funcMap];
      expect(ctx.funcMap.has("number_toString")).toBe(true);
      expect(ctx.funcMap.has("number_toString_radix")).toBe(true);
      expect(ctx.funcMap.has("number_toFixed")).toBe(false);
      emitNativeNumberFormat(ctx, new Set(["number_toString"]));
      original.emitNativeNumberFormat(before, new Set(["number_toString"]));
      compare();
      expect(ctx.mod.functions).toEqual(functions);
      expect(ctx.mod.types).toEqual(types);
      expect(ctx.mod.globals).toEqual(globals);
      expect([...ctx.funcMap]).toEqual(names);
      functions.forEach((fn, index) => expect(ctx.mod.functions[index]).toBe(fn));
      emitNativeNumberFormat(ctx, new Set(["number_toPrecision"]));
      original.emitNativeNumberFormat(before, new Set(["number_toPrecision"]));
      compare();
      expect(ctx.funcMap.has("number_toFixed")).toBe(true);
      expect(ctx.funcMap.has("number_toExponential")).toBe(true);
      expect(ctx.funcMap.has("number_toPrecision")).toBe(true);
      functions.forEach((fn, index) => expect(ctx.mod.functions[index]).toBe(fn));
      for (const [name, handle] of names) expect(ctx.funcMap.get(name)).toBe(handle);
      expect(ensureIrNativeNumberToString(ctx, true)).toBe(ctx.funcMap.get("number_toString"));
      const native = ensureIrNativeNumberToString(ctx);
      expect(original.ensureIrNativeNumberToString(before)).toBe(native);
      compare();
      expect(native).not.toBeNull();
      expect(ensureIrNativeNumberToString(ctx)).toBe(native);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

function originalFormatterEmitters(): {
  emitNativeNumberFormat: typeof emitNativeNumberFormat;
  ensureIrNativeNumberToString: typeof ensureIrNativeNumberToString;
} {
  const dependencies = new Map<string, unknown>([
    ["./registry/types.js", registryTypes],
    ["./func-space.js", functionSpace],
    ["./native-strings.js", nativeStrings],
    ["./number-ryu.js", currentRyu],
    ["./shared.js", shared],
    ["../ir/nodes.js", nodes],
    ["./stdlib-selfhost.js", selfhost],
    ["../stdlib/number-format.js", definition],
  ]);
  const evaluate = (index: number) => {
    const receipt = donor.files[index]!;
    expect(hash(receipt.source)).toBe(receipts[index]![1]);
    const code = ts.transpileModule(receipt.source, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const exports = {};
    new Function("require", "exports", code)((path: string) => {
      if (!dependencies.has(path)) throw new Error("unexpected donor dependency " + path);
      return dependencies.get(path);
    }, exports);
    return exports;
  };
  dependencies.set("./number-format-selfhost.js", evaluate(1));
  return evaluate(0) as ReturnType<typeof originalFormatterEmitters>;
}

describe("complete canonical module envelope", () => {
  it.each(["format", "radix"] as const)("rejects unaccounted prefix/suffix/statements in %s", (family) => {
    const source = read(`src/runtime/wasmgc/values/number-format${family === "radix" ? "-radix" : ""}-bodies.ts`);
    expect(() => authenticateEnvelope(source, family)).not.toThrow();
    const parsed = ts.createSourceFile("original.ts", source, ts.ScriptTarget.Latest, true);
    const first = parsed.statements[2]!,
      second = parsed.statements[3]!;
    const reordered =
      source.slice(0, first.getStart(parsed)) +
      second.getText(parsed) +
      "\n" +
      first.getText(parsed) +
      source.slice(second.end);
    for (const changed of [
      source.replace("import type", "import"),
      'import "unapproved";\n' + source,
      source + "\nconst extra = sideEffect();\n",
      source + '\nthrow new Error("suffix");\n',
      reordered,
    ]) {
      expect(changed).not.toBe(source);
      expect(() => authenticateEnvelope(changed, family)).toThrow();
    }
    const builderName = family === "format" ? "buildNumberFormatFinalizeBody" : "buildNumberFormatNewBody";
    const builder = functionSource(source, builderName);
    expect(returnedField(builder, "locals")).toBeDefined();
    const suffix = builder.slice(0, -1) + 'throw new Error("after return"); }';
    expect(() => returnedField(suffix, "locals")).toThrow(/return boundary/);
  });
});

/** Invert only the approved parameter extraction and private normalization split. */
function formatterConstruction(runtime: string, name: "ToString" | "ToFixed" | "ToExponential" | "ToPrecision") {
  const source = functionSource(runtime, "buildNumberFormat" + name + "Body");
  const start =
    name === "ToPrecision" ? "  // We reduce toPrecision" : name === "ToExponential" ? "  // params 0" : "  // params:";
  const startAt = source.indexOf(start);
  const endAt = source.lastIndexOf("\n  return {");
  if (startAt < 0 || endAt <= startAt) throw new Error("changed canonical construction boundaries");
  const extraFields =
    name === "ToString"
      ? "readonly radix: FuncHandle; readonly ryuToBuffer: FuncHandle; readonly integerBeforeScratch: boolean;"
      : name === "ToFixed"
        ? "readonly toString?: FuncHandle;"
        : name === "ToPrecision"
          ? "readonly toFixed?: FuncHandle; readonly toExponential?: FuncHandle; readonly toString?: FuncHandle;"
          : "";
  const extraLocals =
    name === "ToString" ? "const radixIdx = resources.radix; const ryuToBufIdx = resources.ryuToBuffer;" : "";
  expect(tokens(source.slice(0, startAt))).toEqual(
    tokens(
      `export function buildNumberFormat${name}Body(resources: { readonly types: NumberFormatStringTypes; readonly finalize: FuncHandle; ${extraFields} }): NativeNumberFormatBody { const strDataTypeIdx = resources.types.dataTypeIdx; const finalizeIdx = resources.finalize; const i32: ValType = {kind:"i32"}; const f64: ValType = {kind:"f64"}; const bufType: ValType = {kind:"ref",typeIdx:strDataTypeIdx}; ${extraLocals}`,
    ),
  );
  let construction = source.slice(startAt, endAt);
  construction = construction.replaceAll("emitNonFinitePrologue(", "emitNonFinitePrologue(ctx, ");
  if (name === "ToString")
    construction = replaceOnce(
      construction,
      "resources.integerBeforeScratch",
      'process.env.JS2WASM_NUMBER_TO_STRING_INTEGER_FASTPATH !== "0"',
    );
  if (name === "ToFixed")
    construction = replaceOnce(construction, "resources.toString", 'ctx.funcMap.get("number_toString")');
  if (name === "ToPrecision") {
    construction = replaceOnce(construction, "resources.toFixed", 'ctx.funcMap.get("number_toFixed")');
    construction = replaceOnce(construction, "resources.toExponential", 'ctx.funcMap.get("number_toExponential")');
    construction = replaceOnce(construction, "resources.toString", 'ctx.funcMap.get("number_toString")');
  }
  if (name === "ToExponential") {
    const helper = functionSource(runtime, "buildExponentialNormalization");
    const header = "function buildExponentialNormalization(L_MANT: number, L_EXP: number): Instr[] {\n  return [\n";
    if (!helper.startsWith(header) || !helper.endsWith("\n  ];\n}"))
      throw new Error("changed private normalization header/return");
    const fragment = helper.slice(header.length, -"\n  ];\n}".length);
    construction = replaceOnce(construction, "    ...buildExponentialNormalization(L_MANT, L_EXP),", fragment);
  }
  return construction;
}

describe("live formatter construction inverse", () => {
  it("pins the complete signature factory including reference positions and scalar initializers", () => {
    const source = read("src/runtime/wasmgc/values/number-format-bodies.ts");
    expect(tokens(functionSource(source, "numberFormatSignatures"))).toEqual(
      tokens(`
      export function numberFormatSignatures<R>(refs: { readonly data: R; readonly nullableData: R; readonly anyString: R }) {
        const f64 = {kind:"f64"} as const; const i32 = {kind:"i32"} as const; const extern = {kind:"externref"} as const;
        return {
          finalize: {params:[refs.data,i32],results:[extern]},
          new: {params:[f64],results:[refs.nullableData]},
          get: {params:[refs.nullableData,f64],results:[f64]},
          set: {params:[refs.nullableData,f64,f64],results:[]},
          trap: {params:[],results:[]},
          fin: {params:[refs.nullableData,f64],results:[refs.anyString]},
          radixBody: {params:[f64,f64],results:[refs.anyString]},
          radixThunk: {params:[f64,f64],results:[extern]},
          toString: {params:[f64],results:[extern]},
          nativeToString: {params:[f64],results:[refs.anyString]},
          withDigits: {params:[f64,f64],results:[extern]},
        };
      }
    `),
    );
  });
  for (const name of ["ToString", "ToFixed", "ToExponential", "ToPrecision"] as const) {
    it(`retains complete ${name} instruction construction including private blocks`, () => {
      const runtime = read("src/runtime/wasmgc/values/number-format-bodies.ts");
      const original = functionSource(donor.files[0]!.source, "emit" + name);
      const start =
        name === "ToPrecision"
          ? "  // We reduce toPrecision"
          : name === "ToExponential"
            ? "  // params 0"
            : "  // params:";
      const expected = original.slice(original.indexOf(start), original.indexOf("\n  const typeIdx = addFuncType"));
      const actual = formatterConstruction(runtime, name);
      expect(tokens(actual)).toEqual(tokens(expected));
      const changed = runtime.replace('{ op: "f64.const", value: MAX_SAFE_INTEGER }', '{ op: "f64.const", value: 0 }');
      if (name === "ToString") {
        expect(changed).not.toBe(runtime);
        const countermodel = formatterConstruction(changed, name);
        expect(() => expect(tokens(countermodel)).toEqual(tokens(expected))).toThrow();
      }
      if (name === "ToExponential") {
        const changed = runtime.replace(
          "    ...buildExponentialNormalization(L_MANT, L_EXP),",
          "    ...buildExponentialNormalization(L_EXP, L_MANT),",
        );
        expect(changed).not.toBe(runtime);
        expect(() => formatterConstruction(changed, name)).toThrow(/inverse span/);
      }
    });
  }
});
