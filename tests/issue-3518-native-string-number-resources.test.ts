// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { setImmediate } from "node:timers/promises";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { sourcePacket, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { deriveNativeValueResourcePlan } from "../src/ir/program/native-value-resources.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeStringFlattenResources,
  fillNativeStringFlattenResources,
} from "../src/backend/wasmgc/resources/native-string-flatten.js";
import {
  reserveNativeStringNumberResources,
  fillNativeStringNumberResources,
  requireNativeStringNumberReservations,
  requireCompletedNativeStringNumber,
} from "../src/backend/wasmgc/resources/native-string-number.js";
import * as grammar from "../src/runtime/wasmgc/values/string-number-grammar.js";
import * as scaling from "../src/runtime/wasmgc/values/decimal-scale-bodies.js";
import * as scanner from "../src/runtime/wasmgc/values/string-number-bodies.js";
import {
  scannerDonorSource,
  scannerCases,
  scannerSemanticDebtCases,
  scannerExponentRepairCases,
  executeScannerResourceFixture,
} from "./fixtures/issue-3518-native-string-number-donor.js";

afterEach(async () => {
  await setImmediate();
});
const root = resolve(import.meta.dirname, "..");
function scratch(prefix: string): string {
  mkdirSync(resolve(root, ".tmp"), { recursive: true });
  return mkdtempSync(resolve(root, ".tmp", prefix));
}
const paths = {
  adapter: "src/codegen/parse-number-native.ts",
  grammar: "src/runtime/wasmgc/values/string-number-grammar.ts",
  scaling: "src/runtime/wasmgc/values/decimal-scale-bodies.ts",
  scanner: "src/runtime/wasmgc/values/string-number-bodies.ts",
  owner: "src/backend/wasmgc/resources/native-string-number.ts",
} as const;
type Sources = Record<keyof typeof paths, string>;
const readSources = (): Sources =>
  Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, readFileSync(resolve(root, p), "utf8")])) as Sources;
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
function parsed(text: string) {
  const file = ts.createSourceFile("receipt.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((file as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length)
    throw Error("invalid source receipt");
  return file;
}
function fn(text: string, name: string): ts.FunctionDeclaration {
  const matches = parsed(text).statements.filter(
    (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name,
  );
  if (matches.length !== 1 || !matches[0]!.body) throw Error("missing/duplicate function " + name);
  return matches[0]!;
}
function syntax(text: string): string {
  // Returned descriptor fragments are expressions, not labelled blocks.
  // Use an explicit wrapper rather than permitting parser recovery to omit
  // unexpected tokens from a malformed receipt.
  if (/^\s*\{\s*(kind|arrayTypeIndex|op|name)\s*:/.test(text)) text = "(" + text + ")";
  const file = parsed(text);
  const comments = new Map<number, string>();
  function tree(n: ts.Node): unknown {
    for (const r of [
      ...(ts.getLeadingCommentRanges(text, n.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, n.end) ?? []),
    ])
      comments.set(
        r.pos,
        text
          .slice(r.pos, r.end)
          .split("\n")
          .map((line) => line.trim())
          .join("\n"),
      );
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return null;
    const children = n.getChildren(file);
    const results = children.map(tree);
    return [
      n.kind,
      children.length
        ? results.filter(
            (_, i) =>
              ![ts.SyntaxKind.SemicolonToken, ts.SyntaxKind.CommaToken, ts.SyntaxKind.EndOfFileToken].includes(
                children[i]!.kind,
              ),
          )
        : n.getText(file),
    ];
  }
  const ast = tree(file);
  return JSON.stringify([ast, [...comments].sort((a, b) => a[0] - b[0]).map(([, v]) => v)]);
}
function same(a: string, b: string, label: string): void {
  if (syntax(a) !== syntax(b)) throw Error("donor receipt: " + label);
}
function once(text: string, before: string, after: string): string {
  const at = text.indexOf(before);
  if (at < 0 || text.indexOf(before, at + before.length) >= 0)
    throw Error("missing/duplicate mapped source: " + before);
  return text.slice(0, at) + after + text.slice(at + before.length);
}
function functionText(text: string, name: string): string {
  return fn(text, name)
    .getFullText()
    .replace(/\bexport\s+(?=function)/, "");
}
function returned(text: string, name: string): ts.Expression {
  const returns = fn(text, name).body!.statements.filter(ts.isReturnStatement);
  if (returns.length !== 1 || !returns[0]!.expression) throw Error("not one return: " + name);
  return returns[0]!.expression!;
}
function arrayInside(node: ts.Expression): string {
  if (!ts.isArrayLiteralExpression(node)) throw Error("not a literal array");
  return node.getText().slice(1, -1);
}
function variables(text: string): ts.VariableStatement[] {
  return parsed(text).statements.filter(ts.isVariableStatement);
}
function varName(node: ts.VariableStatement): string {
  return node.declarationList.declarations[0]!.name.getText();
}
function header(text: string, name: string, expected: string): void {
  const n = fn(text, name);
  same(text.slice(n.getStart(), n.body!.getStart()) + "{}", expected + "{}", "header " + name);
}
const sharedNames = [
  "isWsBody",
  "emitInfinityExact",
  "emitRadixPrefixParse",
  "emitInfinityCheck",
  "emitExponent",
  "emitDigitValue",
] as const;
function verifyDeclarations(s: Sources): void {
  const donor = scannerDonorSource();
  expect(parsed(donor).statements.filter(ts.isFunctionDeclaration)).toHaveLength(13);
  expect(variables(donor)).toHaveLength(34);
  for (const name of ["externToFlat", "emitNativeParseNumber", "emitParseInt"])
    same(functionText(s.adapter, name), functionText(donor, name), name);
  for (const name of sharedNames) same(functionText(s.grammar, name), functionText(donor, name), name);
  same(functionText(s.scaling, "emitApplyExpResult"), functionText(donor, "emitApplyExpResult"), "beyond-table tail");
  const liveConstants = [
    ...variables(s.grammar),
    ...variables(s.scaling).filter((v) => varName(v) === "POW10_TABLE_MAX"),
  ];
  expect(liveConstants).toHaveLength(34);
  for (const old of variables(donor)) {
    const live = liveConstants.filter((v) => varName(v) === varName(old));
    if (live.length !== 1) throw Error("constant census " + varName(old));
    same(live[0]!.getFullText().replace(/\bexport\s+(?=const)/, ""), old.getFullText(), "constant " + varName(old));
  }
  const oldInit = parsed(donor)
    .statements.filter(ts.isExpressionStatement)
    .map((n) => n.getText());
  const newInit = parsed(s.adapter)
    .statements.filter(ts.isExpressionStatement)
    .map((n) => n.getText());
  expect(newInit).toEqual(oldInit);
  const leading = (text: string, name: string) => {
    const node = fn(text, name);
    return text.slice(node.getFullStart(), node.getStart());
  };
  for (const name of ["ensurePow10TableGlobal", "emitStrToNumber", "emitApplyDecimalExp"])
    same(leading(s.adapter, name), leading(donor, name), "retained documentation " + name);
  same(
    leading(s.scaling, "buildApplyDecimalExp"),
    leading(donor, "emitApplyDecimalExp"),
    "canonical scaling documentation",
  );
  same(
    s.adapter.slice(0, parsed(s.adapter).statements[0]!.getStart()),
    donor.slice(0, parsed(donor).statements[0]!.getStart()),
    "module documentation",
  );
}
function verifyScale(s: Sources): void {
  const donor = scannerDonorSource(),
    old = fn(donor, "emitApplyDecimalExp");
  header(
    s.scaling,
    "buildApplyDecimalExp",
    "export function buildApplyDecimalExp(powerResources: DecimalPowerResources, L_SIGN:number,L_MANT:number,L_FRACCOUNT:number,L_INTDROP:number,L_EXP:number,L_EXPSIGN:number,L_TEXP:number,L_POW:number,L_RESULT:number): Instr[]",
  );
  const expected = old
    .body!.getText()
    .replace(
      "const pow10GlobalIdx = ensurePow10TableGlobal(ctx);",
      "const pow10GlobalIdx = powerResources.globalIndex;",
    )
    .replace(
      "const pow10ArrTypeIdx = ctx.pow10ArrTypeIdx as number;",
      "const pow10ArrTypeIdx = powerResources.arrayTypeIndex;",
    );
  same(fn(s.scaling, "buildApplyDecimalExp").body!.getText(), expected, "complete scaling body");
  same(
    fn(s.adapter, "emitApplyDecimalExp").body!.getText(),
    `{
    const pow10GlobalIdx = ensurePow10TableGlobal(ctx);
    const pow10ArrTypeIdx = ctx.pow10ArrTypeIdx as number;
    return buildApplyDecimalExp({arrayTypeIndex:pow10ArrTypeIdx,globalIndex:pow10GlobalIdx},L_SIGN,L_MANT,L_FRACCOUNT,L_INTDROP,L_EXP,L_EXPSIGN,L_TEXP,L_POW,L_RESULT);
  }`,
    "scaling adapter",
  );
  same(
    s.adapter.slice(
      fn(s.adapter, "emitApplyDecimalExp").getStart(),
      fn(s.adapter, "emitApplyDecimalExp").body!.getStart(),
    ) + "{}",
    donor.slice(old.getStart(), old.body!.getStart()) + "{}",
    "retained scaling signature",
  );
  const table = fn(donor, "ensurePow10TableGlobal").body!.getText();
  const descriptor = '{ kind: "array", name: "Pow10TableF64", element: { kind: "f64" }, mutable: false }';
  header(s.scaling, "buildDecimalPowerArrayType", "export function buildDecimalPowerArrayType(): ArrayTypeDef");
  same(returned(s.scaling, "buildDecimalPowerArrayType").getText(), descriptor, "immutable table descriptor");
  same(
    fn(s.scaling, "buildDecimalPowerArrayInitializer").body!.getText(),
    `{
    const init: Instr[] = [];
    for(let k=0;k<=POW10_TABLE_MAX;k++) init.push({op:"f64.const",value:Number(\`1e\${k}\`)});
    init.push({op:"array.new_fixed",typeIdx:arrTypeIdx,length:POW10_TABLE_MAX+1});
    return init;
  }`,
    "complete table initializer",
  );
  let liveTable = fn(s.adapter, "ensurePow10TableGlobal").body!.getText();
  // The donor asserted the inline literal's type. The canonical builder owns
  // that exact return contract now; reconstruct this one assertion rather
  // than stripping assertions from either historical or current receipts.
  liveTable = once(
    liveTable,
    "buildDecimalPowerArrayType()",
    returned(s.scaling, "buildDecimalPowerArrayType").getText() + " as ArrayTypeDef",
  );
  liveTable = once(
    liveTable,
    "const init = buildDecimalPowerArrayInitializer(arrTypeIdx);",
    fn(s.scaling, "buildDecimalPowerArrayInitializer")
      .body!.statements.slice(0, -1)
      .map((n) => n.getFullText())
      .join(""),
  );
  same(liveTable, table, "lazy table and cache ordering");
}

const authorizedExponentRepair =
  '    // StringToNumber requires exponent digits, unlike parseFloat\'s prefix grammar.\n    // Read the last consumed character: L_C may instead hold unconsumed lookahead.\n    // The mantissa\'s no-digit rejection guarantees L_I - 1 is a valid index.\n    { op: "local.get", index: L_DATA },\n    { op: "local.get", index: L_I },\n    { op: "i32.const", value: 1 },\n    { op: "i32.sub" },\n    { op: "array.get_u", typeIdx: strDataTypeIdx },\n    { op: "local.set", index: L_C },\n    { op: "local.get", index: L_C },\n    { op: "i32.const", value: C_LC_E },\n    { op: "i32.eq" },\n    { op: "local.get", index: L_C },\n    { op: "i32.const", value: C_UC_E },\n    { op: "i32.eq" },\n    { op: "i32.or" },\n    { op: "local.get", index: L_C },\n    { op: "i32.const", value: C_PLUS },\n    { op: "i32.eq" },\n    { op: "i32.or" },\n    { op: "local.get", index: L_C },\n    { op: "i32.const", value: C_MINUS },\n    { op: "i32.eq" },\n    { op: "i32.or" },\n    {\n      op: "if",\n      blockType: { kind: "empty" },\n      then: [{ op: "f64.const", value: NaN }, { op: "return" }],\n    },\n';
const exponentCall = "...emitExponent(L_I, L_END, L_DATA, L_C, L_EXP, L_EXPSIGN, strDataTypeIdx, getC)";
const fullMatchSource = `[
  // full-match requirement: if i != end → NaN (trailing junk)
  {op:"local.get",index:L_I},{op:"local.get",index:L_END},{op:"i32.ne"},
  {op:"if",blockType:{kind:"empty"},then:[{op:"f64.const",value:NaN},{op:"return"}]},
]`;
function exponentRepairLocation(text: string) {
  const body = returned(text, "buildStringToNumberPrelude");
  if (!ts.isArrayLiteralExpression(body)) throw Error("authorized exponent repair: non-array prelude");
  const sites = body.elements
    .map((node, index) => ({ node, index }))
    .filter(
      ({ node }) =>
        ts.isSpreadElement(node) &&
        ts.isCallExpression(node.expression) &&
        node.expression.expression.getText() === "emitExponent",
    );
  if (sites.length !== 1) throw Error("authorized exponent repair: exponent site census");
  const { node, index } = sites[0]!;
  same("[" + node.getText() + "]", "[" + exponentCall + "]", "authorized exponent repair: exact exponent call");
  const first = body.elements[index + 1],
    last = body.elements[index + 22],
    following = body.elements[index + 23];
  if (!first || !last || !following) throw Error("authorized exponent repair: missing span");
  const begin = first.getFullStart(),
    end = following.getFullStart();
  same(
    "[" + text.slice(begin, end) + "]",
    "[" + authorizedExponentRepair + "]",
    "authorized exponent repair: exact span/location",
  );
  same(
    "[" +
      body.elements
        .slice(index + 23, index + 27)
        .map((n) => n.getFullText())
        .join(",") +
      "]",
    fullMatchSource,
    "authorized exponent repair: adjacent full match",
  );
  return { begin, end, exponentStart: node.getFullStart() };
}
function stripAuthorizedExponentRepair(text: string): string {
  const { begin, end } = exponentRepairLocation(text);
  const rows = parsed(text).statements.filter(
    (n): n is ts.ImportDeclaration =>
      ts.isImportDeclaration(n) &&
      ts.isStringLiteral(n.moduleSpecifier) &&
      n.moduleSpecifier.text === "./string-number-grammar.js",
  );
  if (rows.length !== 1) throw Error("authorized exponent repair: grammar import census");
  const row = rows[0]!,
    clause = row.importClause;
  if (
    !clause ||
    clause.isTypeOnly ||
    clause.name ||
    !clause.namedBindings ||
    !ts.isNamedImports(clause.namedBindings) ||
    row.attributes
  )
    throw Error("authorized exponent repair: value import shape");
  const names = [
    "C_MINUS",
    "C_PLUS",
    "C_ZERO",
    "C_NINE",
    "C_DOT",
    "C_LC_E",
    "C_UC_E",
    "isWsBody",
    "emitInfinityExact",
    "emitRadixPrefixParse",
    "emitExponent",
  ];
  const elements = clause.namedBindings.elements;
  if (
    JSON.stringify(elements.map((n) => n.name.text)) !== JSON.stringify(names) ||
    elements.some((n) => n.isTypeOnly || n.propertyName)
  )
    throw Error("authorized exponent repair: exact value bindings");
  const edits = [
    { begin, end },
    ...elements
      .filter((n) => n.name.text === "C_LC_E" || n.name.text === "C_UC_E")
      .map((n) => {
        if (text[n.end] !== ",") throw Error("authorized exponent repair: import delimiter");
        return { begin: n.getFullStart(), end: n.end + 1 };
      }),
  ];
  for (const edit of edits.sort((a, b) => b.begin - a.begin)) text = text.slice(0, edit.begin) + text.slice(edit.end);
  return text;
}
function verifyScanner(s: Sources): void {
  const donor = scannerDonorSource(),
    old = fn(donor, "emitStrToNumber");
  const localDecls = old.body!.statements.filter(
    (n): n is ts.VariableStatement => ts.isVariableStatement(n) && varName(n).startsWith("L_"),
  );
  const canonical = variables(s.scanner).filter((n) => varName(n).startsWith("L_"));
  expect(canonical).toHaveLength(19);
  expect(fn(s.scanner, "buildStringToNumberPrelude").body!.statements).toHaveLength(5);
  expect(fn(s.scanner, "buildStringToNumberLocals").body!.statements).toHaveLength(5);
  expect(fn(s.scanner, "buildStringToNumberResult").body!.statements).toHaveLength(1);
  expect(fn(s.scanner, "buildDecimalMantissa").body!.statements).toHaveLength(1);
  same(
    fn(s.scanner, "buildStringToNumberPrelude")
      .body!.statements.slice(0, 2)
      .map((n) => n.getFullText())
      .join(""),
    "const strTypeIdx = layout.nativeStrTypeIdx; const strDataTypeIdx = layout.nativeStrDataTypeIdx;",
    "prelude layout aliases",
  );
  same(
    fn(s.scanner, "buildStringToNumberLocals")
      .body!.statements.slice(0, 4)
      .map((n) => n.getFullText())
      .join(""),
    'const strTypeIdx = layout.nativeStrTypeIdx; const strDataTypeIdx = layout.nativeStrDataTypeIdx; const i32:ValType={kind:"i32"}; const f64:ValType={kind:"f64"};',
    "locals layout/type aliases",
  );
  same(
    canonical.map((n) => n.getFullText()).join(""),
    localDecls.map((n) => n.getFullText()).join(""),
    "all scanner local indices/docs",
  );
  const oldBody = old.body!.statements.find(
    (n): n is ts.VariableStatement => ts.isVariableStatement(n) && varName(n) === "body",
  )!.declarationList.declarations[0]!.initializer!;
  let prelude = arrayInside(returned(s.scanner, "buildStringToNumberPrelude"));
  prelude = once(
    prelude,
    "...buildDecimalMantissa(strDataTypeIdx, getC),",
    arrayInside(returned(s.scanner, "buildDecimalMantissa")),
  );
  let result = arrayInside(returned(s.scanner, "buildStringToNumberResult"));
  result = once(result, "buildApplyDecimalExp(", "emitApplyDecimalExp(");
  result = once(result, "powerResources,", "ctx,");
  same(
    "[" + prelude + result + "]",
    oldBody
      .getText()
      .replace("ctx.anyStrTypeIdx", "layout.anyStrTypeIdx")
      .replace("funcIdx: flattenIdx", "funcIdx: flattenHandle"),
    "complete reconstructed scanner body",
  );
  for (const name of ["getC", "getCharAt"]) {
    const original = old.body!.statements.find(
      (n): n is ts.VariableStatement => ts.isVariableStatement(n) && varName(n) === name,
    )!;
    const current = fn(s.scanner, "buildStringToNumberPrelude").body!.statements.find(
      (n): n is ts.VariableStatement => ts.isVariableStatement(n) && varName(n) === name,
    )!;
    same(current.getFullText(), original.getFullText(), "shared " + name);
  }
  const push = old.body!.statements.find(
    (n) =>
      ts.isExpressionStatement(n) &&
      ts.isCallExpression(n.expression) &&
      n.expression.expression.getText() === "pushDefinedFunc",
  ) as ts.ExpressionStatement;
  const def = (push.expression as ts.CallExpression).arguments[2] as ts.ObjectLiteralExpression;
  const locals = def.properties.find(
    (n) => ts.isPropertyAssignment(n) && n.name.getText() === "locals",
  ) as ts.PropertyAssignment;
  same(
    returned(s.scanner, "buildStringToNumberLocals").getText(),
    locals.initializer.getText(),
    "all locals including i64/fracScale",
  );
  header(
    s.scanner,
    "buildStringToNumberPrelude",
    "export function buildStringToNumberPrelude(layout:NativeStringLayout,flattenHandle:FuncHandle):Instr[]",
  );
  header(
    s.scanner,
    "buildStringToNumberResult",
    "export function buildStringToNumberResult(powerResources:DecimalPowerResources):Instr[]",
  );
  header(
    s.scanner,
    "buildStringToNumberLocals",
    "export function buildStringToNumberLocals(layout:NativeStringLayout):LocalDef[]",
  );
  header(
    s.scanner,
    "buildDecimalMantissa",
    "function buildDecimalMantissa(strDataTypeIdx:number,getC:Instr[]):Instr[]",
  );
  // Real adapter invocation below separately pins these bindings/allocation order.
  same(
    fn(s.adapter, "emitStrToNumber")
      .body!.statements.slice(0, 6)
      .map((n) => n.getFullText())
      .join(""),
    old
      .body!.statements.slice(0, 6)
      .map((n) => n.getFullText())
      .join(""),
    "register scanner before any body construction",
  );
}
function verifyImports(s: Sources): void {
  const targets = new Map([
    [
      "../runtime/wasmgc/values/decimal-scale-bodies.js",
      ["buildDecimalPowerArrayType", "buildDecimalPowerArrayInitializer", "buildApplyDecimalExp"],
    ],
    [
      "../runtime/wasmgc/values/string-number-bodies.js",
      ["buildStringToNumberPrelude", "buildStringToNumberResult", "buildStringToNumberLocals"],
    ],
    [
      "../runtime/wasmgc/values/string-number-grammar.js",
      [
        ...Object.keys(grammar).filter((n) => n.startsWith("C_")),
        "isWsBody",
        "emitInfinityCheck",
        "emitExponent",
        "emitDigitValue",
      ],
    ],
  ]);
  for (const [target, names] of targets) {
    const matches = parsed(s.adapter).statements.filter(
      (n): n is ts.ImportDeclaration =>
        ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === target,
    );
    if (matches.length !== 1) throw Error("missing/duplicate import " + target);
    const clause = matches[0]!.importClause;
    if (
      !clause ||
      clause.isTypeOnly ||
      clause.name ||
      !clause.namedBindings ||
      !ts.isNamedImports(clause.namedBindings) ||
      matches[0]!.attributes
    )
      throw Error("nonvalue adapter import");
    const actual = clause.namedBindings.elements;
    if (
      actual.some((n) => n.isTypeOnly || n.propertyName) ||
      JSON.stringify(actual.map((n) => n.name.text).sort()) !== JSON.stringify([...names].sort())
    )
      throw Error("altered import binding");
  }
}
function verifySources(s: Sources): void {
  s = { ...s, scanner: stripAuthorizedExponentRepair(s.scanner) };
  verifyDeclarations(s);
  verifyScale(s);
  verifyScanner(s);
  verifyImports(s);
  verifyCanonicalEdges(s);
}

function verifyCanonicalEdges(s: Sources): void {
  const expected = {
    grammar: ["src/wasm/model/instructions.ts"],
    scaling: ["src/wasm/model/instructions.ts", "src/wasm/model/module-records.ts"],
    scanner: [
      "src/wasm/model/instructions.ts",
      "src/runtime/wasmgc/values/string-layouts.ts",
      paths.grammar,
      paths.scaling,
    ],
    owner: [
      "src/wasm/physical/module-reservations.ts",
      "src/backend/wasmgc/resources/native-string-literals.ts",
      "src/backend/wasmgc/resources/native-string-flatten.ts",
      "src/ir/program/native-value-resources.ts",
      "src/runtime/wasmgc/values/native-resource-declaration-types.ts",
      "src/backend/wasmgc/resources/native-resource-declarations.ts",
      paths.scaling,
      paths.scanner,
    ],
  };
  for (const owner of ["grammar", "scaling", "scanner", "owner"] as const) {
    const source = parsed(s[owner]);
    const imports = source.statements.filter(ts.isImportDeclaration).map((n) => {
      if (!ts.isStringLiteral(n.moduleSpecifier)) throw Error("nonliteral canonical import");
      return resolve(root, dirname(paths[owner]), n.moduleSpecifier.text.replace(/\.js$/, ".ts"));
    });
    if (JSON.stringify(imports.sort()) !== JSON.stringify(expected[owner].map((p) => resolve(root, p)).sort()))
      throw Error("canonical dependency census " + owner);
    function visit(n: ts.Node): void {
      if (
        ts.isImportTypeNode(n) ||
        (ts.isCallExpression(n) &&
          (n.expression.kind === ts.SyntaxKind.ImportKeyword || n.expression.getText() === "require"))
      )
        throw Error("unlisted canonical dependency");
      ts.forEachChild(n, visit);
    }
    visit(source);
  }
}

// Execute the ORIGINAL donor emitter against the same small recording seam as
// the live legacy adapter. These recording inputs are NOT compiler witnesses.
interface Recording {
  mod: { types: unknown[]; globals: unknown[]; functions: unknown[] };
  funcMap: Map<string, number>;
  [key: string]: unknown;
}
function adapterFactory(text: string, trace: string[], fault?: string) {
  const importRows = parsed(text).statements.filter(ts.isImportDeclaration);
  for (const row of [...importRows].reverse()) text = text.slice(0, row.getStart()) + text.slice(row.end);
  const providers: Record<string, Record<string, unknown>> = {
    "../runtime/wasmgc/values/string-number-grammar.js": grammar,
    "../runtime/wasmgc/values/decimal-scale-bodies.js": scaling,
    "../runtime/wasmgc/values/string-number-bodies.js": scanner,
    "./native-strings.js": {
      ensureNativeStringHelpers: () => {
        trace.push("ensure-strings");
      },
    },
    "./registry/types.js": {
      addFuncType: (ctx: Recording, params: unknown[], results: unknown[]) => {
        trace.push("signature:" + JSON.stringify([params, results]));
        return 17;
      },
    },
    "./func-space.js": {
      mintDefinedFunc: () => {
        trace.push("mint");
        return 99;
      },
      pushDefinedFunc: (ctx: Recording, handle: number, definition: unknown) => {
        trace.push("push:" + handle);
        if (fault === "push") throw Error("push sentinel");
        ctx.mod.functions.push(definition);
      },
    },
    "./registry/parse-number-delegates.js": {
      registerEmitNativeParseNumber: () => {
        trace.push("register-delegate");
      },
    },
  };
  // Inject only the source's explicit runtime imports. In particular the
  // historical source owns POW10_TABLE_MAX and all C_* declarations locally;
  // supplying them as Function parameters collides with those declarations.
  const values = new Map<string, unknown>();
  for (const row of importRows) {
    const clause = row.importClause;
    if (clause?.isTypeOnly) continue;
    if (
      !clause ||
      clause.name ||
      !clause.namedBindings ||
      !ts.isNamedImports(clause.namedBindings) ||
      row.attributes ||
      !ts.isStringLiteral(row.moduleSpecifier)
    )
      throw Error("unsupported recording import shape");
    for (const binding of clause.namedBindings.elements) {
      if (binding.isTypeOnly) continue;
      const provider = providers[row.moduleSpecifier.text];
      const importedName = binding.propertyName?.text ?? binding.name.text;
      if (!provider || !Object.hasOwn(provider, importedName))
        throw Error("unavailable recording import: " + row.moduleSpecifier.text + ":" + importedName);
      if (values.has(binding.name.text)) throw Error("duplicate recording import: " + binding.name.text);
      values.set(binding.name.text, provider[importedName]);
    }
  }
  const js = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} as { emitNativeParseNumber: (ctx: Recording, which: Set<string>) => void } };
  new Function("exports", ...values.keys(), js)(module.exports, ...values.values());
  return module.exports.emitNativeParseNumber;
}
function recordLegacy(text: string, which: readonly string[], imported = 0, fault?: string) {
  const trace: string[] = [],
    invoke = adapterFactory(text, trace, fault);
  const array = <T>(label: string) => {
    const a: T[] = [];
    a.push = (...items: T[]) => {
      trace.push(label);
      if (fault === label) throw Error(label + " sentinel");
      return Array.prototype.push.apply(a, items);
    };
    return a;
  };
  const ctx: Recording = {
    mod: { types: array("type"), globals: array("global"), functions: [] },
    funcMap: new Map(),
    nativeStrHelpers: new Map([["__str_flatten", 55]]),
    nativeStrTypeIdx: 2,
    nativeStrDataTypeIdx: 0,
    anyStrTypeIdx: 1,
    consStrTypeIdx: 3,
    hashedStrTypeIdx: 4,
    utf8StrDataTypeIdx: -1,
    utf8StrTypeIdx: -1,
    numImportGlobals: imported,
  };
  ctx.funcMap.set = (name, handle) => {
    trace.push("bind:" + name);
    return Map.prototype.set.call(ctx.funcMap, name, handle);
  };
  let error: string | null = null;
  try {
    invoke(ctx, new Set(which));
    invoke(ctx, new Set(which));
  } catch (e) {
    error = String(e);
  }
  return {
    trace,
    error,
    types: [...ctx.mod.types],
    globals: [...ctx.mod.globals],
    functions: ctx.mod.functions,
    bindings: [...ctx.funcMap],
    array: ctx.pow10ArrTypeIdx,
    global: ctx.pow10TableGlobalIdx,
  };
}

function projectedLegacyRecord(candidate: ReturnType<typeof recordLegacy>, original: ReturnType<typeof recordLegacy>) {
  const fullMatch = [
    { op: "local.get", index: 4 },
    { op: "local.get", index: 3 },
    { op: "i32.ne" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "f64.const", value: NaN }, { op: "return" }] },
  ];
  // Independent symbolic span → concrete indices of recordLegacy's fixed
  // recording context. This does not call a compiler or fabricate its output.
  const expectedSpan = new Function(
    "L_DATA",
    "L_I",
    "L_C",
    "strDataTypeIdx",
    "C_LC_E",
    "C_UC_E",
    "C_PLUS",
    "C_MINUS",
    "return [" + authorizedExponentRepair + "];",
  )(2, 4, 5, 0, 101, 69, 43, 45) as unknown[];
  expect(expectedSpan).toHaveLength(22);
  const asFunction = (value: unknown) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("name" in value) ||
      typeof value.name !== "string" ||
      !("body" in value) ||
      !Array.isArray(value.body)
    )
      throw Error("invalid recorded function");
    return value;
  };
  return {
    ...candidate,
    functions: candidate.functions.map((raw) => {
      const current = asFunction(raw);
      if (current.name !== "__str_to_number") return raw;
      const matches = original.functions.map(asFunction).filter((f) => f.name === current.name);
      expect(matches).toHaveLength(1);
      const before = matches[0]!.body;
      const sites = before.map((_, i) => i).filter((i) => isDeepStrictEqual(before.slice(i, i + 4), fullMatch));
      expect(sites).toHaveLength(1);
      const start = sites[0]!;
      expect(current.body.slice(start, start + 22)).toEqual(expectedSpan);
      // Remove this one validated extension only. The final full-record equality
      // still checks every retained body instruction, local, resource and trace.
      return { ...current, body: [...current.body.slice(0, start), ...current.body.slice(start + 22)] };
    }),
  };
}
describe("scanner complete historical donor receipts", () => {
  it("reconstructs all 13 donor functions, 34 constants, bodies, locals, docs and delegate after the exact approved delta", () =>
    verifySources(readSources()));
  it.each(["parseFloat", "parseInt", "__str_to_number", "all"])(
    "preserves donor emission/caches after exact scanner-extension projection for %s",
    (mode) => {
      const names = mode === "all" ? ["parseFloat", "parseInt", "__str_to_number"] : [mode];
      const live = readSources();
      verifySources(live);
      for (const imports of [0, 7]) {
        const original = recordLegacy(scannerDonorSource(), names, imports);
        expect(projectedLegacyRecord(recordLegacy(live.adapter, names, imports), original)).toEqual(original);
      }
    },
  );
  it.each(["type", "global", "push"])("preserves %s failure and registration/allocation ordering", (fault) => {
    expect(recordLegacy(readSources().adapter, ["__str_to_number"], 7, fault)).toEqual(
      recordLegacy(scannerDonorSource(), ["__str_to_number"], 7, fault),
    );
  });
  it.each([
    ["grammar", "function emitExponent(", "async function emitExponent("],
    ["grammar", "function emitDigitValue(", "function* emitDigitValue("],
    ["grammar", "C_ZERO = 48", "C_ZERO = 49"],
    ["scanner", "buildDecimalMantissa(strDataTypeIdx, getC)", "buildDecimalMantissa(strDataTypeIdx, [])"],
    ["scanner", 'type: { kind: "i64" }', 'type: { kind: "f64" }'],
    ["scaling", "POW10_TABLE_MAX = 308", "POW10_TABLE_MAX = 307"],
    ["scaling", "value: Number(", "value: Math.pow("],
    ["adapter", "buildStringToNumberPrelude,", "type buildStringToNumberPrelude,"],
    ["adapter", "buildStringToNumberPrelude,", "buildStringToNumberResult as buildStringToNumberPrelude,"],
  ] as const)("rejects live %s mutation %s", (owner, before, after) => {
    const s = readSources();
    verifySources(s);
    s[owner] = once(s[owner], before, after);
    expect(() => verifySources(s)).toThrow();
  });
  it.each(["grammar", "scaling", "scanner", "owner"] as const)("rejects missing canonical %s", (owner) => {
    const s = readSources();
    verifySources(s);
    s[owner] = "";
    expect(() => verifySources(s)).toThrow();
  });
  it.each(["import", "import type"])("rejects a forbidden %s facade edge", (keyword) => {
    const s = readSources();
    verifySources(s);
    s.scanner += "\n" + keyword + ' { CodegenContext } from "../../../codegen/context/types.js";';
    expect(() => verifySources(s)).toThrow("canonical dependency");
  });
  it("does not inject canonical exports absent from the recorded source imports", () => {
    expect(() =>
      adapterFactory("const POW10_TABLE_MAX = 308; export function emitNativeParseNumber() {}", []),
    ).not.toThrow();
    expect(() => adapterFactory("export const probe = POW10_TABLE_MAX;", [])).toThrow("POW10_TABLE_MAX is not defined");
  });
  it("rejects an unavailable value import rather than inventing an injected dependency", () => {
    expect(() =>
      adapterFactory('import { missing } from "./native-strings.js"; export function emitNativeParseNumber() {}', []),
    ).toThrow("unavailable recording import");
  });
  it("pins all 309 original decimal powers and immutable descriptors", () => {
    expect(scaling.buildDecimalPowerArrayType()).toEqual({
      kind: "array",
      name: "Pow10TableF64",
      element: { kind: "f64" },
      mutable: false,
    });
    const init = scaling.buildDecimalPowerArrayInitializer(43);
    expect(init).toEqual([
      ...Array.from({ length: 309 }, (_, k) => ({ op: "f64.const", value: Number(`1e${k}`) })),
      { op: "array.new_fixed", typeIdx: 43, length: 309 },
    ]);
    expect(
      scanner.buildStringToNumberLocals({
        nativeStrDataTypeIdx: 0,
        anyStrTypeIdx: 1,
        nativeStrTypeIdx: 2,
        consStrTypeIdx: 3,
        hashedStrTypeIdx: 4,
        utf8StrDataTypeIdx: -1,
        utf8StrTypeIdx: -1,
      }),
    ).toHaveLength(19);
  });
});

describe("exact approved missing-exponent source extension", () => {
  it("removes only the validated 22-instruction extension and the two exact value imports", () => {
    const live = readSources();
    verifySources(live);
    const stripped = stripAuthorizedExponentRepair(live.scanner);
    expect(stripped).not.toContain("StringToNumber requires exponent digits");
    expect(stripped).not.toContain("  C_LC_E,");
    expect(stripped).not.toContain("  C_UC_E,");
  });
  it.each([
    "missing",
    "duplicate",
    "misplaced",
    "wrong-character",
    "wrong-array-index",
    "omitted-branch",
    "wrong-return",
    "extra-executable",
  ] as const)("rejects %s extension without broad donor normalization", (mode) => {
    const live = readSources();
    verifySources(live);
    const { begin, end, exponentStart } = exponentRepairLocation(live.scanner);
    const span = live.scanner.slice(begin, end);
    let changed = span;
    if (mode === "missing") changed = "";
    if (mode === "duplicate") changed = span + span;
    if (mode === "wrong-character") changed = once(span, "value: C_LC_E", "value: C_LC_A");
    if (mode === "wrong-array-index") changed = once(span, "typeIdx: strDataTypeIdx", "typeIdx: strTypeIdx");
    if (mode === "omitted-branch")
      changed = once(span, 'then: [{ op: "f64.const", value: NaN }, { op: "return" }]', "then: []");
    if (mode === "wrong-return") changed = once(span, '{ op: "return" }', '{ op: "drop" }');
    if (mode === "extra-executable") changed = span + '{ op: "nop" },';
    live.scanner = live.scanner.slice(0, begin) + changed + live.scanner.slice(end);
    if (mode === "misplaced") {
      live.scanner = live.scanner.slice(0, begin) + live.scanner.slice(end);
      live.scanner = live.scanner.slice(0, exponentStart) + span + live.scanner.slice(exponentStart);
    }
    expect(() => verifySources(live)).toThrow();
  });
  it.each(["missing-letter-import", "type-only-letter-import", "aliased-letter-import"] as const)(
    "rejects %s",
    (mode) => {
      const live = readSources();
      verifySources(live);
      live.scanner = once(
        live.scanner,
        "  C_LC_E,",
        mode === "missing-letter-import"
          ? ""
          : mode === "type-only-letter-import"
            ? "  type C_LC_E,"
            : "  C_LC_A as C_LC_E,",
      );
      expect(() => verifySources(live)).toThrow("authorized exponent repair");
    },
  );
});
function prepare() {
  const { packet } = sourcePacket({ "./entry.ts": "export function main(value: number): number { return value; }" });
  const program = requireProgram(prepareTypedIrProgram(packet, typedOptions));
  const encoded = encodePreparedIrProgram(program);
  const decoded = decodePreparedIrProgram(encoded);
  expect(encodePreparedIrProgram(decoded)).toBe(encoded);
  return {
    program,
    decoded,
    encoded,
    plan: deriveNativeValueResourcePlan(program, program.runtime[0]!, "native-string"),
  };
}
/** Reuse the exact success or failure; a failed fixture must not rebuild for every assertion. */
function cacheFixtureOutcome<T>(operation: () => T): () => T {
  let outcome: { kind: "value"; value: T } | { kind: "error"; error: unknown } | undefined;
  return () => {
    if (outcome === undefined) {
      try {
        outcome = { kind: "value", value: operation() };
      } catch (error) {
        outcome = { kind: "error", error };
      }
    }
    if (outcome.kind === "error") throw outcome.error;
    return outcome.value;
  };
}
describe("shared scanner fixture outcome caching", () => {
  it("returns the same successful object without rebuilding", () => {
    let calls = 0;
    const value = {};
    const get = cacheFixtureOutcome(() => {
      calls++;
      return value;
    });
    expect(get()).toBe(value);
    expect(get()).toBe(value);
    expect(calls).toBe(1);
  });
  it("caches a successful undefined result", () => {
    let calls = 0;
    const get = cacheFixtureOutcome(() => {
      calls++;
    });
    expect(get()).toBeUndefined();
    expect(get()).toBeUndefined();
    expect(calls).toBe(1);
  });
  it("rethrows the identical failure with its original stack and cause on every use", () => {
    let calls = 0;
    const cause = new Error("underlying fixture failure");
    const failure = new Error("scanner fixture failed", { cause });
    const stack = failure.stack;
    const get = cacheFixtureOutcome(() => {
      calls++;
      throw failure;
    });
    const caught: unknown[] = [];
    for (let attempt = 0; attempt < 46; attempt++) {
      try {
        get();
      } catch (error) {
        caught.push(error);
      }
    }
    expect(calls).toBe(1);
    expect(caught).toHaveLength(46);
    for (const error of caught) expect(error).toBe(failure);
    expect(failure.stack).toBe(stack);
    expect(failure.cause).toBe(cause);
  });
  it("does not mistake a thrown undefined for an uninitialized or successful cache", () => {
    let calls = 0;
    const get = cacheFixtureOutcome(() => {
      calls++;
      throw undefined;
    });
    const caught: unknown[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        get();
      } catch (error) {
        caught.push(error);
      }
    }
    expect(calls).toBe(1);
    expect(caught).toEqual([undefined, undefined]);
  });
});
const actual = cacheFixtureOutcome(prepare);
const texts = [...scannerCases, ...scannerSemanticDebtCases].map(([, text]) => text);
function reserve(utf8 = false) {
  const mod = createEmptyModule(),
    tx = new PhysicalModuleReservations(mod);
  const stringPack = reserveNativeStringLiteralResources(tx, {
    key: "scanner:strings",
    utf8Storage: utf8,
    literals: [
      { value: "", encoding: "wtf16" },
      ...texts.map((value) => ({ value, encoding: "wtf16" as const })),
      { value: "xx3000000000yy", encoding: "wtf16" },
      ...(utf8 ? [{ value: "\u00a0\u200042", encoding: "utf8-guaranteed" as const }] : []),
    ],
  });
  const flatten = reserveNativeStringFlattenResources(tx, "scanner:flatten", stringPack);
  const pack = reserveNativeStringNumberResources(tx, actual().plan, flatten);
  return { mod, tx, stringPack, flatten, pack, plan: actual().plan };
}
function complete() {
  const s = reserve();
  s.tx.freezeReservations();
  fillNativeStringLiteralResources(s.tx, s.stringPack);
  fillNativeStringFlattenResources(s.tx, s.flatten);
  fillNativeStringNumberResources(s.tx, s.pack);
  return s;
}
function admitted(s: ReturnType<typeof reserve>) {
  return requireCompletedNativeStringNumber(s.tx, s.pack, s.plan, s.stringPack);
}
describe("issued scanner reservation and completion authority", () => {
  it("authenticates the exact producer in reserving phase without physical indices", () => {
    const s = reserve();
    expect(s.tx.state).toBe("reserving");
    expect(requireNativeStringNumberReservations(s.tx, s.pack, s.plan, s.stringPack)).toBe(s.pack);
    expect(s.tx.state).toBe("reserving");
    expect(() => admitted(s)).toThrow("incomplete");
  });
  it("completes the actual canonical dependency chain", () => {
    const s = complete();
    expect(admitted(s)).toBe(s.pack);
    const census = s.tx.seal();
    expect(census.completedGlobals).toBe(s.mod.globals.length);
    expect(census.completedFunctions).toBe(s.mod.functions.length);
    expect(admitted(s)).toBe(s.pack);
  });
  it.each(["equal-issued-plan", "clone-plan", "foreign-strings"] as const)(
    "completion rejects %s after its real positive",
    (mode) => {
      const s = complete();
      expect(admitted(s)).toBe(s.pack);
      const expectedPlan =
        mode === "equal-issued-plan"
          ? deriveNativeValueResourcePlan(actual().program, actual().program.runtime[0]!, "native-string")
          : mode === "clone-plan"
            ? { ...s.plan }
            : s.plan;
      const expectedStrings = mode === "foreign-strings" ? { ...s.stringPack } : s.stringPack;
      expect(() => requireCompletedNativeStringNumber(s.tx, s.pack, expectedPlan, expectedStrings)).toThrow();
    },
  );
  it("rejects a missing completed selected decoder", () => {
    const s = reserve(true);
    s.tx.freezeReservations();
    fillNativeStringLiteralResources(s.tx, s.stringPack);
    fillNativeStringFlattenResources(s.tx, s.flatten);
    fillNativeStringNumberResources(s.tx, s.pack);
    expect(admitted(s)).toBe(s.pack);
    expect(s.flatten.utf8Decoder).not.toBeNull();
    s.mod.functions.splice(s.mod.functions.indexOf(s.flatten.utf8Decoder!.object), 1);
    expect(() => admitted(s)).toThrow();
  });
  it.each(["clone-pack", "foreign-tx", "clone-plan", "equal-issued-plan", "foreign-strings", "clone-flatten"] as const)(
    "rejects %s before scanner allocation",
    (mode) => {
      const s = reserve();
      expect(requireNativeStringNumberReservations(s.tx, s.pack, s.plan, s.stringPack)).toBe(s.pack);
      const counts = [s.mod.types.length, s.mod.functions.length, s.mod.globals.length];
      const otherPlan = deriveNativeValueResourcePlan(actual().program, actual().program.runtime[0]!, "native-string");
      expect(otherPlan).toEqual(s.plan);
      expect(otherPlan).not.toBe(s.plan);
      const attempt = () => {
        if (mode === "clone-flatten") return reserveNativeStringNumberResources(s.tx, s.plan, { ...s.flatten });
        return requireNativeStringNumberReservations(
          mode === "foreign-tx" ? new PhysicalModuleReservations(createEmptyModule()) : s.tx,
          mode === "clone-pack" ? { ...s.pack } : s.pack,
          mode === "clone-plan" ? { ...s.plan } : mode === "equal-issued-plan" ? otherPlan : s.plan,
          mode === "foreign-strings" ? { ...s.stringPack } : s.stringPack,
        );
      };
      expect(attempt).toThrow();
      expect([s.mod.types.length, s.mod.functions.length, s.mod.globals.length]).toEqual(counts);
    },
  );
  it("rejects a cloned plan at reservation before allocating", () => {
    const s = reserve(),
      count = s.mod.functions.length;
    expect(() => reserveNativeStringNumberResources(s.tx, { ...s.plan }, s.flatten)).toThrow("unissued");
    expect(s.mod.functions).toHaveLength(count);
  });
  it.each(["literal", "flatten", "power", "scanner"] as const)("never promotes missing %s fill", (missing) => {
    const s = reserve();
    s.tx.freezeReservations();
    if (missing !== "literal") fillNativeStringLiteralResources(s.tx, s.stringPack);
    if (missing === "power" || missing === "scanner") fillNativeStringFlattenResources(s.tx, s.flatten);
    if (missing === "scanner")
      s.tx.fillGlobal(s.pack.powerGlobal, scaling.buildDecimalPowerArrayInitializer(s.pack.powerArray.typeIndex));
    if (missing === "power")
      s.tx.fillFunction(s.pack.toNumber, {
        locals: scanner.buildStringToNumberLocals(s.stringPack.layout),
        body: [
          ...scanner.buildStringToNumberPrelude(s.stringPack.layout, s.flatten.flatten.handle),
          ...scanner.buildStringToNumberResult({
            arrayTypeIndex: s.pack.powerArray.typeIndex,
            globalIndex: s.tx.physicalIndex(s.pack.powerGlobal),
          }),
        ],
      });
    expect(() => admitted(s)).toThrow();
    if (missing === "literal" || missing === "flatten")
      expect(() => fillNativeStringNumberResources(s.tx, s.pack)).toThrow();
  });
  it.each(["constant", "copied-body"] as const)(
    "refuses a manually filled %s even with correct tokens/name/signature",
    (mode) => {
      const s = reserve();
      s.tx.freezeReservations();
      fillNativeStringLiteralResources(s.tx, s.stringPack);
      fillNativeStringFlattenResources(s.tx, s.flatten);
      s.tx.fillGlobal(s.pack.powerGlobal, scaling.buildDecimalPowerArrayInitializer(s.pack.powerArray.typeIndex));
      s.tx.fillFunction(
        s.pack.toNumber,
        mode === "constant"
          ? { locals: [], body: [{ op: "f64.const", value: 42 }] }
          : {
              locals: scanner.buildStringToNumberLocals(s.stringPack.layout),
              body: [
                ...scanner.buildStringToNumberPrelude(s.stringPack.layout, s.flatten.flatten.handle),
                ...scanner.buildStringToNumberResult({
                  arrayTypeIndex: s.pack.powerArray.typeIndex,
                  globalIndex: s.tx.physicalIndex(s.pack.powerGlobal),
                }),
              ],
            },
      );
      expect(() => admitted(s)).toThrow("incomplete");
    },
  );
  it.each([
    "body",
    "locals",
    "power-entry",
    "power-count",
    "power-mutable",
    "array-mutable",
    "empty-literal",
    "reorder",
  ] as const)("rejects changed completed %s", (mode) => {
    const s = complete();
    expect(admitted(s)).toBe(s.pack);
    if (mode === "body") s.pack.toNumber.object.body = [{ op: "f64.const", value: 42 }];
    if (mode === "locals") s.pack.toNumber.object.locals = [];
    if (mode === "power-entry") s.pack.powerGlobal.object.init[0] = { op: "f64.const", value: 2 };
    if (mode === "power-count") s.pack.powerGlobal.object.init.pop();
    if (mode === "power-mutable") s.pack.powerGlobal.object.mutable = true;
    if (mode === "array-mutable") Object.assign(s.pack.powerArray.object, { mutable: true });
    if (mode === "empty-literal")
      s.flatten.emptyLiteral.object.init = [{ op: "ref.null", typeIdx: s.stringPack.layout.nativeStrTypeIdx }];
    if (mode === "reorder") s.mod.functions.reverse();
    expect(() => admitted(s)).toThrow();
  });
});

const execution = cacheFixtureOutcome(() => executeScannerResourceFixture(actual().program));
describe("actual owned native-string → flatten → scanner → unbox execution", () => {
  it("pins the actual whitespace scalar input without literal backslash escapes", () => {
    const row = scannerCases.find(([name]) => name === "whitespace")!;
    expect([...row[1]].map((char) => char.codePointAt(0))).toEqual([9, 160, 8192, 32, 52, 50, 32, 8232, 65279]);
    expect(row[1]).not.toContain("\\");
    expect(Number(row[1])).toBe(42);
    expect(row[2]).toBe(42);
  });
  it("instantiates the exact retained binary twice with zero imports and complete resources", () => {
    const r = execution();
    expect(r.bytes).toBe(r.instantiatedBytes);
    expect(r.bytes.length).toBeGreaterThan(100);
    expect(r.imports).toEqual([]);
    expect(r.wat).toContain("__str_to_number");
    expect(r.census.completedFunctions).toBe(r.resources.functions.length);
    expect(r.census.completedGlobals).toBe(r.resources.globals.length);
    expect(r.programOwners).toEqual(actual().program.ir.functions.map((f) => f.unitId));
    expect(r.programOwners.length).toBeGreaterThan(0);
    expect(r.resources.functions.map((f) => f.name)).toEqual([
      "__str_copy_tree",
      "__str_utf8_to_flat",
      "__str_flatten",
      "__str_to_number",
      "__box_number",
      "__unbox_number",
      "__typeof_number",
      ...[...scannerCases, ...scannerSemanticDebtCases, ...scannerExponentRepairCases].flatMap(([name]) =>
        ["wtf16", "utf8-guaranteed"].flatMap((encoding) =>
          ["flat", "offset"].map((view) => name + "__" + encoding + "__" + view),
        ),
      ),
      "offset",
      "ropeValue",
      "memo",
      "utf8",
    ]);
    expect(scannerCases).toHaveLength(20);
    expect(scannerSemanticDebtCases).toHaveLength(3);
    expect(scannerExponentRepairCases).toHaveLength(16);
    expect(r.resources.recipeCount).toBe(156);
    expect(r.observations.map((instance) => instance.rows.length)).toEqual([156, 156]);
  });
  it.each([...scannerCases, ...scannerExponentRepairCases, ...scannerSemanticDebtCases.slice(0, 2)])(
    "executes %s from real GC string resources",
    (name, text, expected) => {
      for (const instance of execution().observations) {
        const rows = instance.rows.filter((r) => r.name === name);
        expect(rows).toHaveLength(4);
        expect(rows.map((row) => [row.encoding, row.view, row.offset])).toEqual([
          ["wtf16", "flat", 0],
          ["wtf16", "offset", 2],
          ["utf8-guaranteed", "flat", 0],
          ["utf8-guaranteed", "offset", 2],
        ]);
        for (const row of rows) {
          expect(row.text).toBe(text);
          expect(row.semanticOK).toBe(true);
          expect(row.values).toEqual([row.expected, row.expected]);
          expect(row.expected).toBe(Number.isNaN(expected) ? "NaN" : Object.is(expected, -0) ? "-0" : String(expected));
        }
      }
    },
  );
  it.each(["offset", "ropeValue", "memo", "utf8"])("executes %s twice per instance", (name) => {
    const expected = name === "offset" ? 3e9 : name === "memo" ? 1 : 42;
    for (const instance of execution().observations)
      expect(instance.extras.find((row) => row.name === name)?.values).toEqual([expected, expected]);
    expect(execution().resources.pendingRightChildren).toBe(40);
    expect(execution().resources.utf8Decoder).toBe("__str_utf8_to_flat");
  });
  it("requires repaired exponent semantics while retaining the independent precision debt", () => {
    const r = execution();
    const directory = scratch("native-scanner-semantics-");
    // Persist complete values even when one of the following semantic checks
    // fails. R1's wrong outcomes and original donor remain separate receipts.
    writeFileSync(
      resolve(directory, "receipt.json"),
      JSON.stringify(
        {
          ...r,
          scope: "resource-producer execution; not public compiler preservation",
          semanticOK: r.observations.every((instance) => instance.rows.every((row) => row.semanticOK)),
          requiredSemanticOK: r.observations.every((instance) =>
            instance.rows.filter((row) => row.name !== "precision").every((row) => row.semanticOK),
          ),
          precisionDebtAssessedComplete: false,
          wholeProgramExecutionAssessed: false,
        },
        null,
        2,
      ),
    );
    const rows = r.observations.map((instance) =>
      instance.rows.filter((row) => scannerSemanticDebtCases.some(([name]) => name === row.name)),
    );
    expect(rows.map((a) => a.length)).toEqual([12, 12]);
    expect(rows[0]).toEqual(rows[1]);
    for (const instance of rows)
      for (const row of instance) {
        expect(row.values).toHaveLength(2);
        expect(row.values[0]).toBe(row.values[1]);
        expect(row.semanticOK).toBe(row.values.every((v) => v === row.expected));
        if (row.name !== "precision") {
          expect(row.expected).toBe("NaN");
          expect(row.semanticOK).toBe(true);
          expect(row.values).toEqual(["NaN", "NaN"]);
        }
      }
  });
  it("replays actual canonical prepared bytes into identical emitted bytes/WAT/order/results", () => {
    expect(executeScannerResourceFixture(actual().decoded)).toEqual(execution());
  });
  it("executes unchanged public standalone parseFloat prefix and parseInt grammars", async () => {
    const { compile } = await import("../src/index.js");
    const source = `
      export function floatPrefix(): number { return parseFloat("1e+"); }
      export function intPrefix(): number { return parseInt("1e+", 10); }
      export function intHex(): number { return parseInt("0x1e", 0); }
      export function intNegative(): number { return parseInt(" -7px", 10); }
    `;
    const result = await compile(source, { target: "standalone", emitWat: true, fileName: "scanner-prefix.ts" });
    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.wat).toContain("parseFloat");
    expect(result.wat).toContain("parseInt");
    const compiled = new WebAssembly.Module(result.binary as BufferSource);
    expect(WebAssembly.Module.imports(compiled)).toEqual([]);
    const observations = [];
    for (let instance = 0; instance < 2; instance++) {
      const exports = new WebAssembly.Instance(compiled, {}).exports as Record<string, () => number>;
      observations.push(
        Object.fromEntries(
          ["floatPrefix", "intPrefix", "intHex", "intNegative"].map((name) => [
            name,
            [exports[name]!(), exports[name]!()],
          ]),
        ),
      );
    }
    const directory = scratch("native-scanner-legacy-prefix-");
    writeFileSync(
      resolve(directory, "receipt.json"),
      JSON.stringify(
        {
          source,
          bytes: Buffer.from(result.binary).toString("base64"),
          instantiatedBytes: Buffer.from(result.binary).toString("base64"),
          wat: result.wat,
          imports: WebAssembly.Module.imports(compiled),
          exports: WebAssembly.Module.exports(compiled),
          observations,
        },
        null,
        2,
      ),
    );
    expect(observations).toEqual(
      Array.from({ length: 2 }, () => ({
        floatPrefix: [1, 1],
        intPrefix: [1, 1],
        intHex: [30, 30],
        intNegative: [-7, -7],
      })),
    );
  }, 120000);
});

const deniedPatterns = [
  /\/src\/(checker|frontend|codegen|codegen-linear|compiler)\//,
  /\/src\/(ts-api|compiler|index)\.[cm]?[jt]s$/,
  /\/src\/ir\/(from-ast|async-from-ast|async-prepare|identity|program-source|program-preparation|program-middleend|program-middleend-ir|program-native-async-source|program-logical-types)\.[cm]?[jt]s$/,
  /\/src\/ir\/passes\/gvn\.[cm]?[jt]s$/,
  /\/node_modules\/(typescript|typescript7)\//,
];
const guardSource = `
import {appendFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
let data;
export function initialize(value){data=value;}
function check(url,parent,phase){
 const path=url.startsWith("file:")?fileURLToPath(url):url;
 const denied=data.patterns.some(p=>new RegExp(p).test(path));
 appendFileSync(data.census,JSON.stringify({url,parent:parent??null,phase,denied})+"\\n");
 if(denied)throw new Error("native scanner forbidden load: "+url);
}
export async function resolve(specifier,context,next){
 if(specifier.startsWith("file:")||((specifier.startsWith("./")||specifier.startsWith("../"))&&context.parentURL?.startsWith("file:")))
  check(new URL(specifier,context.parentURL).href,context.parentURL,"requested");
 const result=await next(specifier,context);check(result.url,context.parentURL,"resolved");return result;
}
`;
const guardURL = "data:text/javascript," + encodeURIComponent(guardSource);
function launch(
  args: string[],
  cwd = root,
): Promise<{ status: number | null; signal: string | null; stdout: string; stderr: string; error: string | null }> {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      error: string | null = null;
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", (cause) => {
      error = String(cause);
    });
    child.on("close", (status, signal) => resolveResult({ status, signal, stdout, stderr, error }));
  });
}
const canonicalRoots = [
  "src/backend/wasmgc/resources/native-resource-declarations.ts",
  "src/runtime/wasmgc/values/string-number-grammar.ts",
  "src/runtime/wasmgc/values/decimal-scale-bodies.ts",
  "src/runtime/wasmgc/values/string-number-bodies.ts",
  "src/backend/wasmgc/resources/native-string-number.ts",
  "src/backend/wasmgc/resources/native-string-flatten.ts",
  "src/runtime/wasmgc/values/string-flatten-bodies.ts",
  "src/runtime/wasmgc/values/string-utf8-decode-bodies.ts",
  "src/backend/wasmgc/resources/native-string-literals.ts",
  "src/backend/wasmgc/resources/native-values.ts",
];
// Erased declarations are hashed, but must not be fabricated as runtime loads.
const canonicalSnapshotPaths = [...canonicalRoots, "src/runtime/wasmgc/values/native-resource-declaration-types.ts"];
function childSource(rootPath: string, packet: string, report: string, census: string): string {
  return `
import {register} from "node:module";
import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {pathToFileURL} from "node:url";
import {resolve} from "node:path";
const root=${JSON.stringify(rootPath)}, packet=${JSON.stringify(packet)}, report=${JSON.stringify(report)};
const paths=${JSON.stringify(canonicalSnapshotPaths)};
const sha=text=>createHash("sha256").update(text).digest("hex");
const snapshot=()=>Object.fromEntries(paths.map(p=>[p,sha(readFileSync(resolve(root,p)))]));
const before=snapshot(),encoded=readFileSync(packet,"utf8");
const out={ok:false,root,node:process.version,encodedSha256:sha(encoded),before,after:null,execution:null,error:null};
register(${JSON.stringify(guardURL)},{parentURL:import.meta.url,data:${JSON.stringify({ census, patterns: deniedPatterns.map((p) => p.source) })}});
try{
 const codec=await import(pathToFileURL(resolve(root,"src/ir/program-codec.ts")).href);
 const program=codec.decodePreparedIrProgram(encoded);
 if(codec.encodePreparedIrProgram(program)!==encoded)throw Error("codec bytes differ");
 const fixture=await import(pathToFileURL(resolve(root,"tests/fixtures/issue-3518-native-string-number-donor.ts")).href);
 out.execution=fixture.executeScannerResourceFixture(program);
 out.after=snapshot();
 if(JSON.stringify(out.after)!==JSON.stringify(before))throw Error("source changed");
 out.ok=true;
}catch(error){out.error=String(error?.stack??error);}
writeFileSync(report,JSON.stringify(out,null,2));process.exitCode=out.ok?0:1;
`;
}
describe("fresh-process canonical resource admission", () => {
  it("executes a source-produced codec with frontend/legacy emitters denied", async () => {
    const directory = scratch("native-scanner-admission-");
    const packet = resolve(directory, "program.json"),
      report = resolve(directory, "report.json"),
      census = resolve(directory, "loads.jsonl"),
      entry = resolve(directory, "entry.mjs");
    writeFileSync(packet, actual().encoded);
    writeFileSync(entry, childSource(root, packet, report, census));
    const terminal = await launch(["--import", "tsx", entry]);
    writeFileSync(resolve(directory, "terminal.json"), JSON.stringify(terminal, null, 2));
    expect(terminal.error).toBeNull();
    expect(terminal.signal).toBeNull();
    const receipt = JSON.parse(readFileSync(report, "utf8"));
    expect(terminal.status, receipt.error ?? terminal.stderr).toBe(0);
    expect(receipt.ok, receipt.error).toBe(true);
    expect(receipt.root).toBe(root);
    expect(receipt.node).toBe(process.version);
    expect(receipt.encodedSha256).toBe(sha(actual().encoded));
    const hashes = Object.fromEntries(canonicalSnapshotPaths.map((p) => [p, sha(readFileSync(resolve(root, p)))]));
    expect(receipt.before).toEqual(hashes);
    expect(receipt.after).toEqual(hashes);
    expect(receipt.execution).toEqual(execution());
    const loads = readFileSync(census, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(loads.length).toBeGreaterThan(0);
    expect(loads.filter((row) => row.denied)).toEqual([]);
    for (const p of canonicalRoots)
      expect(loads.some((row) => row.url === pathToFileURL(resolve(root, p)).href && row.phase === "resolved")).toBe(
        true,
      );
  }, 120000);
  it.each(["", "?duplicate=1", "#duplicate"])("proves exact forbidden URL rejection %s", async (suffix) => {
    const directory = scratch("native-scanner-denied-"),
      census = resolve(directory, "loads.jsonl");
    const url = pathToFileURL(resolve(root, paths.adapter)).href + suffix;
    // Plain Node preserves suffixes before this SAME guard's requested-URL
    // check; tsx can strip them. No sentinel failure counts as guard evidence.
    const script = `import {register} from "node:module";register(${JSON.stringify(guardURL)},{parentURL:import.meta.url,data:${JSON.stringify({ census, patterns: deniedPatterns.map((p) => p.source) })}});await import(${JSON.stringify(url)});`;
    const terminal = await launch(["--input-type=module", "--eval", script]);
    writeFileSync(resolve(directory, "terminal.json"), JSON.stringify(terminal, null, 2));
    expect(terminal.error).toBeNull();
    expect(terminal.signal).toBeNull();
    expect(terminal.status).toBe(1);
    expect(terminal.stderr).toContain("native scanner forbidden load: " + url);
    const loads = readFileSync(census, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(loads.filter((row) => row.denied)).toEqual([
      { url, parent: new URL("[eval1]", pathToFileURL(root + "/")).href, phase: "requested", denied: true },
    ]);
    expect(loads.some((row) => row.url === url && row.phase === "resolved")).toBe(false);
  });
});
