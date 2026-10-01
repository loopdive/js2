// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";

export const programCoreTypePath = "src/ir/core/types.ts";
export const programCoreTypeReceiptPath = "tests/helpers/ir-program-core-type-evolution.json";
const receiptSha256 = "7656fac126fa982f114f900382e6f3a256d417d3750406a142e96df22d6f80e2";
export const programCoreTypeInputPaths = Object.freeze([
  programCoreTypePath,
  "src/shared/contracts/ir-identity.ts",
  "src/wasm/model/instructions.ts",
  "src/ir/core/fnctor-shapes.ts",
  "src/ir/core/value-references.ts",
  "src/ir/core/tag-refinement.ts",
  "src/ir/core/binding-key-primitives.ts",
]);
export type ProgramCoreTypeReader = (path: string) => string | undefined;
export const readProgramCoreTypeActual: ProgramCoreTypeReader = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
export type ProgramCoreTypeErrorCode = "receipt" | "missing-source" | "pin" | "syntax" | "span" | "role" | "reciprocal";
export class ProgramCoreTypeEvolutionError extends Error {
  constructor(
    readonly code: ProgramCoreTypeErrorCode,
    detail: string,
    cause?: unknown,
  ) {
    super(`program core type ${code}: ${detail}`, { cause });
    this.name = "ProgramCoreTypeEvolutionError";
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
interface Change {
  readonly role: string;
  readonly current: Span;
  readonly originalOffset: number;
  readonly originalAnchor: Span;
}
export interface ProgramCoreTypeReceipt {
  readonly schema: number;
  readonly kind: string;
  readonly provenance: {
    readonly fixtureRevision: string;
    readonly introducingCommit: string;
    readonly introducingParent: string;
    readonly patchSha256: string;
  };
  readonly inputs: readonly (Pin & { readonly path: string })[];
  readonly output: Pin & { readonly path: string };
  readonly currentDeclarations: readonly Declaration[];
  readonly originalDeclarations: readonly Declaration[];
  readonly changes: readonly Change[];
}
function requireCore(condition: unknown, code: ProgramCoreTypeErrorCode, detail: string): asserts condition {
  if (!condition) throw new ProgramCoreTypeEvolutionError(code, detail);
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function programCoreTypePin(source: string | Uint8Array): Pin {
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
  requireCore(
    pin &&
      Number.isSafeInteger(pin.bytes) &&
      pin.bytes >= 0 &&
      /^[a-f0-9]{64}$/.test(pin.sha256) &&
      /^[a-f0-9]{40}$/.test(pin.gitBlob),
    "receipt",
    "invalid complete or span pin",
  );
}
/** Diagnostic component guard, never alternative reconstruction authority. */
export function assertProgramCoreTypePin(source: string | Uint8Array, pin: Pin, label: string): void {
  validPin(pin);
  const actual = programCoreTypePin(source);
  requireCore(actual.bytes === pin.bytes && actual.sha256 === pin.sha256, "pin", `SHA256/length: ${label}`);
  requireCore(actual.gitBlob === pin.gitBlob, "pin", `Git blob: ${label}`);
}
function validSpan(span: Span, limit: number): void {
  validPin(span);
  requireCore(
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
export function assertProgramCoreTypeSpan(source: string | Uint8Array, span: Span, label: string): Buffer {
  const bytes = typeof source === "string" ? Buffer.from(source) : Buffer.from(source);
  validSpan(span, bytes.length);
  const value = bytes.subarray(span.startByte, span.endByte);
  assertProgramCoreTypePin(value, span, label);
  requireCore(
    Buffer.from(bytes.subarray(0, span.startByte).toString("utf8")).equals(bytes.subarray(0, span.startByte)) &&
      Buffer.from(value.toString("utf8")).equals(value),
    "span",
    `split UTF-8 boundary: ${label}`,
  );
  return value;
}
/** Malformed-recipe control; only the fixed digest can authorize reconstruction. */
export function assertProgramCoreTypeRecipe(receipt: ProgramCoreTypeReceipt): void {
  requireCore(
    receipt && receipt.schema === 1 && receipt.kind === "authenticated-live-program-core-type-evolution",
    "receipt",
    "schema/kind",
  );
  requireCore(
    same(receipt.provenance, {
      fixtureRevision: "3a119a88b28bb347f4faaaa2146bd991acf61228",
      introducingCommit: "efe352fee8afc3feb6a28c34d00fc658dc1fb205",
      introducingParent: "efe352fee8afc3feb6a28c34d00fc658dc1fb205^",
      patchSha256: "19b43ecc7cb155dbc00f41388d3923e47b3147aedf4575ee5e53adfb7b474b79",
    }),
    "receipt",
    "provenance",
  );
  requireCore(
    Array.isArray(receipt.inputs) &&
      same(
        receipt.inputs.map((p) => p?.path),
        programCoreTypeInputPaths,
      ) &&
      receipt.output?.path === programCoreTypePath,
    "receipt",
    "input/output domain/order",
  );
  for (const pin of [...receipt.inputs, receipt.output]) validPin(pin);
  for (const [declarations, limit, count] of [
    [receipt.currentDeclarations, receipt.inputs[0]!.bytes, 32],
    [receipt.originalDeclarations, receipt.output.bytes, 29],
  ] as const) {
    requireCore(
      Array.isArray(declarations) && declarations.length === count,
      "role",
      "complete declaration population",
    );
    let end = 0;
    for (const [ordinal, declaration] of declarations.entries()) {
      validSpan(declaration, limit);
      requireCore(
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
  requireCore(
    Array.isArray(receipt.changes) &&
      same(
        receipt.changes.map((c) => c?.role),
        ["binding-import", "support-interface", "support-factory", "support-union", "support-equality"],
      ),
    "receipt",
    "five change roles/order",
  );
  let end = 0,
    removed = 0;
  for (const change of receipt.changes) {
    validSpan(change.current, receipt.inputs[0]!.bytes);
    validSpan(change.originalAnchor, receipt.output.bytes);
    requireCore(
      change.current.bytes > 0 &&
        change.current.startByte >= end &&
        change.originalOffset === change.current.startByte - removed &&
        change.originalAnchor.startByte === change.originalOffset &&
        change.originalAnchor.bytes > 0,
      "span",
      "ordered reciprocal coordinates/anchor",
    );
    end = change.current.endByte;
    removed += change.current.bytes;
  }
  requireCore(
    removed === 1018 && receipt.inputs[0]!.bytes - removed === receipt.output.bytes,
    "span",
    "complete reciprocal length",
  );
}
export function authenticateProgramCoreTypeEvolution(
  text: string = requiredRead(readProgramCoreTypeActual, programCoreTypeReceiptPath),
): ProgramCoreTypeReceipt {
  requireCore(
    typeof text === "string" && programCoreTypePin(text).sha256 === receiptSha256,
    "receipt",
    "fixed digest mismatch",
  );
  const receipt = JSON.parse(text) as ProgramCoreTypeReceipt;
  assertProgramCoreTypeRecipe(receipt);
  return receipt;
}
function requiredRead(reader: ProgramCoreTypeReader, path: string): string {
  let text: string | undefined;
  try {
    text = reader(path);
  } catch (cause) {
    throw new ProgramCoreTypeEvolutionError("missing-source", path, cause);
  }
  requireCore(typeof text === "string", "missing-source", path);
  return text;
}
function parsed(path: string, text: string): ts.SourceFile {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  requireCore(
    !(source as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length,
    "syntax",
    path,
  );
  return source;
}
function name(node: ts.Statement, source: ts.SourceFile): string | null {
  if (ts.isImportDeclaration(node)) return (node.moduleSpecifier as ts.StringLiteral).text;
  if (ts.isVariableStatement(node))
    return node.declarationList.declarations.map((d) => d.name.getText(source)).join(",");
  return "name" in node && node.name ? (node.name as ts.Node).getText(source) : null;
}
function byteAt(text: string, at: number): number {
  return Buffer.byteLength(text.slice(0, at));
}
function uniqueAt(bytes: Buffer, value: Buffer, at: number, label: string): void {
  requireCore(
    value.length > 0 && bytes.indexOf(value) === at && bytes.indexOf(value, at + 1) === -1,
    "span",
    `missing/duplicate/shifted context: ${label}`,
  );
}
/** Full AST census plus the five owned nested roles; does not authorize caller-authored receipts. */
export function assertProgramCoreTypeRoles(
  text: string,
  receipt: ProgramCoreTypeReceipt,
  side: "current" | "original",
): void {
  assertProgramCoreTypeRecipe(receipt);
  const source = parsed(programCoreTypePath, text),
    declarations = side === "current" ? receipt.currentDeclarations : receipt.originalDeclarations;
  requireCore(source.statements.length === declarations.length, "role", "complete AST declaration census");
  for (const expected of declarations) {
    const node = source.statements[expected.ordinal]!;
    requireCore(
      ts.SyntaxKind[node.kind] === expected.kind &&
        name(node, source) === expected.name &&
        byteAt(text, node.getStart(source)) === expected.startByte &&
        byteAt(text, node.end) === expected.endByte,
      "role",
      `declaration ownership ${expected.ordinal}`,
    );
    assertProgramCoreTypePin(node.getText(source), expected, `declaration ${expected.ordinal}`);
  }
  if (side === "original") return;
  const imported = source.statements[5],
    iface = source.statements[8],
    factory = source.statements[9],
    union = source.statements[18],
    equality = source.statements[24];
  requireCore(
    imported &&
      ts.isImportDeclaration(imported) &&
      ts.isStringLiteral(imported.moduleSpecifier) &&
      imported.moduleSpecifier.text === "./binding-key-primitives.js" &&
      imported.importClause &&
      !imported.importClause.isTypeOnly &&
      imported.importClause.namedBindings &&
      ts.isNamedImports(imported.importClause.namedBindings),
    "role",
    "runtime binding import",
  );
  const bindings = imported.importClause.namedBindings.elements;
  requireCore(
    bindings.length === 1 &&
      bindings[0]!.name.text === "requireBindingId" &&
      !bindings[0]!.propertyName &&
      !bindings[0]!.isTypeOnly,
    "role",
    "runtime binding import operand",
  );
  requireCore(
    iface &&
      ts.isInterfaceDeclaration(iface) &&
      iface.name.text === "IrSupportRefType" &&
      factory &&
      ts.isFunctionDeclaration(factory) &&
      factory.name?.text === "irSupportRef" &&
      factory.body,
    "role",
    "support declarations",
  );
  const docs = ts.getJSDocCommentsAndTags(iface);
  requireCore(docs.length === 1 && ts.isJSDoc(docs[0]!), "role", "attached support documentation");
  requireCore(
    union &&
      ts.isTypeAliasDeclaration(union) &&
      union.name.text === "IrType" &&
      ts.isUnionTypeNode(union.type) &&
      ts.isTypeReferenceNode(union.type.types[0]!) &&
      union.type.types[0]!.getText(source) === "IrSupportRefType",
    "role",
    "first union member",
  );
  requireCore(
    equality &&
      ts.isFunctionDeclaration(equality) &&
      equality.name?.text === "irTypeEquals" &&
      equality.body &&
      ts.isIfStatement(equality.body.statements[1]!),
    "role",
    "second equality statement",
  );
  const branch = equality.body.statements[1]!;
  requireCore(
    ts.isIfStatement(branch) && ts.isReturnStatement(branch.thenStatement) && !branch.elseStatement,
    "role",
    "support equality return",
  );
  const intervals = [
    [imported.getStart(source), imported.end + 1],
    [docs[0]!.pos, factory.getStart(source)],
    [factory.getStart(source), factory.end + 2],
    [union.type.types[0]!.getStart(source) - 4, union.type.types[0]!.end + 1],
    [branch.getStart(source) - 2, branch.end + 1],
  ];
  for (const [i, [start, end]] of intervals.entries()) {
    const change = receipt.changes[i]!;
    requireCore(
      byteAt(text, start!) === change.current.startByte && byteAt(text, end!) === change.current.endByte,
      "role",
      `AST-owned span ${change.role}`,
    );
    const bytes = Buffer.from(text),
      value = assertProgramCoreTypeSpan(bytes, change.current, change.role);
    uniqueAt(bytes, value, change.current.startByte, change.role);
  }
}
function capture(reader: ProgramCoreTypeReader, receipt: ProgramCoreTypeReceipt): Map<string, string> {
  const sources = new Map<string, string>();
  for (const input of receipt.inputs) {
    const text = requiredRead(reader, input.path);
    assertProgramCoreTypePin(text, input, input.path);
    parsed(input.path, text);
    sources.set(input.path, text);
  }
  return sources;
}
function forward(current: string, original: string, receipt: ProgramCoreTypeReceipt): void {
  assertProgramCoreTypePin(original, receipt.output, "complete original");
  const before = Buffer.from(original),
    live = Buffer.from(current),
    parts: Buffer[] = [];
  let cursor = 0;
  // Ordered concatenation preserves interface-before-factory at their shared old offset.
  for (const change of receipt.changes) {
    const anchor = assertProgramCoreTypeSpan(before, change.originalAnchor, change.role);
    uniqueAt(before, anchor, change.originalOffset, change.role);
    parts.push(
      before.subarray(cursor, change.originalOffset),
      assertProgramCoreTypeSpan(live, change.current, change.role),
    );
    cursor = change.originalOffset;
  }
  parts.push(before.subarray(cursor));
  const replay = Buffer.concat(parts);
  assertProgramCoreTypePin(replay, receipt.inputs[0]!, "complete replay");
  requireCore(replay.equals(live), "reciprocal", "complete live bytes");
}
/** Exactly one initial historical fixture output, derived solely from freshly captured live source. */
export function reconstructProgramCoreTypeEvolution(
  reader: ProgramCoreTypeReader = readProgramCoreTypeActual,
  receiptText?: string,
): ReadonlyMap<string, string> {
  const receipt = authenticateProgramCoreTypeEvolution(receiptText),
    sources = capture(reader, receipt),
    current = sources.get(programCoreTypePath)!;
  assertProgramCoreTypeRoles(current, receipt, "current");
  const bytes = Buffer.from(current),
    parts: Buffer[] = [];
  let cursor = 0;
  for (const change of receipt.changes) {
    assertProgramCoreTypeSpan(bytes, change.current, change.role);
    parts.push(bytes.subarray(cursor, change.current.startByte));
    cursor = change.current.endByte;
  }
  parts.push(bytes.subarray(cursor));
  const original = Buffer.concat(parts).toString("utf8");
  assertProgramCoreTypePin(original, receipt.output, "complete original");
  assertProgramCoreTypeRoles(original, receipt, "original");
  forward(current, original, receipt);
  return new Map([[programCoreTypePath, original]]);
}
/** Unknown paths are raw; each mapped operation authenticates a fresh complete live capture. */
export function readBeforeProgramCoreTypeEvolution(
  path: string,
  reader: ProgramCoreTypeReader = readProgramCoreTypeActual,
): string {
  if (path !== programCoreTypePath) return requiredRead(reader, path);
  const text = reconstructProgramCoreTypeEvolution(reader).get(path);
  requireCore(typeof text === "string", "missing-source", `required historical output: ${path}`);
  return text;
}
/** A supplied historical mutant must pass full prior pins; current inputs remain freshly authenticated. */
export function verifyProgramCoreTypeReciprocal(
  current: string,
  original: string,
  reader: ProgramCoreTypeReader = readProgramCoreTypeActual,
): void {
  const receipt = authenticateProgramCoreTypeEvolution(),
    sources = capture(reader, receipt);
  assertProgramCoreTypePin(current, receipt.inputs[0]!, "supplied current");
  requireCore(current === sources.get(programCoreTypePath), "reciprocal", "supplied live bytes");
  assertProgramCoreTypeRoles(current, receipt, "current");
  assertProgramCoreTypeRoles(original, receipt, "original");
  forward(current, original, receipt);
}
