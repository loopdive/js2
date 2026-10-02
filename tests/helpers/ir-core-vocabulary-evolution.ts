// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  irSourceContractCurrentPaths,
  irSourceContractDonors,
  reconstructIrSourceContractDonors,
} from "./ir-source-contract-relocation.js";

export const coreVocabularyReceiptPath = "tests/helpers/ir-core-vocabulary-evolution.json";
const receiptSha256 = "61f152a65510005ad6110dc180662ad1d450c3cc2c710d1c8e89ed9fc70f5a9a";
export const coreVocabularyHistoricalPaths = Object.freeze([
  "src/ir/intrinsics.ts",
  "src/ir/core/intrinsic-vocabulary.ts",
  "src/ir/async-runtime-providers.ts",
  "src/ir/core/async-intents.ts",
  "src/ir/string-runtime.ts",
  "src/ir/core/string-types.ts",
  "src/ir/counted-string-append-provenance.ts",
  "src/shared/contracts/ir-counted-string-identity.ts",
]);
export const coreVocabularyCurrentPaths = Object.freeze([
  ...coreVocabularyHistoricalPaths,
  "src/ir/runtime/contracts/intrinsics.ts",
  "src/ir/core/intrinsic-contracts.ts",
  "src/ir/core/intrinsics.ts",
  "src/ir/analysis/intrinsics.ts",
  "src/ir/runtime/async-providers.ts",
  "src/runtime/contracts/async-provider-schema.ts",
  "src/ir/core/string-callables.ts",
]);
export const readCoreVocabularyActual = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
type Reader = typeof readCoreVocabularyActual;
export const coreVocabularySha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
export const coreVocabularyGitBlob = (text: string): string =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
interface Pin {
  readonly bytes: number;
  readonly sha256: string;
  readonly gitBlob: string;
}
interface SourcePin extends Pin {
  readonly path: string;
}
interface Span extends Pin {
  readonly start: number;
  readonly end: number;
}
interface Declaration extends Span {
  readonly path: string;
  readonly ordinal: number;
  readonly name: string;
  readonly kind: string;
  readonly occurrence: number;
  readonly line: number;
}
interface Edit {
  readonly current: Span;
  readonly original: Span;
  readonly replacement: string;
}
interface Transfer {
  readonly current: Declaration;
  readonly original: Declaration;
  readonly edits: readonly Edit[];
}
type Piece =
  | { readonly literal: string }
  | { readonly pinnedCurrentResidue: Declaration }
  | { readonly slice: Declaration; readonly edits: readonly Edit[] }
  | { readonly slice: Declaration; readonly inverseEdits: readonly Edit[] };
interface SourceRecord extends SourcePin {
  readonly declarations: readonly Declaration[];
  readonly recipe: readonly Piece[];
}
interface Rows {
  readonly count: number;
  readonly sha256: string;
}
export interface CoreVocabularyEvolutionReceipt {
  readonly schema: number;
  readonly kind: string;
  readonly currentRev: string;
  readonly originalRev: string;
  readonly preVocabularyRev: string;
  readonly coordinateUnit: string;
  readonly provenanceCommits: readonly string[];
  readonly authoring: {
    readonly specSha256: string;
    readonly phaseAProofSha256: string;
    readonly booleanProofSha256: string;
  };
  readonly phaseA: {
    readonly helper: SourcePin;
    readonly receipt: SourcePin;
    readonly currentOwners: readonly SourcePin[];
    readonly donors: readonly SourcePin[];
  };
  readonly rawOwners: readonly SourcePin[];
  readonly directDependencies: readonly SourcePin[];
  readonly current: readonly SourceRecord[];
  readonly originals: readonly SourceRecord[];
  readonly transfers: readonly Transfer[];
  readonly currentResidues: readonly Declaration[];
  readonly receiptProofs: readonly {
    readonly old: string;
    readonly canonical: string;
    readonly retained: Rows;
    readonly moved: Rows;
    readonly preVocabularyFull: Pin;
    readonly originalPartitionsExact: boolean;
  }[];
  readonly booleanHunks: readonly (Span & { readonly path: string })[];
}
const editedRoles = new Map([
  [
    "src/ir/runtime/contracts/intrinsics.ts:BOOLEAN_BOUNDARY_RUNTIME_FEATURES",
    "c0ce199d2baf1422a12cbe8646db364da3b7e3f8af8c0de5cf6358d077382103",
  ],
  [
    "src/ir/core/intrinsic-contracts.ts:IntrinsicDefinition",
    "55e023985212ddf29bfe3e30e9cdb4934477d00c6b3f858b94aa3d037795f6e5",
  ],
  ["src/ir/core/intrinsics.ts:definition", "27bb02d56a340ef7209d136f07e3a20c1f081a1773c257a1ad60dec4ceda7342"],
  [
    "src/ir/core/intrinsics.ts:INTRINSIC_DEFINITIONS",
    "cc8a3a351c46e49a805366a437c815aaa6f731d0ea2401bdd06899712dcab05b",
  ],
  [
    "src/ir/analysis/intrinsics.ts:signatureMismatch",
    "93ffc1901f970666a0b4e0560226c647f8a4903c40404e2f8f1014a2c12f3387",
  ],
  [
    "src/ir/core/intrinsic-vocabulary.ts:BOOLEAN_BOUNDARY_INTRINSIC_IDS",
    "f4874d722e697029a322b900d31d147e0842ffbaf4fffb69930c34f3bf0c6685",
  ],
]);
function fail(detail: string): never {
  throw new Error(`core vocabulary evolution: ${detail}`);
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function exactKeys(value: object, keys: readonly string[]): void {
  if (!same(Object.keys(value).sort(), [...keys].sort())) fail("unknown or missing recipe fields");
}
function key(d: Declaration): string {
  return JSON.stringify([d.path, d.kind, d.name, d.occurrence]);
}
function required(sources: ReadonlyMap<string, string>, path: string): string {
  const source = sources.get(path);
  return source === undefined ? fail(`missing required captured owner: ${path}`) : source;
}
/** Independent component check; normal reads always take pins from the fixed receipt. */
export function assertCoreVocabularySource(source: string, pin: Pin, label: string): void {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source) !== pin.bytes ||
    coreVocabularySha256(source) !== pin.sha256
  )
    fail(`complete source SHA256/length mismatch: ${label}`);
  if (coreVocabularyGitBlob(source) !== pin.gitBlob) fail(`complete source Git blob mismatch: ${label}`);
}
function parsed(path: string, source: string): ts.SourceFile {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((tree as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length)
    fail(`syntax mismatch: ${path}`);
  return tree;
}
function declarations(path: string, source: string): Declaration[] {
  const tree = parsed(path, source),
    seen = new Map<string, number>();
  return tree.statements
    .filter((n) => !ts.isImportDeclaration(n) && !ts.isExportDeclaration(n))
    .map((node, ordinal) => {
      const kind = ts.SyntaxKind[node.kind],
        name = ts.isVariableStatement(node)
          ? node.declarationList.declarations.map((d) => d.name.getText(tree)).join(",")
          : (node as ts.NamedDeclaration).name?.getText(tree);
      if (!name) return fail(`unnamed declaration: ${path}`);
      const role = `${kind}:${name}`,
        occurrence = seen.get(role) ?? 0,
        text = node.getText(tree);
      seen.set(role, occurrence + 1);
      return {
        path,
        ordinal,
        name,
        kind,
        occurrence,
        start: node.getStart(tree),
        end: node.end,
        line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
        bytes: Buffer.byteLength(text),
        sha256: coreVocabularySha256(text),
        gitBlob: coreVocabularyGitBlob(text),
      };
    });
}
export function coreVocabularyDeclarationReceipt(path: string, source: string): Rows {
  const rows = declarations(path, source).flatMap((d) =>
    d.name.split(",").map((name) => [name, source.slice(d.start, d.end)]),
  );
  return { count: rows.length, sha256: coreVocabularySha256(JSON.stringify(rows)) };
}
function assertScaffold(text: string): void {
  if (parsed("core-scaffold.ts", text).statements.some((n) => !ts.isImportDeclaration(n) && !ts.isExportDeclaration(n)))
    fail("literal recipe contains an executable declaration");
}
function validateEdits(transfer: Transfer): void {
  exactKeys(transfer, ["current", "original", "edits"]);
  const digest = editedRoles.get(`${transfer.current.path}:${transfer.current.name}`);
  if (digest ? coreVocabularySha256(JSON.stringify(transfer.edits)) !== digest : transfer.edits.length !== 0)
    fail("unapproved bounded declaration edit");
  let end = 0,
    delta = 0;
  for (const edit of transfer.edits) {
    exactKeys(edit, ["current", "original", "replacement"]);
    for (const span of [edit.current, edit.original]) exactKeys(span, ["start", "end", "bytes", "sha256", "gitBlob"]);
    if (
      edit.current.start < end ||
      edit.original.start !== edit.current.start + delta ||
      edit.original.end !== edit.original.start + edit.replacement.length
    )
      fail("bounded edit ordering mismatch");
    assertCoreVocabularySource(edit.replacement, edit.original, "bounded replacement");
    end = edit.current.end;
    delta += edit.replacement.length - (edit.current.end - edit.current.start);
  }
}
function validateRecipes(receipt: CoreVocabularyEvolutionReceipt, forward: boolean): void {
  for (const record of forward ? receipt.current : receipt.originals) {
    let ordinal = 0;
    for (const piece of record.recipe) {
      if ("literal" in piece) {
        exactKeys(piece, ["literal"]);
        assertScaffold(piece.literal);
        continue;
      }
      const output = record.declarations[ordinal++];
      if ("pinnedCurrentResidue" in piece) {
        exactKeys(piece, ["pinnedCurrentResidue"]);
        if (
          !forward ||
          !same(output, piece.pinnedCurrentResidue) ||
          !receipt.currentResidues.some((d) => same(d, output))
        )
          fail("unapproved current-only residue");
      } else {
        exactKeys(piece, ["slice", forward ? "inverseEdits" : "edits"]);
        const transfer = receipt.transfers.find((t) => same(forward ? t.original : t.current, piece.slice));
        const edits = "inverseEdits" in piece ? piece.inverseEdits : piece.edits;
        if (!transfer || !same(edits, transfer.edits) || !same(output, forward ? transfer.current : transfer.original))
          fail("recipe transfer/order mismatch");
      }
    }
    if (ordinal !== record.declarations.length) fail(`recipe omitted declarations: ${record.path}`);
  }
}
export function authenticateCoreVocabularyEvolution(
  text = readCoreVocabularyActual(coreVocabularyReceiptPath),
): CoreVocabularyEvolutionReceipt {
  if (coreVocabularySha256(text) !== receiptSha256) fail("receipt digest mismatch");
  const r = JSON.parse(text) as CoreVocabularyEvolutionReceipt;
  if (
    r.schema !== 1 ||
    r.kind !== "live-core-vocabulary-evolution" ||
    r.currentRev !== "1265c47d6fc41300a380ef7e4abc45fdfcfd2c61" ||
    r.originalRev !== "8429806b2abb6a9f04160471170a0659c94bd335" ||
    r.preVocabularyRev !== "acfd3e37b8765c4c4788c1fa94718d62c60e473c" ||
    r.coordinateUnit !== "UTF-16 code units, end exclusive; full lengths are UTF-8 bytes" ||
    !same(
      r.originals.map((o) => o.path),
      coreVocabularyHistoricalPaths,
    ) ||
    !same(
      r.current.map((o) => o.path),
      coreVocabularyCurrentPaths,
    ) ||
    !same(
      r.phaseA.currentOwners.map((o) => o.path),
      irSourceContractCurrentPaths,
    ) ||
    !same(
      r.phaseA.donors.map((o) => o.path),
      irSourceContractDonors,
    ) ||
    r.rawOwners.length !== 51 ||
    new Set(r.rawOwners.map((o) => o.path)).size !== 51 ||
    r.directDependencies.length !== 13 ||
    r.currentResidues.length !== 4 ||
    r.booleanHunks.length !== 6 ||
    r.receiptProofs.length !== 4
  )
    fail("fixed provenance/population mismatch");
  const before = r.originals.flatMap((o) => o.declarations),
    after = r.current.flatMap((o) => o.declarations);
  if (
    before.length !== 164 ||
    after.length !== 168 ||
    r.transfers.length !== 164 ||
    !same(
      r.transfers.map((t) => t.original),
      before,
    ) ||
    new Set([...r.transfers.map((t) => key(t.current)), ...r.currentResidues.map(key)]).size !== 168 ||
    !after.every((d) => r.transfers.some((t) => same(t.current, d)) || r.currentResidues.some((v) => same(v, d))) ||
    r.transfers.filter((t) => t.edits.length).length !== editedRoles.size
  )
    fail("exact role population mismatch");
  r.transfers.forEach(validateEdits);
  validateRecipes(r, false);
  validateRecipes(r, true);
  return r;
}
function capture(r: CoreVocabularyEvolutionReceipt, reader: Reader): ReadonlyMap<string, string> {
  const raw = new Map<string, string>();
  for (const record of r.rawOwners) {
    const source = reader(record.path);
    assertCoreVocabularySource(source, record, record.path);
    raw.set(record.path, source);
  }
  return raw;
}
function beforePhaseA(
  r: CoreVocabularyEvolutionReceipt,
  raw: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  // One invocation authenticates the existing exact Phase A issuer and its reciprocal population.
  const restored = reconstructIrSourceContractDonors((p) => required(raw, p), required(raw, r.phaseA.receipt.path));
  for (const donor of r.phaseA.donors)
    assertCoreVocabularySource(required(restored, donor.path), donor, `Phase A ${donor.path}`);
  const stage = new Map<string, string>();
  for (const record of [...r.current, ...r.directDependencies]) {
    const source = required(irSourceContractDonors.includes(record.path) ? restored : raw, record.path);
    assertCoreVocabularySource(source, record, `pre-A ${record.path}`);
    stage.set(record.path, source);
  }
  return stage;
}
function assertRecords(records: readonly SourceRecord[], sources: ReadonlyMap<string, string>): void {
  for (const record of records) {
    const source = required(sources, record.path);
    assertCoreVocabularySource(source, record, record.path);
    if (!same(declarations(record.path, source), record.declarations))
      fail(`declaration kind/name/occurrence/order/span mismatch: ${record.path}`);
  }
}
function exactSlice(source: string, span: Span, label: string): string {
  if (
    !Number.isSafeInteger(span.start) ||
    !Number.isSafeInteger(span.end) ||
    span.start < 0 ||
    span.end < span.start ||
    span.end > source.length
  )
    return fail(`invalid slice coordinates: ${label}`);
  const text = source.slice(span.start, span.end);
  assertCoreVocabularySource(text, span, label);
  return text;
}
function liveDeclaration(d: Declaration, sources: ReadonlyMap<string, string>): string {
  return exactSlice(required(sources, d.path), d, `${d.path}/${d.name}`);
}
function editedDeclaration(
  t: Transfer,
  current: ReadonlyMap<string, string>,
  originals?: ReadonlyMap<string, string>,
): string {
  const live = liveDeclaration(t.current, current),
    original = originals ? liveDeclaration(t.original, originals) : undefined;
  let cursor = 0,
    result = "";
  for (const e of t.edits) {
    const actual = exactSlice(live, e.current, t.current.name);
    if (original === undefined) {
      result += live.slice(cursor, e.current.start) + e.replacement;
      cursor = e.current.end;
    } else {
      if (exactSlice(original, e.original, t.original.name) !== e.replacement) fail("reverse replacement mismatch");
      result += original.slice(cursor, e.original.start) + actual;
      cursor = e.original.end;
    }
  }
  result += (original ?? live).slice(cursor);
  assertCoreVocabularySource(result, originals ? t.current : t.original, `edited ${t.current.name}`);
  return result;
}
function assemble(
  r: CoreVocabularyEvolutionReceipt,
  current: ReadonlyMap<string, string>,
  originals?: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const record of originals ? r.current : r.originals) {
    const text = record.recipe
      .map((piece) => {
        if ("literal" in piece) return piece.literal;
        if ("pinnedCurrentResidue" in piece) return liveDeclaration(piece.pinnedCurrentResidue, current);
        const t = r.transfers.find((t) => same(originals ? t.original : t.current, piece.slice));
        if (!t) return fail("missing exact transfer");
        return editedDeclaration(t, current, originals);
      })
      .join("");
    result.set(record.path, text);
  }
  assertRecords(originals ? r.current : r.originals, result);
  return result;
}
/** Historical receipt analysis only. Never install this reader in the actual compiler host. */
export function reconstructCoreVocabularyReceiptSources(
  reader: Reader = readCoreVocabularyActual,
  receiptText?: string,
): ReadonlyMap<string, string> {
  const r = authenticateCoreVocabularyEvolution(receiptText),
    raw = capture(r, reader),
    current = beforePhaseA(r, raw);
  assertRecords(r.current, current);
  const originals = assemble(r, current),
    replay = assemble(r, current, originals);
  for (const record of r.current)
    if (required(replay, record.path) !== required(current, record.path))
      fail(`reciprocal current bytes mismatch: ${record.path}`);
  for (const proof of r.receiptProofs) {
    if (
      !same(coreVocabularyDeclarationReceipt(proof.old, required(originals, proof.old)), proof.retained) ||
      !same(coreVocabularyDeclarationReceipt(proof.canonical, required(originals, proof.canonical)), proof.moved)
    )
      fail("original moved/retained receipt mismatch");
  }
  return originals;
}
/** Normalize only a genuine initial current read, before older parsers receive mutation inputs. */
export function beforeCoreVocabularyReceiptSource(
  path: string,
  source: string,
  reader: Reader = readCoreVocabularyActual,
): string {
  return coreVocabularyHistoricalPaths.includes(path)
    ? required(
        reconstructCoreVocabularyReceiptSources((p) => (p === path ? source : reader(p))),
        path,
      )
    : source;
}
export function readCoreVocabularyReceiptSource(path: string, reader: Reader = readCoreVocabularyActual): string {
  return coreVocabularyHistoricalPaths.includes(path)
    ? required(reconstructCoreVocabularyReceiptSources(reader), path)
    : reader(path);
}
