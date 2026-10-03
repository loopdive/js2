// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";

export const irSourceContractRelocationReceiptPath = "tests/helpers/ir-source-contract-relocation.json";
const receiptSha256 = "0b8fefeeae71e66e2b95726320609d60427cbc7ef4f7ce53a8c094d8a971940b";
export const irSourceContractDonorOwners = Object.freeze([
  ["src/ir/outcomes.ts", "src/shared/contracts/ir-preparation-errors.ts"],
  ["src/ir/abi-bindings.ts", "src/ir/core/global-binding-keys.ts"],
  ["src/ir/declared-types.ts", "src/ir/core/declared-types.ts"],
  ["src/ir/fnctor-abi.ts", "src/ir/core/fnctor-abi.ts"],
  ["src/ir/tag-domain.ts", "src/ir/core/tag-domain.ts"],
  ["src/ir/js-tag-domain.ts", "src/ir/runtime/js-tag-domain.ts"],
  ["src/ir/producer.ts", "src/ir/runtime/producer.ts"],
  ["src/ir/string-runtime.ts", "src/ir/core/string-runtime.ts"],
  ["src/ir/counted-string-append-provenance.ts", "src/shared/contracts/ir-counted-string-site-id.ts"],
  ["src/string-surrogate.ts", "src/shared/contracts/string-surrogate.ts"],
  ["src/ir/runtime-symbols.ts", "src/ir/core/runtime-symbols.ts"],
  ["src/ir/date-runtime.ts", "src/ir/core/date-callables.ts"],
  ["src/ir/ast-lowering-plans.ts", "src/ir/core/date-callables.ts"],
] as const);
export const irSourceContractDonors: readonly string[] = Object.freeze(
  irSourceContractDonorOwners.map(([donor]) => donor),
);
export const irSourceContractOwners: readonly string[] = Object.freeze([
  ...new Set(irSourceContractDonorOwners.map(([, owner]) => owner)),
]);
export const irSourceContractCurrentPaths: readonly string[] = Object.freeze([
  ...irSourceContractDonors,
  ...irSourceContractOwners,
]);
export const readIrSourceContractActual = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
type Reader = typeof readIrSourceContractActual;
export const irSourceContractSha256 = (source: string): string => createHash("sha256").update(source).digest("hex");
export const irSourceContractGitBlob = (source: string): string =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(source)}\0`)
    .update(source)
    .digest("hex");

interface SourcePin {
  readonly sha256: string;
  readonly gitBlob: string;
  readonly bytes: number;
}
interface Declaration {
  readonly path: string;
  readonly kind: string;
  readonly name: string;
  readonly occurrence: number;
  readonly start: number;
  readonly end: number;
  readonly sha256: string;
}
type Transform = "remove-require-string-export" | "add-require-string-export";
type Piece = { readonly literal: string } | { readonly slice: Declaration; readonly transform?: Transform };
interface Record extends SourcePin {
  readonly path: string;
  readonly declarations: readonly Declaration[];
  readonly recipe: readonly Piece[];
}
interface Transfer {
  readonly before: Declaration;
  readonly after: Declaration;
  readonly moved: boolean;
  readonly transform: "remove-require-string-export" | null;
}
export interface IrSourceContractRelocationReceipt {
  readonly schema: number;
  readonly kind: string;
  readonly base: string;
  readonly candidateProvenance: string;
  readonly donorOwners: readonly { readonly donor: string; readonly owner: string }[];
  readonly transfers: readonly Transfer[];
  readonly originals: readonly Record[];
  readonly current: readonly Record[];
}

function fail(detail: string): never {
  throw new Error(`source contract relocation: ${detail}`);
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function key(row: Declaration): string {
  return JSON.stringify([row.path, row.kind, row.name, row.occurrence]);
}

/** Component guard; reconstruction always supplies a pin from the fixed authenticated receipt. */
export function assertIrSourceContractSource(source: string, pin: SourcePin, label: string): void {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source) !== pin.bytes ||
    irSourceContractSha256(source) !== pin.sha256
  )
    fail(`complete source SHA256/length mismatch: ${label}`);
  if (irSourceContractGitBlob(source) !== pin.gitBlob) fail(`complete source Git blob mismatch: ${label}`);
}

function parsed(path: string, text: string): ts.SourceFile {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // This is syntax parsing only: no Program, checker, transpilation or execution.
  if ((source as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length)
    fail(`source syntax mismatch: ${path}`);
  return source;
}
function declarations(path: string, text: string): Declaration[] {
  const source = parsed(path, text),
    occurrences = new Map<string, number>();
  return source.statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) return [];
    const name = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.map((row) => row.name.getText(source)).join(",")
      : (statement as ts.NamedDeclaration).name?.getText(source);
    if (!name) return fail(`unnamed executable declaration: ${path}`);
    const kind = ts.SyntaxKind[statement.kind],
      identity = `${kind}:${name}`;
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return [
      {
        path,
        kind,
        name,
        occurrence,
        start: statement.getStart(source),
        end: statement.end,
        sha256: irSourceContractSha256(statement.getText(source)),
      },
    ];
  });
}
function assertScaffold(text: string): void {
  if (
    parsed("relocation-scaffold.ts", text).statements.some(
      (s) => !ts.isImportDeclaration(s) && !ts.isExportDeclaration(s),
    )
  )
    fail("literal recipe contains an executable declaration");
}

export function authenticateIrSourceContractRelocation(
  text = readIrSourceContractActual(irSourceContractRelocationReceiptPath),
): IrSourceContractRelocationReceipt {
  if (irSourceContractSha256(text) !== receiptSha256) fail("receipt digest mismatch");
  const receipt = JSON.parse(text) as IrSourceContractRelocationReceipt;
  if (
    receipt.schema !== 1 ||
    receipt.kind !== "phase-a-live-source-declaration-relocation" ||
    receipt.base !== "a8cd258d553278d8e5f908878f56a81377ba8e40" ||
    receipt.candidateProvenance !== "uncommitted Phase A writer snapshot; no candidate commit is asserted" ||
    !same(
      receipt.donorOwners,
      irSourceContractDonorOwners.map(([donor, owner]) => ({ donor, owner })),
    ) ||
    !same(
      receipt.originals.map((r) => r.path),
      irSourceContractDonors,
    ) ||
    !same(
      receipt.current.map((r) => r.path),
      irSourceContractCurrentPaths,
    )
  )
    fail("fixed provenance/population mismatch");
  const before = receipt.originals.flatMap((r) => r.declarations),
    after = receipt.current.flatMap((r) => r.declarations);
  if (
    before.length !== 184 ||
    after.length !== 184 ||
    receipt.transfers.length !== 184 ||
    receipt.transfers.filter((r) => r.moved).length !== 115 ||
    !same(
      receipt.transfers.map((r) => r.before),
      before,
    ) ||
    new Set(receipt.transfers.map((r) => key(r.after))).size !== after.length ||
    !after.every((d) => receipt.transfers.some((r) => same(r.after, d)))
  )
    fail("exact declaration transfer population mismatch");
  for (const record of [...receipt.originals, ...receipt.current]) {
    for (const piece of record.recipe) if ("literal" in piece) assertScaffold(piece.literal);
    if (record.recipe.filter((p) => "slice" in p).length !== record.declarations.length)
      fail(`recipe declaration population mismatch: ${record.path}`);
  }
  return receipt;
}

function checkedSources(records: readonly Record[], reader: Reader): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of records) {
    const source = reader(row.path);
    assertIrSourceContractSource(source, row, row.path);
    if (!same(declarations(row.path, source), row.declarations))
      fail(`declaration kind/name/occurrence/span mismatch: ${row.path}`);
    result.set(row.path, source);
  }
  return result;
}

function declarationSlice(
  piece: Exclude<Piece, { readonly literal: string }>,
  sources: ReadonlyMap<string, string>,
): string {
  const d = piece.slice,
    source = sources.get(d.path);
  if (source === undefined) return fail(`missing live declaration owner: ${d.path}`);
  let text = source.slice(d.start, d.end);
  if (irSourceContractSha256(text) !== d.sha256) fail(`live declaration slice mismatch: ${d.path}/${d.name}`);
  if (piece.transform) {
    const removing = piece.transform === "remove-require-string-export";
    if (
      d.kind !== "FunctionDeclaration" ||
      d.name !== "requireString" ||
      d.occurrence !== 0 ||
      d.path !== (removing ? "src/ir/core/global-binding-keys.ts" : "src/ir/abi-bindings.ts") ||
      !text.startsWith(removing ? "export function requireString(" : "function requireString(")
    )
      fail("unapproved declaration edit");
    text = removing ? text.slice("export ".length) : `export ${text}`;
  }
  return text;
}
function reconstruct(records: readonly Record[], sources: ReadonlyMap<string, string>): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of records) {
    const text = row.recipe
      .map((piece) => ("literal" in piece ? piece.literal : declarationSlice(piece, sources)))
      .join("");
    assertIrSourceContractSource(text, row, `reconstructed ${row.path}`);
    if (!same(declarations(row.path, text), row.declarations))
      fail(`reconstructed declaration population mismatch: ${row.path}`);
    result.set(row.path, text);
  }
  return result;
}

/** All executable text comes from current owner slices, then every owner is replayed from the inverse. */
export function reconstructIrSourceContractDonors(
  reader: Reader = readIrSourceContractActual,
  receiptText?: string,
): ReadonlyMap<string, string> {
  const receipt = authenticateIrSourceContractRelocation(receiptText);
  const actual = checkedSources(receipt.current, reader);
  const original = reconstruct(receipt.originals, actual);
  const replayed = reconstruct(receipt.current, original);
  for (const [path, source] of actual)
    if (replayed.get(path) !== source) fail(`reciprocal current source mismatch: ${path}`);
  return original;
}

/** Apply exactly once at the initial live read; historical mutation inputs must bypass this transport. */
export function beforeIrSourceContractRelocation(
  path: string,
  source: string,
  reader: Reader = readIrSourceContractActual,
): string {
  if (!irSourceContractDonors.includes(path)) return source;
  return reconstructIrSourceContractDonors((p) => (p === path ? source : reader(p))).get(path)!;
}
export function readBeforeIrSourceContractRelocation(
  path: string,
  reader: Reader = readIrSourceContractActual,
): string {
  return irSourceContractDonors.includes(path) ? reconstructIrSourceContractDonors(reader).get(path)! : reader(path);
}
