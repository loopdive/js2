// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  programPreADependencies,
  programPreAPaths,
  programPreAReceiptPath,
  reconstructProgramPreA,
} from "./ir-program-pre-a-evolution.js";

const inputPath = "src/ir/program/input.ts";
const handlesPath = "src/wasm/physical/function-handles.ts";
export const programInitialGraphReceiptPath = "tests/helpers/ir-program-initial-graph-evolution.json";
const receiptSha256 = "0cd9d3d2580f0473c7fa940578f9e706d1a86b15688547896e919cd180c1b904";
export const programInitialGraphPaths = Object.freeze([
  "src/ir/program/input-contracts.ts",
  "src/ir/program/prepared-contracts.ts",
  inputPath,
  handlesPath,
]);
export const programInitialGraphInputPaths = Object.freeze([
  ...programPreAPaths,
  ...programPreADependencies,
  inputPath,
  handlesPath,
  "src/wasm/model/instructions.ts",
  "src/wasm/model/module-records.ts",
]);
export type ProgramInitialGraphReader = (path: string) => string | undefined;
export const readProgramInitialGraphActual: ProgramInitialGraphReader = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
export type ProgramInitialGraphErrorCode =
  | "receipt"
  | "missing-source"
  | "pin"
  | "syntax"
  | "span"
  | "role"
  | "reciprocal";
export class ProgramInitialGraphEvolutionError extends Error {
  constructor(
    readonly code: ProgramInitialGraphErrorCode,
    detail: string,
    cause?: unknown,
  ) {
    super(`program initial graph ${code}: ${detail}`, { cause });
    this.name = "ProgramInitialGraphEvolutionError";
  }
}
interface Pin {
  readonly bytes: number;
  readonly sha256: string;
  readonly gitBlob: string;
}
interface Span extends Pin {
  readonly startByte: number;
  readonly endByte: number;
}
interface Declaration extends Span {
  readonly ordinal: number;
  readonly kind: string;
  readonly name: string | null;
}
interface Operand extends Span {
  readonly slot: "callee" | "receiver" | "requiredFields";
  readonly ownerOrdinal: number;
  readonly ownerName: string;
  readonly statementOrdinal: number;
  readonly kind: string;
}
interface Change {
  readonly role: string;
  readonly current: Span;
  readonly original: Span;
  readonly replacement: "delete" | "first-fields-call";
  readonly originalAnchor: Span | null;
}
interface RecordRecipe {
  readonly path: string;
  readonly current: Pin;
  readonly original: Pin;
  readonly currentDeclarations: readonly Declaration[];
  readonly originalDeclarations: readonly Declaration[];
  readonly operands: readonly Operand[];
  readonly changes: readonly Change[];
}
export interface ProgramInitialGraphReceipt {
  readonly schema: number;
  readonly kind: string;
  readonly provenance: {
    readonly originalReceipt: string;
    readonly extractionRevision: string;
    readonly runtimeSupportCommit: string;
    readonly physicalCommit: string;
    readonly previousKernel: string;
  };
  readonly preAReceipt: Pin & { readonly path: string };
  readonly inputs: readonly (Pin & { readonly path: string })[];
  readonly outputs: readonly (Pin & { readonly path: string })[];
  readonly records: readonly RecordRecipe[];
}
function requireGraph(condition: unknown, code: ProgramInitialGraphErrorCode, detail: string): asserts condition {
  if (!condition) throw new ProgramInitialGraphEvolutionError(code, detail);
}
export function programInitialGraphPin(source: string | Uint8Array): Pin {
  return {
    bytes: Buffer.byteLength(source),
    sha256: createHash("sha256").update(source).digest("hex"),
    gitBlob: createHash("sha1")
      .update(`blob ${Buffer.byteLength(source)}\0`)
      .update(source)
      .digest("hex"),
  };
}
function validPin(pin: Pin): void {
  requireGraph(
    pin &&
      Number.isSafeInteger(pin.bytes) &&
      pin.bytes >= 0 &&
      /^[a-f0-9]{64}$/.test(pin.sha256) &&
      /^[a-f0-9]{40}$/.test(pin.gitBlob),
    "receipt",
    "invalid complete or span pin",
  );
}
/** Component guard, never an alternative receipt authority. */
export function assertProgramInitialGraphPin(source: string | Uint8Array, expected: Pin, label: string): void {
  validPin(expected);
  const actual = programInitialGraphPin(source);
  requireGraph(
    actual.bytes === expected.bytes && actual.sha256 === expected.sha256,
    "pin",
    `SHA256/length mismatch: ${label}`,
  );
  requireGraph(actual.gitBlob === expected.gitBlob, "pin", `Git blob mismatch: ${label}`);
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function validSpan(span: Span, limit: number): void {
  validPin(span);
  requireGraph(
    Number.isSafeInteger(span.startByte) &&
      Number.isSafeInteger(span.endByte) &&
      span.startByte >= 0 &&
      span.endByte >= span.startByte &&
      span.endByte <= limit &&
      span.endByte - span.startByte === span.bytes,
    "span",
    "invalid byte range",
  );
}
/** Independently testable structure guard; actual reconstruction also requires the fixed receipt digest. */
export function assertProgramInitialGraphRecipe(receipt: ProgramInitialGraphReceipt): void {
  requireGraph(
    receipt && receipt.schema === 1 && receipt.kind === "authenticated-live-program-initial-graph-evolution",
    "receipt",
    "schema/kind",
  );
  requireGraph(
    same(receipt.provenance, {
      originalReceipt: "f95d8a0bf318e857d981863b1018a9d776483a46",
      extractionRevision: "3a119a88b28bb347f4faaaa2146bd991acf61228",
      runtimeSupportCommit: "efe352fee8afc3feb6a28c34d00fc658dc1fb205",
      physicalCommit: "4b00bce674d20192e96fdd77fa58cc03f35a1fc7",
      previousKernel: "36ea5ce9f54190c1f2c7af0466cf768afb453394",
    }),
    "receipt",
    "provenance",
  );
  requireGraph(
    Array.isArray(receipt.inputs) &&
      same(
        receipt.inputs.map((p) => p?.path),
        programInitialGraphInputPaths,
      ),
    "receipt",
    "input domain/order",
  );
  requireGraph(
    Array.isArray(receipt.outputs) &&
      same(
        receipt.outputs.map((p) => p?.path),
        programInitialGraphPaths,
      ),
    "receipt",
    "output domain/order",
  );
  requireGraph(receipt.preAReceipt?.path === programPreAReceiptPath, "receipt", "pre-A receipt domain");
  for (const pin of [...receipt.inputs, ...receipt.outputs, receipt.preAReceipt]) validPin(pin);
  requireGraph(
    Array.isArray(receipt.records) &&
      same(
        receipt.records.map((r) => r?.path),
        [inputPath, handlesPath],
      ),
    "receipt",
    "record domain/order",
  );
  for (const [index, record] of receipt.records.entries()) {
    validPin(record.current);
    validPin(record.original);
    requireGraph(
      same(record.current, stripPath(receipt.inputs.find((p) => p.path === record.path)!)) &&
        same(record.original, stripPath(receipt.outputs.find((p) => p.path === record.path)!)),
      "receipt",
      "record/input/output ownership",
    );
    requireGraph(
      Array.isArray(record.currentDeclarations) &&
        Array.isArray(record.originalDeclarations) &&
        same([record.currentDeclarations.length, record.originalDeclarations.length], index === 0 ? [11, 10] : [8, 2]),
      "receipt",
      "declaration population",
    );
    for (const [side, declarations] of [
      [record.current, record.currentDeclarations],
      [record.original, record.originalDeclarations],
    ] as const) {
      let end = 0;
      for (const [ordinal, declaration] of declarations.entries()) {
        validSpan(declaration, side.bytes);
        requireGraph(
          declaration.ordinal === ordinal &&
            declaration.startByte >= end &&
            typeof declaration.kind === "string" &&
            (declaration.name === null || typeof declaration.name === "string"),
          "role",
          "declaration kind/name/order",
        );
        end = declaration.endByte;
      }
    }
    requireGraph(
      Array.isArray(record.operands) &&
        same(
          record.operands.map((o: Operand) => o?.slot),
          index === 0 ? ["callee", "receiver", "requiredFields"] : [],
        ),
      "role",
      "operand domain/order",
    );
    for (const operand of record.operands) {
      validSpan(operand, record.current.bytes);
      requireGraph(
        operand.ownerName === "ownTypedIrProgramInput" &&
          Number.isSafeInteger(operand.ownerOrdinal) &&
          operand.ownerOrdinal >= 0 &&
          Number.isSafeInteger(operand.statementOrdinal) &&
          operand.statementOrdinal >= 0 &&
          operand.kind === (operand.slot === "requiredFields" ? "ArrayLiteralExpression" : "Identifier"),
        "role",
        "operand owner/kind",
      );
    }
    requireGraph(
      Array.isArray(record.changes) &&
        same(
          record.changes.map((c: Change) => c?.role),
          index === 0
            ? ["runtime-support-import", "initial-fields-call", "runtime-support-validation"]
            : ["allocator-type-imports", "allocator-declarations"],
        ),
      "receipt",
      "change domain/order",
    );
    let end = 0,
      delta = 0;
    for (const change of record.changes) {
      validSpan(change.current, record.current.bytes);
      validSpan(change.original, record.original.bytes);
      requireGraph(
        change.current.bytes > 0 &&
          change.current.startByte >= end &&
          change.original.startByte === change.current.startByte + delta,
        "span",
        "ordered reciprocal coordinates",
      );
      requireGraph(
        change.replacement === (change.role === "initial-fields-call" ? "first-fields-call" : "delete") &&
          (change.original.bytes === 0) === (change.replacement === "delete"),
        "receipt",
        "replacement role",
      );
      requireGraph((change.original.bytes === 0) === !!change.originalAnchor, "span", "reciprocal insertion anchor");
      if (change.originalAnchor) validSpan(change.originalAnchor, record.original.bytes);
      end = change.current.endByte;
      delta += change.original.bytes - change.current.bytes;
    }
    requireGraph(record.current.bytes + delta === record.original.bytes, "span", "complete reciprocal length");
  }
}
function stripPath(pin: Pin & { readonly path: string }): Pin {
  return { bytes: pin.bytes, sha256: pin.sha256, gitBlob: pin.gitBlob };
}
export function authenticateProgramInitialGraphEvolution(
  text: string = requiredRead(readProgramInitialGraphActual, programInitialGraphReceiptPath),
): ProgramInitialGraphReceipt {
  requireGraph(
    typeof text === "string" && programInitialGraphPin(text).sha256 === receiptSha256,
    "receipt",
    "fixed digest mismatch",
  );
  const receipt = JSON.parse(text) as ProgramInitialGraphReceipt;
  assertProgramInitialGraphRecipe(receipt);
  return receipt;
}
function requiredRead(reader: ProgramInitialGraphReader, path: string): string {
  let text: string | undefined;
  try {
    text = reader(path);
  } catch (cause) {
    throw new ProgramInitialGraphEvolutionError("missing-source", path, cause);
  }
  requireGraph(typeof text === "string", "missing-source", path);
  return text;
}
function parsed(path: string, text: string): ts.SourceFile {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  requireGraph(
    !(source as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length,
    "syntax",
    path,
  );
  return source;
}
function uniqueAt(source: Buffer, value: Buffer, at: number, label: string): void {
  requireGraph(
    value.length > 0 && source.indexOf(value) === at && source.indexOf(value, at + 1) === -1,
    "span",
    `missing/duplicate/shifted span: ${label}`,
  );
}
/** Component span guard; AST-qualified operands deliberately do not require globally unique identifier spelling. */
export function assertProgramInitialGraphSpan(source: string | Uint8Array, span: Span, label: string): Buffer {
  const bytes = typeof source === "string" ? Buffer.from(source) : Buffer.from(source);
  validSpan(span, bytes.length);
  const value = bytes.subarray(span.startByte, span.endByte);
  assertProgramInitialGraphPin(value, span, label);
  requireGraph(Buffer.from(value.toString("utf8")).equals(value), "span", `split UTF-8 boundary: ${label}`);
  return value;
}
function declarationName(node: ts.Statement, source: ts.SourceFile): string | null {
  if (ts.isImportDeclaration(node)) return (node.moduleSpecifier as ts.StringLiteral).text;
  if (ts.isVariableStatement(node))
    return node.declarationList.declarations.map((d) => d.name.getText(source)).join(",");
  return "name" in node && node.name ? (node.name as ts.Node).getText(source) : null;
}
function assertDeclarations(path: string, text: string, expected: readonly Declaration[]): ts.SourceFile {
  const source = parsed(path, text);
  requireGraph(source.statements.length === expected.length, "role", `complete declaration census: ${path}`);
  for (const declaration of expected) {
    const node = source.statements[declaration.ordinal]!;
    requireGraph(
      ts.SyntaxKind[node.kind] === declaration.kind &&
        declarationName(node, source) === declaration.name &&
        Buffer.byteLength(text.slice(0, node.getStart(source))) === declaration.startByte &&
        Buffer.byteLength(text.slice(0, node.end)) === declaration.endByte,
      "role",
      `declaration ownership: ${path}`,
    );
    assertProgramInitialGraphPin(node.getText(source), declaration, `${path} ${declaration.ordinal}`);
  }
  return source;
}
function firstFieldsCall(record: RecordRecipe, text: string, source: ts.SourceFile): Buffer {
  const parts: string[] = [];
  for (const operand of record.operands) {
    const owner = source.statements[operand.ownerOrdinal];
    requireGraph(
      owner && ts.isFunctionDeclaration(owner) && owner.name?.text === operand.ownerName && owner.body,
      "role",
      "fields owner",
    );
    const statement = owner.body.statements[operand.statementOrdinal];
    requireGraph(
      statement &&
        ts.isExpressionStatement(statement) &&
        ts.isCallExpression(statement.expression) &&
        statement.expression.arguments.length === 3 &&
        statement.expression.expression.getText(source) === "fields",
      "role",
      "fields statement",
    );
    const call = statement.expression;
    const node = operand.slot === "callee" ? call.expression : call.arguments[operand.slot === "receiver" ? 0 : 1]!;
    requireGraph(
      ts.SyntaxKind[node.kind] === operand.kind &&
        Buffer.byteLength(text.slice(0, node.getStart(source))) === operand.startByte &&
        Buffer.byteLength(text.slice(0, node.end)) === operand.endByte,
      "role",
      "fields operand ownership",
    );
    const bytes = assertProgramInitialGraphSpan(text, operand, operand.slot);
    requireGraph(bytes.toString("utf8") === node.getText(source), "role", "fields operand bytes");
    parts.push(bytes.toString("utf8"));
  }
  // Only punctuation and whitespace are literal; every executable token is a current AST operand.
  return Buffer.from(`  ${parts[0]}(${parts[1]}, ${parts[2]});`);
}
function inverse(record: RecordRecipe, current: string): string {
  assertProgramInitialGraphPin(current, record.current, `current ${record.path}`);
  const source = assertDeclarations(record.path, current, record.currentDeclarations),
    bytes = Buffer.from(current);
  let cursor = 0;
  const parts: Buffer[] = [];
  for (const change of record.changes) {
    const actual = assertProgramInitialGraphSpan(bytes, change.current, change.role);
    uniqueAt(bytes, actual, change.current.startByte, change.role);
    const replacement = change.replacement === "delete" ? Buffer.alloc(0) : firstFieldsCall(record, current, source);
    assertProgramInitialGraphPin(replacement, change.original, `original span ${change.role}`);
    parts.push(bytes.subarray(cursor, change.current.startByte), replacement);
    cursor = change.current.endByte;
  }
  parts.push(bytes.subarray(cursor));
  const original = Buffer.concat(parts).toString("utf8");
  assertProgramInitialGraphPin(original, record.original, `original ${record.path}`);
  assertDeclarations(record.path, original, record.originalDeclarations);
  forward(record, original, current);
  return original;
}
function forward(record: RecordRecipe, original: string, current: string): void {
  assertProgramInitialGraphPin(original, record.original, `original ${record.path}`);
  const bytes = Buffer.from(original),
    raw = Buffer.from(current),
    parts: Buffer[] = [];
  let cursor = 0;
  for (const change of record.changes) {
    const before = assertProgramInitialGraphSpan(bytes, change.original, `reciprocal ${change.role}`);
    if (before.length) uniqueAt(bytes, before, change.original.startByte, change.role);
    else {
      const anchor = change.originalAnchor!;
      uniqueAt(bytes, assertProgramInitialGraphSpan(bytes, anchor, change.role), anchor.startByte, change.role);
    }
    parts.push(
      bytes.subarray(cursor, change.original.startByte),
      assertProgramInitialGraphSpan(raw, change.current, change.role),
    );
    cursor = change.original.endByte;
  }
  parts.push(bytes.subarray(cursor));
  const replay = Buffer.concat(parts);
  assertProgramInitialGraphPin(replay, record.current, `reciprocal current ${record.path}`);
  requireGraph(replay.equals(raw), "reciprocal", `complete current bytes: ${record.path}`);
}
function capture(reader: ProgramInitialGraphReader, receipt: ProgramInitialGraphReceipt): Map<string, string> {
  const sources = new Map<string, string>();
  for (const input of receipt.inputs) {
    const text = requiredRead(reader, input.path);
    assertProgramInitialGraphPin(text, input, input.path);
    sources.set(input.path, text);
  }
  const preA = requiredRead(reader, receipt.preAReceipt.path);
  assertProgramInitialGraphPin(preA, receipt.preAReceipt, "pre-A fixed receipt");
  sources.set(receipt.preAReceipt.path, preA);
  return sources;
}
/** Fresh initial historical fixture projection only; never a compiler reader or mutant normalizer. */
export function reconstructProgramInitialGraph(
  reader: ProgramInitialGraphReader = readProgramInitialGraphActual,
  receiptText?: string,
): ReadonlyMap<string, string> {
  const receipt = authenticateProgramInitialGraphEvolution(receiptText),
    sources = capture(reader, receipt);
  const capturedRead = (path: string): string => {
    requireGraph(sources.has(path), "missing-source", `outside captured input domain: ${path}`);
    return sources.get(path)!;
  };
  const preA = reconstructProgramPreA(capturedRead, capturedRead(programPreAReceiptPath));
  const result = new Map<string, string>();
  for (const output of receipt.outputs) {
    const record = receipt.records.find((r) => r.path === output.path);
    const text = record ? inverse(record, capturedRead(output.path)) : preA.get(output.path);
    requireGraph(typeof text === "string", "missing-source", `required projected output: ${output.path}`);
    assertProgramInitialGraphPin(text, output, `complete output ${output.path}`);
    result.set(output.path, text);
  }
  return result;
}
/** Known paths use a private initial snapshot; unknown paths always read raw and missing paths fail. */
export function createProgramInitialGraphReader(
  reader: ProgramInitialGraphReader = readProgramInitialGraphActual,
  receiptText?: string,
): (path: string) => string {
  const initial = reconstructProgramInitialGraph(reader, receiptText);
  return (path) => {
    if (!programInitialGraphPaths.includes(path)) return requiredRead(reader, path);
    const text = initial.get(path);
    requireGraph(typeof text === "string", "missing-source", `required initial output: ${path}`);
    return text;
  };
}
/** Component reciprocal control still authenticates the full fixed live population afresh. */
export function verifyProgramInitialGraphReciprocal(
  path: string,
  current: string,
  original: string,
  reader: ProgramInitialGraphReader = readProgramInitialGraphActual,
): void {
  const receipt = authenticateProgramInitialGraphEvolution(),
    sources = capture(reader, receipt);
  const record = receipt.records.find((r) => r.path === path);
  requireGraph(record, "receipt", `outside reciprocal record domain: ${path}`);
  assertProgramInitialGraphPin(current, record.current, `supplied current ${path}`);
  requireGraph(current === sources.get(path), "reciprocal", `supplied live bytes ${path}`);
  assertDeclarations(path, current, record.currentDeclarations);
  assertDeclarations(path, original, record.originalDeclarations);
  forward(record, original, current);
}
