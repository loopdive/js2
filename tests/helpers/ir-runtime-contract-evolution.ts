// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";

export const runtimeContractReceiptPath = "tests/helpers/ir-runtime-contract-evolution.json";
const receiptSha256 = "f7c21adce97a49db5b05106e8da21217be8c96c70133bf8d425054e38b7adafc";
export const runtimeContractCurrentPaths = Object.freeze([
  "src/runtime/contracts/provider-policy.ts",
  "src/ir/runtime/contracts/manifest.ts",
  "src/ir/intrinsics.ts",
  "src/ir/core/intrinsic-vocabulary.ts",
  "src/ir/runtime/contracts/intrinsics.ts",
  "src/ir/core/intrinsics.ts",
  "src/ir/analysis/intrinsics.ts",
  "src/ir/runtime/callable-declarations.ts",
  "src/ir/runtime/manifest.ts",
  "src/ir/intrinsic-support.ts",
  "src/ir/program-runtime-abi.ts",
  "src/ir/program/runtime-abi-identity.ts",
  "src/ir/runtime-program-manifest.ts",
  "src/ir/core/vector-runtime.ts",
  "src/ir/vector-runtime.ts",
  "src/ir/runtime/vector-callables.ts",
  "src/ir/program-runtime-validation.ts",
  "src/ir/core/async-callables.ts",
  "src/ir/runtime/native-async-callables.ts",
  "src/ir/core/intrinsic-contracts.ts",
  "src/ir/core/async-intents.ts",
  "src/ir/runtime/async-providers.ts",
  "src/ir/analysis/async-plan.ts",
  "src/ir/runtime/async-attachment.ts",
  "src/ir/runtime/intrinsic-verification.ts",
  "src/runtime/contracts/async-provider-schema.ts",
  "src/ir/runtime/contracts/prepared.ts",
]);
export const readRuntimeContractActual = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
type Reader = typeof readRuntimeContractActual;
export const runtimeContractSha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
export const runtimeContractGitBlob = (text: string): string =>
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
  readonly start: number;
  readonly end: number;
}
interface SourceSpan extends Span {
  readonly path: string;
}
interface Declaration extends SourceSpan {
  readonly ordinal: number;
  readonly name: string;
  readonly kind: string;
  readonly occurrence: number;
  readonly fullStart: number;
  readonly fullText: Pin;
}
interface Link extends Span {
  readonly kind: string;
}
interface TokenRole {
  readonly ordinal: number;
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  readonly sha256: string;
  readonly parents: readonly { readonly kind: string; readonly start: number; readonly end: number }[];
}
type Piece =
  | {
      readonly kind: "literal";
      readonly category: "whitespace" | "comment" | "module-link";
      readonly text: string;
      readonly targetStart: number;
    }
  | { readonly kind: "abi-functions"; readonly source: SourceSpan; readonly targetStart: number }
  | {
      readonly kind: "live";
      readonly source: SourceSpan;
      readonly scope: SourceSpan & { readonly owner?: Declaration };
      readonly tokens: { readonly first: TokenRole; readonly last: TokenRole };
      readonly targetStart: number;
    };
interface Edit {
  readonly ordinal: number;
  readonly kind: "fixed-reviewed-delta" | "live-donor-splice-required";
  readonly current: Span;
  readonly target: Span;
  readonly recipe: readonly Piece[];
}
interface SourcePin extends Pin {
  readonly path: string;
  readonly declarations: readonly Declaration[];
  readonly links: readonly Link[];
}
interface Record {
  readonly path: string;
  readonly current: SourcePin;
  readonly target: SourcePin;
  readonly spans: readonly Edit[];
}
export interface RuntimeContractEvolutionReceipt {
  readonly schema: number;
  readonly kind: string;
  readonly head: string;
  readonly golden: string;
  readonly booleanBeforeStage: string;
  readonly coordinateUnit: string;
  readonly authoring: {
    readonly priorSpecSha256: string;
    readonly joinsSpecSha256: string;
    readonly compatibilityProofSha256: string;
    // Authoring provenance only: the existing suite's reader plumbing may evolve.
    readonly requirementSource: Pin & { readonly path: string };
  };
  readonly provenance: readonly {
    readonly commit: string;
    readonly parents: readonly string[];
    readonly diffSha256: string;
  }[];
  readonly paths: readonly string[];
  readonly records: readonly Record[];
  readonly abiDonor: {
    readonly path: string;
    readonly source: Pin;
    readonly links: readonly Link[];
    readonly declarations: readonly Declaration[];
    readonly functions: SourceSpan;
  };
  readonly currentResidues: readonly Declaration[];
  readonly goldenReceipts: readonly { readonly path: string; readonly linkHash: string; readonly ownerHash?: string }[];
  readonly historicalReceipts: readonly {
    readonly path: string;
    readonly count: number;
    readonly functions: number;
    readonly sha256: string;
    readonly order: readonly (readonly [string, string, string, number])[];
  }[];
  readonly runtime75SourceRequirements: readonly {
    readonly path: string;
    readonly count: number;
    readonly sha256: string;
    readonly expected: string;
  }[];
}
interface Analysis {
  readonly declarations: readonly Declaration[];
  readonly links: readonly Link[];
  readonly tokens: readonly TokenRole[];
  readonly comments: readonly { readonly start: number; readonly end: number }[];
}
const abiPath = "src/ir/program/runtime-abi-identity.ts";
const callablePath = "src/ir/runtime/callable-declarations.ts";
const manifestPath = "src/ir/runtime/manifest.ts";
const callableRoles = [
  "SEMANTIC_CALLABLE_RUNTIME_PROVIDERS",
  "semanticCallableProviderMismatch",
  "semanticCallablePolicyMismatch",
];
function fail(detail: string): never {
  throw new Error(`runtime contract evolution: ${detail}`);
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function required<T>(values: ReadonlyMap<string, T>, path: string): T {
  const value = values.get(path);
  return value === undefined ? fail(`missing required captured source: ${path}`) : value;
}
function pin(text: string): Pin {
  return { bytes: Buffer.byteLength(text), sha256: runtimeContractSha256(text), gitBlob: runtimeContractGitBlob(text) };
}
/** The normal reader takes every pin from the fixed receipt, never from its caller. */
export function assertRuntimeContractSource(source: string, expected: Pin, label: string): void {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source) !== expected.bytes ||
    runtimeContractSha256(source) !== expected.sha256
  )
    fail(`complete source SHA256/length mismatch: ${label}`);
  if (runtimeContractGitBlob(source) !== expected.gitBlob) fail(`complete source Git blob mismatch: ${label}`);
}
function analyze(path: string, source: string): Analysis {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((tree as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length)
    fail(`syntax mismatch: ${path}`);
  const occurrences = new Map<string, number>();
  const declarations = tree.statements
    .filter((node) => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
    .map((node, ordinal) => {
      const kind = ts.SyntaxKind[node.kind];
      const name = ts.isVariableStatement(node)
        ? node.declarationList.declarations.map((d) => d.name.getText(tree)).join(",")
        : (node as ts.Statement & { readonly name?: ts.Node }).name?.getText(tree);
      if (!name) return fail(`unnamed declaration: ${path}`);
      const key = `${kind}:${name}`,
        occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      return {
        path,
        ordinal,
        name,
        kind,
        occurrence,
        start: node.getStart(tree),
        end: node.end,
        fullStart: node.getFullStart(),
        ...pin(node.getText(tree)),
        fullText: pin(node.getFullText(tree)),
      };
    });
  const links = tree.statements
    .filter((node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    .map((node) => ({
      start: node.getStart(tree),
      end: node.end,
      kind: ts.SyntaxKind[node.kind],
      ...pin(node.getText(tree)),
    }));
  const tokens: TokenRole[] = [];
  function visit(node: ts.Node): void {
    const children = node.getChildren(tree);
    if (children.length) {
      children.forEach(visit);
      return;
    }
    if (node.kind === ts.SyntaxKind.EndOfFileToken || node.end <= node.getStart(tree)) return;
    const parents: TokenRole["parents"][number][] = [];
    for (let parent = node.parent; parent && parent !== tree; parent = parent.parent)
      if (parent.kind !== ts.SyntaxKind.SyntaxList)
        parents.push({ kind: ts.SyntaxKind[parent.kind], start: parent.getStart(tree), end: parent.end });
    tokens.push({
      ordinal: tokens.length,
      kind: ts.SyntaxKind[node.kind],
      start: node.getStart(tree),
      end: node.end,
      sha256: runtimeContractSha256(node.getText(tree)),
      parents,
    });
  }
  visit(tree);
  const comments = new Map<string, { start: number; end: number }>();
  function comment(node: ts.Node): void {
    for (const range of ts.getLeadingCommentRanges(source, node.pos) ?? [])
      comments.set(`${range.pos}:${range.end}`, { start: range.pos, end: range.end });
    ts.forEachChild(node, comment);
  }
  comment(tree);
  return { declarations, links, tokens, comments: [...comments.values()] };
}
function assertAnalysis(record: SourcePin, source: string): Analysis {
  assertRuntimeContractSource(source, record, record.path);
  const actual = analyze(record.path, source);
  if (!same(actual.declarations, record.declarations) || !same(actual.links, record.links))
    fail(`complete declaration/docs/link/order/span census mismatch: ${record.path}`);
  return actual;
}
function slice(source: string, span: Span, label: string): string {
  if (
    !Number.isSafeInteger(span.start) ||
    !Number.isSafeInteger(span.end) ||
    span.start < 0 ||
    span.end <= span.start ||
    span.end > source.length
  )
    return fail(`invalid exact span: ${label}`);
  const result = source.slice(span.start, span.end);
  assertRuntimeContractSource(result, span, label);
  return result;
}
function uniqueSlice(source: string, span: Span, label: string): string {
  const text = slice(source, span, label);
  if (source.indexOf(text) !== span.start || source.indexOf(text, span.start + 1) !== -1)
    fail(`nonunique or shifted contextual span: ${label}`);
  return text;
}
export function authenticateRuntimeContractEvolution(
  text = readRuntimeContractActual(runtimeContractReceiptPath),
): RuntimeContractEvolutionReceipt {
  if (typeof text !== "string" || runtimeContractSha256(text) !== receiptSha256) fail("receipt digest mismatch");
  const r = JSON.parse(text) as RuntimeContractEvolutionReceipt;
  if (
    r.schema !== 1 ||
    r.kind !== "live-runtime-contract-evolution" ||
    r.head !== "1265c47d6fc41300a380ef7e4abc45fdfcfd2c61" ||
    r.golden !== "6ed68535323e0756c3a0b15dde18fd480ad7fc9f" ||
    r.booleanBeforeStage !== "545923d1c9b0a30476f5a6e0dd7f5078be3c25c0" ||
    r.coordinateUnit !== "UTF-16 code units; source lengths are UTF-8 bytes" ||
    !same(r.paths, runtimeContractCurrentPaths) ||
    !same(
      r.records.map((record) => record.path),
      r.paths,
    ) ||
    r.records.some((record) => record.current.path !== record.path || record.target.path !== record.path) ||
    r.records.filter((record) => record.spans.length).length !== 11 ||
    r.records.reduce((n, record) => n + record.spans.length, 0) !== 34 ||
    r.currentResidues.length !== 8 ||
    r.goldenReceipts.length !== 10 ||
    r.goldenReceipts.filter((record) => record.ownerHash).length !== 5 ||
    r.abiDonor.path !== abiPath ||
    !same(
      r.abiDonor.declarations.map((d) => d.name),
      ["preparedIrRuntimeAbiAnchor", "preparedIrRuntimeCallableBindingId"],
    ) ||
    r.abiDonor.links.length !== 6
  )
    fail("fixed provenance/population mismatch");
  return r;
}
function capture(r: RuntimeContractEvolutionReceipt, reader: Reader): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  for (const record of r.records) {
    const text = reader(record.path);
    assertRuntimeContractSource(text, record.current, record.path);
    sources.set(record.path, text);
  }
  return sources;
}
function livePiece(
  piece: Exclude<Piece, { readonly kind: "literal" }>,
  record: Record,
  edit: Edit,
  r: RuntimeContractEvolutionReceipt,
  sources: ReadonlyMap<string, string>,
  analyses: ReadonlyMap<string, Analysis>,
): string {
  const source = required(sources, piece.source.path);
  if (piece.kind === "abi-functions") {
    if (
      record.path !== "src/ir/program-runtime-abi.ts" ||
      edit.kind !== "live-donor-splice-required" ||
      !same(piece.source, r.abiDonor.functions)
    )
      return fail("unapproved live ABI donor splice");
    return slice(source, piece.source, "actual ABI function bodies");
  }
  const scope = piece.scope;
  if (scope.path !== piece.source.path || piece.source.start < scope.start || piece.source.end > scope.end)
    fail("live slice escaped its authenticated owner");
  slice(source, scope, "live scope");
  if (scope.owner) {
    const owner = required(analyses, scope.path).declarations[scope.owner.ordinal];
    if (
      !owner ||
      !same(owner, scope.owner) ||
      scope.start !== owner.fullStart ||
      scope.end !== owner.end ||
      (!(scope.path === record.path && scope.start < edit.current.end && scope.end > edit.current.start) &&
        !(record.path === manifestPath && scope.path === callablePath && callableRoles.includes(owner.name)))
    )
      fail("unapproved declaration operand scope");
  } else if (scope.path !== record.path || scope.start !== edit.current.start || scope.end !== edit.current.end)
    fail("unapproved current context operand scope");
  const tokens = required(analyses, scope.path).tokens;
  if (
    !same(tokens[piece.tokens.first.ordinal], piece.tokens.first) ||
    !same(tokens[piece.tokens.last.ordinal], piece.tokens.last) ||
    piece.tokens.first.ordinal > piece.tokens.last.ordinal ||
    piece.source.start !== piece.tokens.first.start ||
    piece.source.end !== piece.tokens.last.end
  )
    fail("live token/AST-parent role or order mismatch");
  return slice(source, piece.source, "live executable slice");
}
function reconstructRecord(
  record: Record,
  r: RuntimeContractEvolutionReceipt,
  raw: ReadonlyMap<string, string>,
  analyses: ReadonlyMap<string, Analysis>,
): string {
  const source = required(raw, record.path);
  let cursor = 0,
    result = "",
    delta = 0;
  for (const [ordinal, edit] of record.spans.entries()) {
    if (edit.ordinal !== ordinal || edit.current.start < cursor || edit.target.start !== edit.current.start + delta)
      fail("bounded span ordering/offset mismatch");
    uniqueSlice(source, edit.current, record.path);
    let replacement = "";
    for (const piece of edit.recipe) {
      if (piece.targetStart !== edit.target.start + replacement.length) fail("projected operand order mismatch");
      replacement += piece.kind === "literal" ? piece.text : livePiece(piece, record, edit, r, raw, analyses);
    }
    assertRuntimeContractSource(replacement, edit.target, "reconstructed contextual span");
    if (edit.target.end !== edit.target.start + replacement.length) fail("target span length mismatch");
    result += source.slice(cursor, edit.current.start) + replacement;
    cursor = edit.current.end;
    delta += replacement.length - (edit.current.end - edit.current.start);
  }
  return result + source.slice(cursor);
}
function assertScaffold(record: Record, result: string, analysis: Analysis): void {
  for (const edit of record.spans)
    for (const piece of edit.recipe) {
      if (piece.kind !== "literal") continue;
      const start = piece.targetStart,
        end = start + piece.text.length;
      if (!piece.text || result.slice(start, end) !== piece.text) fail("literal scaffold position mismatch");
      const allowed =
        piece.category === "whitespace"
          ? /^\s+$/.test(piece.text)
          : (piece.category === "comment" ? analysis.comments : analysis.links).some(
              (range) => range.start <= start && range.end >= end,
            );
      if (!allowed) fail("literal scaffold contains an executable operand");
    }
}
function replayRecord(record: Record, result: string, raw: string): void {
  let cursor = 0,
    replay = "";
  for (const edit of record.spans) {
    uniqueSlice(result, edit.target, "historical " + record.path);
    replay += result.slice(cursor, edit.target.start) + slice(raw, edit.current, "retained current residue");
    cursor = edit.target.end;
  }
  replay += result.slice(cursor);
  assertRuntimeContractSource(replay, record.current, "reciprocal " + record.path);
  if (replay !== raw) fail(`reciprocal full bytes mismatch: ${record.path}`);
}
/** Only the initial historical receipt reader uses this view; compiler/type/runtime readers stay raw. */
export function reconstructRuntimeContractReceiptSources(
  reader: Reader = readRuntimeContractActual,
  receiptText?: string,
): ReadonlyMap<string, string> {
  const r = authenticateRuntimeContractEvolution(receiptText),
    raw = capture(r, reader);
  const analyses = new Map(
    r.records.map((record) => [record.path, assertAnalysis(record.current, required(raw, record.path))]),
  );
  assertRuntimeContractSource(required(raw, abiPath), r.abiDonor.source, "actual ABI donor");
  const donor = required(analyses, abiPath);
  if (!same(donor.declarations, r.abiDonor.declarations) || !same(donor.links, r.abiDonor.links))
    fail("actual ABI donor census mismatch");
  const residues = r.records.flatMap((record) =>
    record.current.declarations.filter(
      (d) =>
        !record.target.declarations.some(
          (t) => t.name === d.name && t.kind === d.kind && t.occurrence === d.occurrence,
        ),
    ),
  );
  if (!same(residues, r.currentResidues)) fail("current-only declaration population mismatch");
  const result = new Map<string, string>();
  for (const record of r.records) {
    const restored = reconstructRecord(record, r, raw, analyses),
      analysis = assertAnalysis(record.target, restored);
    assertScaffold(record, restored, analysis);
    replayRecord(record, restored, required(raw, record.path));
    result.set(record.path, restored);
  }
  return result;
}
/** Inject historical mutants only after this initial read; already-normalized changed inputs are refused. */
export function beforeRuntimeContractReceiptSource(
  path: string,
  source: string,
  reader: Reader = readRuntimeContractActual,
): string {
  return runtimeContractCurrentPaths.includes(path)
    ? required(
        reconstructRuntimeContractReceiptSources((p) => (p === path ? source : reader(p))),
        path,
      )
    : source;
}
export function readRuntimeContractReceiptSource(path: string, reader: Reader = readRuntimeContractActual): string {
  return runtimeContractCurrentPaths.includes(path)
    ? required(reconstructRuntimeContractReceiptSources(reader), path)
    : reader(path);
}
