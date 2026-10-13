// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import ts from "typescript";

export const irNativeAllocationTypeOwnershipReceiptPath =
  "tests/helpers/ir-native-allocation-type-ownership-successor.json";
export const irNativeAllocationTypeOwnershipPaths = Object.freeze([
  "src/ir/analysis/contracts/allocations.ts",
  "src/ir/analysis/lattice.ts",
  "src/ir/analysis/escape.ts",
  "src/ir/analysis/alloc-registry.ts",
] as const);
type Reader = (path: string) => string;
interface Pin {
  readonly bytes: number;
  readonly sha256: string;
  readonly gitBlob: string;
}
interface SourcePin extends Pin {
  readonly path: string;
}
interface Transfer {
  readonly source: string;
  readonly beforeStart: number;
  readonly beforeEnd: number;
  readonly beforeText: string;
  readonly currentStart: number;
  readonly currentEnd: number;
  readonly currentText: string;
  readonly declarations: readonly string[];
}
export interface IrNativeAllocationTypeOwnershipReceipt {
  readonly schema: 1;
  readonly kind: "native-allocation-type-ownership-successor";
  readonly base: string;
  readonly before: readonly SourcePin[];
  readonly current: readonly SourcePin[];
  readonly historical: readonly SourcePin[];
  readonly transfers: readonly Transfer[];
  readonly contractAppend: string;
}
const receiptBytes = 7586;
const receiptSha256 = "d8d421dfcb36fb1db451a0e67dd4a6546037e65176fa52ced71bfb837150c7be";
const canonicalBase = "529b092b6f80682538c1c2b7f7e136f5ca9d72c2";
const historicalPaths = [
  "tests/helpers/ir-allocation-provenance-lookup-successor.json",
  "tests/helpers/ir-allocation-provenance-lookup-successor.ts",
  "tests/helpers/ir-allocation-rule-sharing-successor.json",
  "tests/helpers/ir-allocation-rule-sharing-successor.ts",
];
const declarations = [["Ownership"], ["EscapeClass", "EscapeInfo"], ["ALLOC_NAMESPACES"]];
const bindingTexts = [
  'import type { Ownership } from "./contracts/allocations.js";\nexport type { Ownership } from "./contracts/allocations.js";',
  'import type { EscapeClass, EscapeInfo } from "./contracts/allocations.js";\nexport type { EscapeClass, EscapeInfo } from "./contracts/allocations.js";',
  'export { ALLOC_NAMESPACES } from "./contracts/allocations.js";',
];
function fail(detail: string): never {
  throw new Error(`native allocation ownership successor: ${detail}`);
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function pin(text: string): Pin {
  const bytes = Buffer.byteLength(text);
  return {
    bytes,
    sha256: createHash("sha256").update(text).digest("hex"),
    gitBlob: createHash("sha1").update(`blob ${bytes}\0`).update(text).digest("hex"),
  };
}
function fields(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== "object" || !same(Object.keys(value).sort(), [...keys].sort())) fail("closed fields");
}
function checkRecords(records: readonly SourcePin[], paths: readonly string[]): void {
  if (
    !Array.isArray(records) ||
    !same(
      records.map((r) => r.path),
      paths,
    )
  )
    fail("ordered source inventory");
  for (const row of records) {
    fields(row, ["path", "bytes", "sha256", "gitBlob"]);
    if (
      !Number.isSafeInteger(row.bytes) ||
      row.bytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(row.sha256) ||
      !/^[a-f0-9]{40}$/.test(row.gitBlob)
    )
      fail("pin shape");
  }
}
export function assertIrNativeAllocationTypeOwnershipReceiptStructure(r: IrNativeAllocationTypeOwnershipReceipt): void {
  fields(r, ["schema", "kind", "base", "before", "current", "historical", "transfers", "contractAppend"]);
  if (r.schema !== 1 || r.kind !== "native-allocation-type-ownership-successor" || r.base !== canonicalBase)
    fail("receipt identity");
  checkRecords(r.before, irNativeAllocationTypeOwnershipPaths);
  checkRecords(r.current, irNativeAllocationTypeOwnershipPaths);
  checkRecords(r.historical, historicalPaths);
  if (!Array.isArray(r.transfers) || r.transfers.length !== 3) fail("complete transfer population");
  r.transfers.forEach((row, i) => {
    fields(row, [
      "source",
      "beforeStart",
      "beforeEnd",
      "beforeText",
      "currentStart",
      "currentEnd",
      "currentText",
      "declarations",
    ]);
    if (
      row.source !== irNativeAllocationTypeOwnershipPaths[i + 1] ||
      !same(row.declarations, declarations[i]) ||
      row.currentText !== bindingTexts[i] ||
      typeof row.beforeText !== "string" ||
      !row.beforeText
    )
      fail("transfer role/binding");
    for (const key of ["beforeStart", "beforeEnd", "currentStart", "currentEnd"] as const)
      if (!Number.isSafeInteger(row[key]) || row[key] < 0) fail("transfer offset");
    if (
      row.beforeStart !== row.currentStart ||
      row.beforeEnd - row.beforeStart !== Buffer.byteLength(row.beforeText) ||
      row.currentEnd - row.currentStart !== Buffer.byteLength(row.currentText) ||
      row.beforeEnd > r.before[i + 1]!.bytes ||
      row.currentEnd > r.current[i + 1]!.bytes
    )
      fail("transfer bounds");
  });
  if (r.contractAppend !== "\n" + r.transfers.map((t) => t.beforeText).join("\n\n") + "\n")
    fail("ordered append ownership");
}
function source(values: ReadonlyMap<string, string>, path: string): string {
  const value = values.get(path);
  if (value === undefined) fail(`missing live owner ${path}`);
  return value;
}
function authenticateSource(text: string, row: SourcePin): void {
  const actual = pin(text);
  if (actual.bytes !== row.bytes || actual.sha256 !== row.sha256 || actual.gitBlob !== row.gitBlob)
    fail(`complete source pin ${row.path}`);
}
function parse(path: string, text: string): ts.SourceFile {
  const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((tree as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length)
    fail(`source syntax ${path}`);
  return tree;
}
function names(statement: ts.Statement): string[] {
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return [statement.name.text];
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.map((d) => d.name.getText());
  return [];
}
/** Independent lexical-role diagnostics; no caller receipt or pin grants authority here. */
export function assertIrNativeAllocationTypeOwnershipSourceRoles(current: ReadonlyMap<string, string>): void {
  const path = irNativeAllocationTypeOwnershipPaths[0];
  const tree = parse(path, source(current, path));
  const population = tree.statements.flatMap(names);
  if (
    !same(population, [
      "AllocSite",
      "AllocProvenanceLookup",
      "AllocRegistryProvenanceSnapshot",
      "AllocRegistryMetadataSnapshot",
      "AllocRegistrySnapshot",
      "Ownership",
      "EscapeClass",
      "EscapeInfo",
      "ALLOC_NAMESPACES",
    ]) ||
    tree.statements.length !== 11
  )
    fail("contract declaration population/order");
  const aliases = tree.statements.filter(ts.isTypeAliasDeclaration);
  for (const [name, expected] of [
    ["Ownership", ['"owned"', '"borrowed"', '"shared"', '"escaped"']],
    ["EscapeClass", ['"local"', '"returned"', '"stored"', '"captured"', '"opaque"']],
  ] as const) {
    const alias = aliases.find((a) => a.name.text === name);
    if (
      !alias ||
      !ts.isUnionTypeNode(alias.type) ||
      !same(
        alias.type.types.map((t) => t.getText(tree)),
        expected,
      )
    )
      fail("canonical union role");
  }
  const info = tree.statements.filter(ts.isInterfaceDeclaration).find((n) => n.name.text === "EscapeInfo");
  if (
    !info ||
    !same(
      info.members.map((m) => m.getText(tree)),
      ["readonly classification: EscapeClass;", "readonly stackAllocatable: boolean;"],
    )
  )
    fail("escape readonly fields");
  const namespace = tree.statements.filter(ts.isVariableStatement);
  if (
    namespace.length !== 1 ||
    !(namespace[0]!.declarationList.flags & ts.NodeFlags.Const) ||
    !namespace[0]!.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  )
    fail("namespace ownership");
  const value = namespace[0]!.declarationList.declarations[0]?.initializer;
  if (
    !value ||
    !ts.isAsExpression(value) ||
    value.type.getText(tree) !== "const" ||
    !ts.isObjectLiteralExpression(value.expression) ||
    !same(
      value.expression.properties.map((p) =>
        ts.isPropertyAssignment(p) ? [p.name.getText(tree), p.initializer.getText(tree)] : undefined,
      ),
      [
        ["ownership", '"ownership"'],
        ["encoding", '"encoding"'],
        ["lifetime", '"lifetime"'],
        ["escape", '"escape"'],
      ],
    )
  )
    fail("canonical namespace property/value role");
  irNativeAllocationTypeOwnershipPaths.slice(1).forEach((p, i) => {
    const donor = parse(p, source(current, p));
    if (donor.statements.flatMap(names).some((n) => declarations[i]!.includes(n))) fail("duplicate donor declaration");
    const exports = donor.statements
      .filter(ts.isExportDeclaration)
      .filter((e) => e.moduleSpecifier?.getText() === '"./contracts/allocations.js"')
      .filter(
        (e) =>
          e.exportClause &&
          ts.isNamedExports(e.exportClause) &&
          e.exportClause.elements.some((n) => declarations[i]!.includes(n.name.text)),
      );
    if (
      exports.length !== 1 ||
      exports[0]!.isTypeOnly !== (i !== 2) ||
      !exports[0]!.exportClause ||
      !ts.isNamedExports(exports[0]!.exportClause) ||
      !same(
        exports[0]!.exportClause.elements.map((e) => (e.propertyName || e.isTypeOnly ? undefined : e.name.text)),
        declarations[i],
      )
    )
      fail("canonical donor export binding");
    if (i !== 2) {
      const imports = donor.statements
        .filter(ts.isImportDeclaration)
        .filter((e) => e.moduleSpecifier.getText() === '"./contracts/allocations.js"');
      const binding = imports[0]?.importClause?.namedBindings;
      if (
        imports.length !== 1 ||
        !imports[0]!.importClause?.isTypeOnly ||
        !binding ||
        !ts.isNamedImports(binding) ||
        !same(
          binding.elements.map((e) => (e.propertyName || e.isTypeOnly ? undefined : e.name.text)),
          declarations[i],
        )
      )
        fail("canonical donor import binding");
    }
  });
}
function replace(text: string, start: number, end: number, expected: string, replacement: string): string {
  const b = Buffer.from(text);
  if (b.subarray(start, end).toString() !== expected) fail("exact transfer span");
  return Buffer.concat([b.subarray(0, start), Buffer.from(replacement), b.subarray(end)]).toString();
}
/** Diagnostic draft inverse: passing a draft never authenticates the fixed receipt. */
export function reconstructIrNativeAllocationTypeOwnershipDraft(
  r: IrNativeAllocationTypeOwnershipReceipt,
  current: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  assertIrNativeAllocationTypeOwnershipReceiptStructure(r);
  if (!same([...current.keys()], irNativeAllocationTypeOwnershipPaths)) fail("complete current inventory");
  for (const row of r.current) authenticateSource(source(current, row.path), row);
  assertIrNativeAllocationTypeOwnershipSourceRoles(current);
  const before = new Map<string, string>();
  const contract = source(current, r.current[0]!.path),
    prefix = Buffer.from(contract).subarray(0, r.before[0]!.bytes).toString();
  if (contract !== prefix + r.contractAppend) fail("exact contract append");
  before.set(r.before[0]!.path, prefix);
  for (const t of r.transfers)
    before.set(t.source, replace(source(current, t.source), t.currentStart, t.currentEnd, t.currentText, t.beforeText));
  for (const row of r.before) authenticateSource(source(before, row.path), row);
  const replay = replayIrNativeAllocationTypeOwnershipDraft(r, before);
  for (const path of irNativeAllocationTypeOwnershipPaths)
    if (source(replay, path) !== source(current, path)) fail("reciprocal full bytes");
  return before;
}
/** Independent forward from authenticated complete predecessor bytes. */
export function replayIrNativeAllocationTypeOwnershipDraft(
  r: IrNativeAllocationTypeOwnershipReceipt,
  before: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  assertIrNativeAllocationTypeOwnershipReceiptStructure(r);
  if (!same([...before.keys()], irNativeAllocationTypeOwnershipPaths)) fail("complete predecessor inventory");
  for (const row of r.before) authenticateSource(source(before, row.path), row);
  const current = new Map<string, string>([[r.current[0]!.path, source(before, r.before[0]!.path) + r.contractAppend]]);
  for (const t of r.transfers)
    current.set(t.source, replace(source(before, t.source), t.beforeStart, t.beforeEnd, t.beforeText, t.currentText));
  for (const row of r.current) authenticateSource(source(current, row.path), row);
  assertIrNativeAllocationTypeOwnershipSourceRoles(current);
  return current;
}
export function authenticateIrNativeAllocationTypeOwnershipReceipt(
  text: string,
): IrNativeAllocationTypeOwnershipReceipt {
  if (Buffer.byteLength(text) !== receiptBytes || pin(text).sha256 !== receiptSha256)
    fail("fixed receipt digest; caller repin refused");
  const r = JSON.parse(text) as IrNativeAllocationTypeOwnershipReceipt;
  assertIrNativeAllocationTypeOwnershipReceiptStructure(r);
  return r;
}
function historicalJoin(r: IrNativeAllocationTypeOwnershipReceipt, reader: Reader): ReadonlyMap<string, string> {
  const historical = new Map<string, string>();
  for (const row of r.historical) {
    const text = reader(row.path);
    authenticateSource(text, row);
    historical.set(row.path, text);
  }
  for (const [receipt, path] of [
    [historicalPaths[0]!, irNativeAllocationTypeOwnershipPaths[0]],
    [historicalPaths[2]!, irNativeAllocationTypeOwnershipPaths[2]],
  ] as const) {
    const old = JSON.parse(source(historical, receipt)) as { current: SourcePin[] };
    const expected = r.before.find((p) => p.path === path),
      actual = old.current.find((p) => p.path === path);
    if (!expected || !actual || !same(actual, expected)) fail("immutable predecessor receipt join");
  }
  return historical;
}
/** Every call authenticates the receipt and all actual owners afresh, including passthrough calls. */
export function readBeforeIrNativeAllocationTypeOwnership(path: string, actualReader: Reader): string {
  const receiptText = actualReader(irNativeAllocationTypeOwnershipReceiptPath);
  const r = authenticateIrNativeAllocationTypeOwnershipReceipt(receiptText);
  const current = new Map(irNativeAllocationTypeOwnershipPaths.map((p) => [p, actualReader(p)]));
  const historical = historicalJoin(r, actualReader);
  const before = reconstructIrNativeAllocationTypeOwnershipDraft(r, current);
  if (before.has(path)) return source(before, path);
  if (historical.has(path)) return source(historical, path);
  if (path === irNativeAllocationTypeOwnershipReceiptPath) return receiptText;
  return actualReader(path);
}
