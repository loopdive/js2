// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { readBeforeIrAllocationProvenanceLookup } from "./ir-allocation-provenance-lookup-successor.js";
import { readBeforeIrAllocationRuleSharing } from "./ir-allocation-rule-sharing-successor.js";

export const irValidationAnalysisReceiptPath = "tests/helpers/ir-validation-analysis-relocation.json";
const receiptSha256 = "9a52664fbba6044d168f428f9398e5d2bff923cf7cac1adc6aae04827431e969";
export const irValidationAnalysisOriginalPaths: readonly string[] = Object.freeze([
  "src/ir/analysis/lattice.ts",
  "src/ir/analysis/ownership.ts",
  "src/ir/analysis/encoding.ts",
  "src/ir/analysis/escape.ts",
  "src/ir/analysis/dominance.ts",
  "src/ir/verify-alloc.ts",
  "src/ir/verify.ts",
  "src/ir/program-allocations.ts",
  "src/ir/program-class-layouts.ts",
]);
export const irValidationAnalysisCurrentPaths: readonly string[] = Object.freeze([
  ...irValidationAnalysisOriginalPaths,
  "src/ir/analysis/alloc-verification.ts",
  "src/ir/runtime/verify.ts",
  "src/ir/program/allocations.ts",
  "src/ir/program/class-layouts.ts",
]);
const readIrValidationAnalysisRaw = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
export const readIrValidationAnalysisActual = (path: string): string =>
  readBeforeIrAllocationProvenanceLookup(path, (requested) =>
    readBeforeIrAllocationRuleSharing(requested, readIrValidationAnalysisRaw),
  );
type Reader = typeof readIrValidationAnalysisActual;
export const irValidationAnalysisSha256 = (source: string | Uint8Array): string =>
  createHash("sha256").update(source).digest("hex");
export const irValidationAnalysisGitBlob = (source: string | Uint8Array): string =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(source)}\0`)
    .update(source)
    .digest("hex");

interface Pin {
  readonly bytes: number;
  readonly sha256: string;
  readonly gitBlob: string;
}
interface Declaration extends Pin {
  readonly path: string;
  readonly kind: string;
  readonly name: string;
  readonly occurrence: number;
  readonly ordinal: number;
  readonly startByte: number;
  readonly statementStartByte: number;
  readonly endByte: number;
}
interface ImportToken extends Pin {
  readonly ordinal: number;
  readonly qualifier: string | null;
  readonly module: string;
  readonly startByte: number;
  readonly endByte: number;
}
interface Transfer {
  readonly id: number;
  readonly before: Declaration;
  readonly current: Declaration;
  readonly inlineImports: readonly { readonly before: ImportToken; readonly current: ImportToken }[];
}
type Piece = { readonly literal: string } | { readonly transfer: number };
interface Record extends Pin {
  readonly path: string;
  readonly declarations: readonly Declaration[];
  readonly recipe: readonly Piece[];
}
export interface IrValidationAnalysisRelocationReceipt {
  readonly schema: number;
  readonly kind: string;
  readonly base: string;
  readonly freezeManifestSha256: string;
  readonly candidateProvenance: string;
  readonly canonicalDeclarationCount: number;
  readonly retainedWrapperNames: readonly string[];
  readonly inlineTypeImportChangeCount: number;
  readonly originals: readonly Record[];
  readonly current: readonly Record[];
  readonly transfers: readonly Transfer[];
}
type Side = "before" | "current";

function fail(detail: string): never {
  throw new Error(`validation analysis relocation: ${detail}`);
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function pin(source: string | Uint8Array): Pin {
  return {
    bytes: Buffer.byteLength(source),
    sha256: irValidationAnalysisSha256(source),
    gitBlob: irValidationAnalysisGitBlob(source),
  };
}
/** Component diagnostic only; readers always supply pins from the fixed authenticated receipt. */
export function assertIrValidationAnalysisSource(source: string | Uint8Array, expected: Pin, label: string): void {
  if (Buffer.byteLength(source) !== expected.bytes || irValidationAnalysisSha256(source) !== expected.sha256)
    fail(`complete SHA256/length mismatch: ${label}`);
  if (irValidationAnalysisGitBlob(source) !== expected.gitBlob) fail(`complete Git blob mismatch: ${label}`);
}
function parsed(path: string, text: string): ts.SourceFile {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // Syntax only. Never construct a Program/checker or execute a captured body.
  if ((source as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length)
    fail(`syntax mismatch: ${path}`);
  return source;
}
function declarations(path: string, text: string): Declaration[] {
  const source = parsed(path, text),
    occurrences = new Map<string, number>();
  return source.statements
    .filter((s) => !ts.isImportDeclaration(s) && !ts.isExportDeclaration(s))
    .map((statement, ordinal) => {
      const name = ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.map((d) => d.name.getText(source)).join(",")
        : (statement as ts.Statement & Pick<ts.NamedDeclaration, "name">).name?.getText(source);
      if (!name) return fail(`unaccounted top-level statement: ${path}`);
      const kind = ts.SyntaxKind[statement.kind],
        key = `${kind}:${name}`,
        occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      const leading = text.slice(statement.getFullStart(), statement.getStart(source));
      const start = statement.getFullStart() + /^\s*/.exec(leading)![0].length;
      return {
        path,
        kind,
        name,
        occurrence,
        ordinal,
        startByte: Buffer.byteLength(text.slice(0, start)),
        statementStartByte: Buffer.byteLength(text.slice(0, statement.getStart(source))),
        endByte: Buffer.byteLength(text.slice(0, statement.end)),
        ...pin(text.slice(start, statement.end)),
      };
    });
}
function importTokens(text: string): ImportToken[] {
  const source = parsed("live-declaration.ts", text),
    tokens: ImportToken[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportTypeNode(node)) {
      if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal))
        fail("nonliteral ImportType module");
      const literal = node.argument.literal;
      tokens.push({
        ordinal: tokens.length,
        qualifier: node.qualifier?.getText(source) ?? null,
        module: literal.text,
        startByte: Buffer.byteLength(text.slice(0, literal.getStart(source))),
        endByte: Buffer.byteLength(text.slice(0, literal.end)),
        ...pin(literal.getText(source)),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return tokens;
}
function assertScaffold(text: string): void {
  if (
    parsed("relocation-scaffold.ts", text).statements.some(
      (s) => !ts.isImportDeclaration(s) && !ts.isExportDeclaration(s),
    )
  )
    fail("literal recipe contains executable or type declarations");
}
function owner(path: string, name: string): string {
  if (path === "src/ir/verify.ts") return "src/ir/runtime/verify.ts";
  if (path === "src/ir/verify-alloc.ts" && !["allocVerifyEnabled", "assertAllocProvenance"].includes(name))
    return "src/ir/analysis/alloc-verification.ts";
  if (path === "src/ir/program-allocations.ts") return "src/ir/program/allocations.ts";
  if (path === "src/ir/program-class-layouts.ts") return "src/ir/program/class-layouts.ts";
  return path;
}
function declarationKey(d: Declaration): string {
  return JSON.stringify([d.path, d.kind, d.name, d.occurrence, d.ordinal]);
}
function spanFits(
  span: { readonly startByte: number; readonly endByte: number; readonly bytes: number },
  length: number,
): boolean {
  return (
    Number.isSafeInteger(span.startByte) &&
    Number.isSafeInteger(span.endByte) &&
    span.startByte >= 0 &&
    span.endByte > span.startByte &&
    span.endByte <= length &&
    span.endByte - span.startByte === span.bytes
  );
}
function assertRecordRecipe(record: Record, side: Side, receipt: IrValidationAnalysisRelocationReceipt): void {
  let cursor = 0;
  const selected: Declaration[] = [];
  for (const piece of record.recipe) {
    if ("literal" in piece) {
      assertScaffold(piece.literal);
      cursor += Buffer.byteLength(piece.literal);
    } else {
      const transfer = receipt.transfers[piece.transfer],
        declaration = transfer?.[side];
      if (!Number.isSafeInteger(piece.transfer) || !transfer || !declaration || declaration.path !== record.path)
        fail(`recipe owner/index mismatch: ${record.path}`);
      if (
        declaration.startByte !== cursor ||
        !spanFits(declaration, record.bytes) ||
        declaration.statementStartByte < declaration.startByte ||
        declaration.statementStartByte >= declaration.endByte
      )
        fail(`recipe declaration offset mismatch: ${record.path}/${declaration.name}`);
      selected.push(declaration);
      cursor = declaration.endByte;
    }
  }
  if (cursor !== record.bytes || !same(selected, record.declarations))
    fail(`recipe order/population mismatch: ${record.path}`);
}

/** Structural diagnostic, not reconstruction authority; actual readers authenticate the fixed digest first. */
export function assertIrValidationAnalysisReceiptStructure(receipt: IrValidationAnalysisRelocationReceipt): void {
  if (
    receipt.schema !== 1 ||
    receipt.kind !== "phase-b-live-validation-analysis-relocation" ||
    receipt.base !== "63c5ce9ae1d5a77591abaff28e27fe974926bf4f" ||
    receipt.freezeManifestSha256 !== "de4e96c0281846e6f62d2bae7814d2e3ddced012de8d23c6613284e765eba39d" ||
    receipt.candidateProvenance !==
      "uncommitted Phase B writer snapshot; no candidate commit or delivery is asserted" ||
    receipt.canonicalDeclarationCount !== 133 ||
    !same(receipt.retainedWrapperNames, ["allocVerifyEnabled", "assertAllocProvenance"]) ||
    receipt.inlineTypeImportChangeCount !== 7 ||
    !same(
      receipt.originals.map((r) => r.path),
      irValidationAnalysisOriginalPaths,
    ) ||
    !same(
      receipt.current.map((r) => r.path),
      irValidationAnalysisCurrentPaths,
    )
  )
    fail("fixed provenance/source population mismatch");
  const before = receipt.originals.flatMap((r) => r.declarations),
    current = receipt.current.flatMap((r) => r.declarations);
  if (
    before.length !== 135 ||
    current.length !== 135 ||
    receipt.transfers.length !== 135 ||
    !same(
      receipt.transfers.map((t) => t.before),
      before,
    ) ||
    new Set(receipt.transfers.map((t) => declarationKey(t.current))).size !== 135 ||
    !current.every((d) => receipt.transfers.some((t) => same(t.current, d)))
  )
    fail("complete declaration transfer population mismatch");
  const edits: readonly unknown[][] = receipt.transfers.flatMap((t) =>
    t.inlineImports.map((e) => [t.before.name, e.before.ordinal, e.before.qualifier]),
  );
  if (
    !same(edits, [
      ["operandIrType", 0, "IrType"],
      ["operandIrType", 1, "IrType"],
      ["binopResultKind", 0, "IrBinop"],
      ["binopOperandKind", 0, "IrBinop"],
      ["unopResultKind", 0, "IrUnop"],
      ["unopOperandKind", 0, "IrUnop"],
      ["constResultKind", 0, "IrConst"],
    ])
  )
    fail("approved ImportType edit population mismatch");
  for (const [index, transfer] of receipt.transfers.entries()) {
    const a = transfer.before,
      b = transfer.current;
    if (
      transfer.id !== index ||
      b.path !== owner(a.path, a.name) ||
      a.kind !== b.kind ||
      a.name !== b.name ||
      a.occurrence !== b.occurrence
    )
      fail("declaration owner/kind/identity mismatch");
    if (!transfer.inlineImports.length && (a.sha256 !== b.sha256 || a.gitBlob !== b.gitBlob || a.bytes !== b.bytes))
      fail("unapproved declaration/body change");
    let beforeEnd = 0,
      currentEnd = 0;
    for (const edit of transfer.inlineImports) {
      const old = edit.before,
        now = edit.current;
      if (
        a.path !== "src/ir/verify.ts" ||
        b.path !== "src/ir/runtime/verify.ts" ||
        a.kind !== "FunctionDeclaration" ||
        old.ordinal !== now.ordinal ||
        old.qualifier !== now.qualifier ||
        old.module !== "./nodes.js" ||
        now.module !== (old.qualifier === "IrType" ? "../core/types.js" : "../core/nodes.js") ||
        !spanFits(old, a.bytes) ||
        !spanFits(now, b.bytes) ||
        old.startByte < beforeEnd ||
        now.startByte < currentEnd
      )
        fail("unapproved ImportType owner/order/span");
      assertIrValidationAnalysisSource(JSON.stringify(old.module), old, "old ImportType token");
      assertIrValidationAnalysisSource(JSON.stringify(now.module), now, "current ImportType token");
      beforeEnd = old.endByte;
      currentEnd = now.endByte;
    }
  }
  for (const record of receipt.originals) assertRecordRecipe(record, "before", receipt);
  for (const record of receipt.current) assertRecordRecipe(record, "current", receipt);
}
function freezeData<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}
export function authenticateIrValidationAnalysisRelocation(
  text = readIrValidationAnalysisActual(irValidationAnalysisReceiptPath),
): IrValidationAnalysisRelocationReceipt {
  if (irValidationAnalysisSha256(text) !== receiptSha256) fail("fixed receipt digest mismatch");
  const receipt = JSON.parse(text) as IrValidationAnalysisRelocationReceipt;
  assertIrValidationAnalysisReceiptStructure(receipt);
  return freezeData(receipt);
}
function checkRecords(records: readonly Record[], sources: ReadonlyMap<string, string>): void {
  for (const record of records) {
    const text = sources.get(record.path);
    if (text === undefined) fail(`missing required source: ${record.path}`);
    assertIrValidationAnalysisSource(text, record, record.path);
    if (!same(declarations(record.path, text), record.declarations))
      fail(`declaration kind/name/occurrence/order/span mismatch: ${record.path}`);
  }
}
function liveSlice(source: string, span: Declaration | ImportToken, label: string): string {
  const bytes = Buffer.from(source);
  if (!spanFits(span, bytes.length)) fail(`invalid live span: ${label}`);
  const result = bytes.subarray(span.startByte, span.endByte);
  if (!Buffer.from(result.toString("utf8")).equals(result)) fail(`split UTF-8 boundary: ${label}`);
  assertIrValidationAnalysisSource(result, span, label);
  return result.toString("utf8");
}
function transferText(transfer: Transfer, sourceSide: Side, sources: ReadonlyMap<string, string>): string {
  const targetSide = sourceSide === "current" ? "before" : "current",
    declaration = transfer[sourceSide];
  const source = sources.get(declaration.path);
  if (source === undefined) return fail(`missing live declaration owner: ${declaration.path}`);
  let text = liveSlice(source, declaration, `${declaration.path}/${declaration.name}`);
  if (transfer.inlineImports.length) {
    const tokens = importTokens(text);
    for (const edit of transfer.inlineImports) {
      const token = edit[sourceSide];
      if (!same(tokens[token.ordinal], token)) fail(`live ImportType role mismatch: ${declaration.name}`);
      liveSlice(text, token, `${declaration.name}/ImportType ${token.ordinal}`);
    }
    let bytes = Buffer.from(text);
    for (const edit of [...transfer.inlineImports].reverse()) {
      const token = edit[sourceSide];
      bytes = Buffer.concat([
        bytes.subarray(0, token.startByte),
        Buffer.from(JSON.stringify(edit[targetSide].module)),
        bytes.subarray(token.endByte),
      ]);
    }
    text = bytes.toString("utf8");
    const targetTokens = importTokens(text);
    for (const edit of transfer.inlineImports)
      if (!same(targetTokens[edit[targetSide].ordinal], edit[targetSide]))
        fail(`reciprocal ImportType role mismatch: ${declaration.name}`);
  }
  assertIrValidationAnalysisSource(text, transfer[targetSide], `transferred ${declaration.name}`);
  return text;
}
function reconstruct(
  records: readonly Record[],
  sourceSide: Side,
  sources: ReadonlyMap<string, string>,
  receipt: IrValidationAnalysisRelocationReceipt,
): Map<string, string> {
  const output = new Map<string, string>();
  for (const record of records) {
    const text = record.recipe
      .map((piece) =>
        "literal" in piece ? piece.literal : transferText(receipt.transfers[piece.transfer]!, sourceSide, sources),
      )
      .join("");
    output.set(record.path, text);
  }
  checkRecords(records, output);
  return output;
}

/** Fresh full live capture, inverse, and reciprocal replay on every mapped read. No successful-validation cache. */
export function reconstructIrValidationAnalysisSources(
  rawReader: Reader = readIrValidationAnalysisActual,
): ReadonlyMap<string, string> {
  const receipt = authenticateIrValidationAnalysisRelocation(rawReader(irValidationAnalysisReceiptPath));
  const current = new Map(irValidationAnalysisCurrentPaths.map((path) => [path, rawReader(path)]));
  checkRecords(receipt.current, current);
  const originals = reconstruct(receipt.originals, "current", current, receipt);
  const replayed = reconstruct(receipt.current, "before", originals, receipt);
  for (const path of irValidationAnalysisCurrentPaths)
    if (replayed.get(path) !== current.get(path)) fail(`reciprocal complete source mismatch: ${path}`);
  return originals;
}
/** Initial historical input transport only. Unknown paths and canonical new owners keep their raw view. */
export function readBeforeIrValidationAnalysisRelocation(
  path: string,
  rawReader: Reader = readIrValidationAnalysisActual,
): string {
  if (!irValidationAnalysisOriginalPaths.includes(path)) return rawReader(path);
  const result = reconstructIrValidationAnalysisSources(rawReader).get(path);
  if (result === undefined) return fail(`missing reconstructed original: ${path}`);
  return result;
}
/** Already historical mutants must go directly to the old assertion, never through this initial-input guard again. */
export function beforeIrValidationAnalysisRelocation(
  path: string,
  source: string,
  rawReader: Reader = readIrValidationAnalysisActual,
): string {
  if (!irValidationAnalysisOriginalPaths.includes(path)) return source;
  return readBeforeIrValidationAnalysisRelocation(path, (requested) =>
    requested === path ? source : rawReader(requested),
  );
}
