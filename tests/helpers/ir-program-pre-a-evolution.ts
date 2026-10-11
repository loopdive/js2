// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";

export const programPreAReceiptPath = "tests/helpers/ir-program-pre-a-evolution.json";
const receiptSha256 = "76b82aab953cd10800aa3fabce9a6b96b6a8e6a1e98204a2ace117bca3e14909";
export const programPreAPaths = Object.freeze([
  "src/ir/identity.ts",
  "src/ir/prepared-component-dependencies.ts",
  "src/ir/program/input-contracts.ts",
  "src/ir/program/prepared-contracts.ts",
]);
export const programPreADependencies = Object.freeze([
  "src/shared/contracts/ir-identity.ts",
  "src/shared/contracts/identity-values.ts",
  "src/ir/identity-values.ts",
  "src/shared/contracts/ir-unit-inventory.ts",
  "src/ir/program/abi-lookup.ts",
  "src/ir/program/runtime-support.ts",
  "src/ir/program/formatter-support.ts",
  "src/ir/program/errors.ts",
  "src/ir/core/types.ts",
]);
export const readProgramPreAActual = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
type Reader = typeof readProgramPreAActual;
export const programPreASha256 = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");
export const programPreAGitBlob = (text: string | Uint8Array): string =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");

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
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly occurrence: number;
  readonly ordinal: number;
}
interface LiveSpan extends Span {
  readonly path: string;
  readonly declaration: Declaration;
}
interface Anchor {
  readonly text: string;
  readonly startByte: number;
}
interface Change {
  readonly label: string;
  readonly current: Span;
  readonly original: Span;
  readonly replacement:
    | { readonly kind: "scaffold"; readonly text: string }
    | { readonly kind: "live"; readonly span: LiveSpan };
  readonly currentAnchor?: Anchor;
  readonly originalAnchor?: Anchor;
}
interface Retained {
  readonly declarations: number;
  readonly functions: number;
  readonly sha256: string;
}
interface Record {
  readonly path: string;
  readonly current: Pin;
  readonly original: Pin;
  readonly changes: readonly Change[];
  readonly retained?: Retained;
}
export interface ProgramPreAEvolutionReceipt {
  readonly schema: number;
  readonly kind: string;
  readonly specSha256: string;
  readonly receiptProvenance: string;
  readonly reconstructedExtractionRevision: string;
  readonly laterCommits: { readonly identity: string; readonly runtimeSupport: string };
  readonly dependencies: readonly (Pin & { readonly path: string })[];
  readonly records: readonly Record[];
}

function fail(detail: string): never {
  throw new Error(`program pre-A evolution: ${detail}`);
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
/** Test component guard; actual reads always use the fixed receipt's pins. */
export function assertProgramPreAPin(text: string | Uint8Array, pin: Pin, label: string): void {
  if (Buffer.byteLength(text) !== pin.bytes || programPreASha256(text) !== pin.sha256)
    fail(`SHA256/length mismatch: ${label}`);
  if (programPreAGitBlob(text) !== pin.gitBlob) fail(`Git blob mismatch: ${label}`);
}
function parsed(path: string, text: string): ts.SourceFile {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((source as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length)
    fail(`syntax mismatch: ${path}`);
  return source;
}
function statements(source: ts.SourceFile): readonly ts.Statement[] {
  return source.statements.filter((s) => !ts.isImportDeclaration(s) && !ts.isExportDeclaration(s));
}
export function programPreARetainedReceipt(path: string, text: string): Retained {
  const source = parsed(path, text),
    nodes = statements(source);
  return {
    declarations: nodes.length,
    functions: nodes.filter(ts.isFunctionDeclaration).length,
    sha256: programPreASha256(JSON.stringify(nodes.map((s) => s.getFullText(source).trim()))),
  };
}
function assertScaffold(text: string): void {
  if (
    parsed("pre-a-scaffold.ts", text).statements.some((s) => !ts.isImportDeclaration(s) && !ts.isExportDeclaration(s))
  )
    fail("executable replacement literal");
}
function uniqueAt(source: Buffer, text: Buffer, at: number, label: string): void {
  if (!text.length || source.indexOf(text) !== at || source.indexOf(text, at + 1) !== -1)
    fail(`missing/duplicate/shifted span or anchor: ${label}`);
}
function exactSpan(source: Buffer, span: Span, label: string): Buffer {
  if (
    !Number.isSafeInteger(span.startByte) ||
    span.startByte < 0 ||
    span.endByte < span.startByte ||
    span.endByte > source.length
  )
    return fail(`invalid byte range: ${label}`);
  const value = source.subarray(span.startByte, span.endByte);
  assertProgramPreAPin(value, span, label);
  if (!Buffer.from(value.toString("utf8")).equals(value)) fail(`split UTF-8 boundary: ${label}`);
  return value;
}

export function authenticateProgramPreAEvolution(
  text = readProgramPreAActual(programPreAReceiptPath),
): ProgramPreAEvolutionReceipt {
  if (programPreASha256(text) !== receiptSha256) fail("receipt digest mismatch");
  const receipt = JSON.parse(text) as ProgramPreAEvolutionReceipt;
  if (
    receipt.schema !== 1 ||
    receipt.kind !== "authenticated-live-program-pre-a-evolution" ||
    receipt.receiptProvenance !== "f95d8a0bf318e857d981863b1018a9d776483a46" ||
    receipt.reconstructedExtractionRevision !== "3a119a88b28bb347f4faaaa2146bd991acf61228" ||
    receipt.laterCommits.identity !== "cb64af7b0315d59d08809e404c1216c846270654" ||
    receipt.laterCommits.runtimeSupport !== "efe352fee8afc3feb6a28c34d00fc658dc1fb205" ||
    !same(
      receipt.records.map((r) => r.path),
      programPreAPaths,
    ) ||
    !same(
      receipt.dependencies.map((r) => r.path),
      programPreADependencies,
    ) ||
    !same(
      receipt.records.map((r) => r.changes.length),
      [4, 3, 2, 2],
    )
  )
    fail("fixed provenance/population mismatch");
  for (const record of receipt.records) {
    let end = 0,
      delta = 0;
    for (const change of record.changes) {
      if (
        change.current.startByte < end ||
        change.original.startByte !== change.current.startByte + delta ||
        change.current.endByte - change.current.startByte !== change.current.bytes ||
        change.original.endByte - change.original.startByte !== change.original.bytes
      )
        fail("fixed change ordering mismatch");
      if (change.replacement.kind === "scaffold") assertScaffold(change.replacement.text);
      else if (
        change.replacement.span.path !== "src/shared/contracts/ir-identity.ts" ||
        !["IrLiftedFunctionArtifactIdentity", "IrLiftedSourceUnitProvenance"].includes(
          change.replacement.span.declaration.name,
        )
      )
        fail("unapproved live interface source");
      if (
        (change.current.bytes === 0) !== !!change.currentAnchor ||
        (change.original.bytes === 0) !== !!change.originalAnchor
      )
        fail("missing exact insertion anchor");
      end = change.current.endByte;
      delta += change.original.bytes - change.current.bytes;
    }
  }
  return receipt;
}

function liveSources(receipt: ProgramPreAEvolutionReceipt, reader: Reader): ReadonlyMap<string, Buffer> {
  const result = new Map<string, Buffer>();
  for (const record of [...receipt.records.map((r) => ({ path: r.path, ...r.current })), ...receipt.dependencies]) {
    const text = reader(record.path);
    if (typeof text !== "string") return fail(`missing live source: ${record.path}`);
    assertProgramPreAPin(text, record, record.path);
    result.set(record.path, Buffer.from(text));
  }
  return result;
}
function liveInterface(span: LiveSpan, sources: ReadonlyMap<string, Buffer>): Buffer {
  const source = sources.get(span.path);
  if (!source) return fail(`missing canonical interface source: ${span.path}`);
  const value = exactSpan(source, span, span.path);
  uniqueAt(source, value, span.startByte, span.path);
  const text = source.toString("utf8"),
    sf = parsed(span.path, text),
    nodes = statements(sf),
    d = span.declaration;
  const matches = nodes.filter((n) => ts.isInterfaceDeclaration(n) && n.name.text === d.name);
  if (
    d.kind !== "InterfaceDeclaration" ||
    d.occurrence !== 0 ||
    matches.length !== 1 ||
    nodes[d.ordinal] !== matches[0]
  )
    return fail("live interface kind/name/occurrence/order mismatch");
  const node = matches[0]!;
  if (
    Buffer.byteLength(text.slice(0, node.getStart(sf))) !== d.startByte ||
    Buffer.byteLength(text.slice(0, node.end)) !== d.endByte ||
    d.startByte < span.startByte ||
    d.endByte > span.endByte
  )
    fail("live interface byte span mismatch");
  assertProgramPreAPin(node.getText(sf), d, d.name);
  return value;
}
function inverse(record: Record, sources: ReadonlyMap<string, Buffer>): Buffer {
  const source = sources.get(record.path)!;
  let cursor = 0;
  const parts: Buffer[] = [];
  for (const change of record.changes) {
    const actual = exactSpan(source, change.current, change.label);
    if (actual.length) uniqueAt(source, actual, change.current.startByte, change.label);
    else uniqueAt(source, Buffer.from(change.currentAnchor!.text), change.currentAnchor!.startByte, change.label);
    const replacement =
      change.replacement.kind === "live"
        ? liveInterface(change.replacement.span, sources)
        : Buffer.from(change.replacement.text);
    assertProgramPreAPin(replacement, change.original, `replacement ${change.label}`);
    parts.push(source.subarray(cursor, change.current.startByte), replacement);
    cursor = change.current.endByte;
  }
  parts.push(source.subarray(cursor));
  const output = Buffer.concat(parts);
  assertProgramPreAPin(output, record.original, `original ${record.path}`);
  if (record.retained && !same(programPreARetainedReceipt(record.path, output.toString("utf8")), record.retained))
    fail(`retained population mismatch: ${record.path}`);
  return output;
}
function forward(record: Record, original: Buffer, sources: ReadonlyMap<string, Buffer>): Buffer {
  const current = sources.get(record.path)!;
  let cursor = 0;
  const parts: Buffer[] = [];
  for (const change of record.changes) {
    const before = exactSpan(original, change.original, `original ${change.label}`);
    if (before.length) uniqueAt(original, before, change.original.startByte, change.label);
    else uniqueAt(original, Buffer.from(change.originalAnchor!.text), change.originalAnchor!.startByte, change.label);
    parts.push(original.subarray(cursor, change.original.startByte), exactSpan(current, change.current, change.label));
    cursor = change.original.endByte;
  }
  parts.push(original.subarray(cursor));
  const result = Buffer.concat(parts);
  assertProgramPreAPin(result, record.current, `replayed ${record.path}`);
  if (!result.equals(current)) fail(`reciprocal current bytes mismatch: ${record.path}`);
  return result;
}

/** Historical source analysis only. The configured compiler must keep reading raw current files. */
export function reconstructProgramPreA(
  reader: Reader = readProgramPreAActual,
  receiptText?: string,
): ReadonlyMap<string, string> {
  const receipt = authenticateProgramPreAEvolution(receiptText),
    sources = liveSources(receipt, reader);
  const result = new Map<string, string>();
  for (const record of receipt.records) {
    const original = inverse(record, sources);
    forward(record, original, sources);
    result.set(record.path, original.toString("utf8"));
  }
  return result;
}
/** Call once before older receipt parsing; never normalize caller-supplied historical mutants. */
export function beforeProgramPreAEvolution(
  path: string,
  source: string,
  reader: Reader = readProgramPreAActual,
): string {
  return programPreAPaths.includes(path)
    ? reconstructProgramPreA((p) => (p === path ? source : reader(p))).get(path)!
    : source;
}
export function readBeforeProgramPreAEvolution(path: string, reader: Reader = readProgramPreAActual): string {
  return programPreAPaths.includes(path) ? reconstructProgramPreA(reader).get(path)! : reader(path);
}
