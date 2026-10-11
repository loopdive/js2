// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";

export const runtimeProgramRelocationReceiptPath = "tests/helpers/ir-runtime-program-relocation.json";
const receiptSha256 = "aeeae92fa9c31d8d7ae6aa8805c91862cb1fa2b79486fa4d69cce29d7d065763";
export const runtimeProgramRelocationPairs = Object.freeze([
  ["src/ir/program.ts", "src/ir/program/owner.ts"],
  ["src/ir/program-abi-contracts.ts", "src/ir/program/draft-abi-lookup.ts"],
  ["src/ir/prepared-component-dependencies.ts", "src/ir/program/runtime-support-dependencies.ts"],
  ["src/ir/generator-support.ts", "src/ir/runtime/generator-support.ts"],
] as const);
export type C1DonorPath = (typeof runtimeProgramRelocationPairs)[number][0];
export const runtimeProgramRelocationCurrentPaths: readonly string[] = Object.freeze(
  runtimeProgramRelocationPairs.flat(),
);
// Explicit direct module dependencies authenticated by the proof. This list is not caller-derived.
export const runtimeProgramRelocationDependencyPaths: readonly string[] = Object.freeze([
  "src/codegen-linear/index.ts",
  "src/ir/abi-bindings.ts",
  "src/ir/backend/legality.ts",
  "src/ir/callable-bindings.ts",
  "src/ir/capability-abi-validation.ts",
  "src/ir/core/callable-bindings.ts",
  "src/ir/core/nodes.ts",
  "src/ir/core/type-binding-keys.ts",
  "src/ir/core/types.ts",
  "src/ir/core/value-references.ts",
  "src/ir/identity-values.ts",
  "src/ir/identity.ts",
  "src/ir/nodes.ts",
  "src/ir/prepared-component-ownership.ts",
  "src/ir/prepared-instruction-support.ts",
  "src/ir/program-abi.ts",
  "src/ir/program-callable-contract.ts",
  "src/ir/program-runtime-abi.ts",
  "src/ir/program-validation.ts",
  "src/ir/program/abi-lookup.ts",
  "src/ir/program/abi-signatures.ts",
  "src/ir/program/abi.ts",
  "src/ir/program/callable-bindings.ts",
  "src/ir/program/data.ts",
  "src/ir/program/errors.ts",
  "src/ir/program/formatter-support.ts",
  "src/ir/program/input-contracts.ts",
  "src/ir/program/prepared-contracts.ts",
  "src/ir/program/runtime-support.ts",
  "src/ir/program/startup.ts",
  "src/ir/runtime-callable-declarations.ts",
  "src/ir/runtime-manifest.ts",
  "src/ir/runtime/contracts/prepared.ts",
  "src/ir/runtime/native-async-callables.ts",
  "src/ir/string-runtime.ts",
  "src/ir/types.ts",
  "src/shared/contracts/ir-identity.ts",
  "src/shared/contracts/ir-unit-inventory.ts",
]);
export const runtimeProgramRelocationPopulationPaths: readonly string[] = Object.freeze([
  ...runtimeProgramRelocationCurrentPaths,
  ...runtimeProgramRelocationDependencyPaths,
]);
export type RuntimeProgramRelocationReader = (path: string) => string;
export const readRuntimeProgramRelocationActual: RuntimeProgramRelocationReader = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
export const runtimeProgramRelocationSha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
export const runtimeProgramRelocationGitBlob = (text: string): string =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
interface Pin {
  readonly bytes: number;
  readonly sha256: string;
  readonly gitBlob: string;
}
interface SymbolRole {
  readonly name: string;
  readonly alias: string;
  readonly typeOnly: boolean;
}
interface ImportRole {
  readonly module: string | null;
  readonly typeOnly: boolean;
  readonly default: string | null;
  readonly namespace: string | null;
  readonly symbols: readonly SymbolRole[];
}
interface ExportRole {
  readonly module: string | null;
  readonly typeOnly: boolean;
  readonly symbols: readonly SymbolRole[] | null;
}
export interface RuntimeProgramRelocationStatement {
  readonly path: string;
  readonly kind: string;
  readonly name: string;
  readonly ordinal: number;
  readonly occurrence: number;
  readonly fullStart: number;
  readonly docStart: number;
  readonly start: number;
  readonly end: number;
  readonly fullStartByte: number;
  readonly docStartByte: number;
  readonly startByte: number;
  readonly endByte: number;
  readonly body: Pin;
  readonly docs: Pin;
  readonly full: Pin;
  readonly role: ImportRole | ExportRole | null;
}
interface Slice {
  readonly path: string;
  readonly docStart: number;
  readonly end: number;
  readonly sha256: string;
}
type Piece = { readonly literal: string } | { readonly slice: Slice };
interface SourceRecord extends Pin {
  readonly path: string;
  readonly statements: readonly RuntimeProgramRelocationStatement[];
  readonly recipe: readonly Piece[];
}
interface Transfer {
  readonly before: RuntimeProgramRelocationStatement;
  readonly after: RuntimeProgramRelocationStatement;
  readonly moved: boolean;
}
export interface RuntimeProgramRelocationReceipt {
  readonly schema: number;
  readonly kind: string;
  readonly scope: string;
  readonly donorOwners: readonly { readonly donor: string; readonly owner: string }[];
  readonly dependencies: readonly (Pin & { readonly path: string })[];
  readonly transfers: readonly Transfer[];
  readonly originals: readonly SourceRecord[];
  readonly current: readonly SourceRecord[];
}
const fail = (detail: string): never => {
  throw new Error(`runtime program relocation: ${detail}`);
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const pin = (text: string): Pin => ({
  bytes: Buffer.byteLength(text),
  sha256: runtimeProgramRelocationSha256(text),
  gitBlob: runtimeProgramRelocationGitBlob(text),
});
function parsed(path: string, text: string): ts.SourceFile {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((source as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length)
    fail(`syntax: ${path}`);
  return source;
}
/** These two retained statements seal the existing transaction constructor and prototype.
 * Their empty declaration names, occurrence order, complete spans and bytes remain receipt-authenticated.
 */
function isPreparedTransactionFreeze(path: string, statement: ts.Statement): boolean {
  if (path !== "src/ir/program.ts" || !ts.isExpressionStatement(statement)) return false;
  const call = statement.expression;
  if (
    !ts.isCallExpression(call) ||
    call.typeArguments ||
    call.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(call.expression) ||
    !ts.isIdentifier(call.expression.expression) ||
    call.expression.expression.text !== "Object" ||
    call.expression.name.text !== "freeze"
  )
    return false;
  const target = call.arguments[0]!;
  return (
    (ts.isIdentifier(target) && target.text === "PreparedIrEmissionTransaction") ||
    (ts.isPropertyAccessExpression(target) &&
      ts.isIdentifier(target.expression) &&
      target.expression.text === "PreparedIrEmissionTransaction" &&
      target.name.text === "prototype")
  );
}
/** Syntax-only census. Body, docs and full trivia span have independent byte identities. */
export function runtimeProgramRelocationStatements(path: string, text: string): RuntimeProgramRelocationStatement[] {
  const source = parsed(path, text),
    seen = new Map<string, number>();
  return source.statements.map((s, ordinal) => {
    const kind = ts.SyntaxKind[s.kind],
      name = ts.isVariableStatement(s)
        ? s.declarationList.declarations.map((d) => d.name.getText(source)).join(",")
        : ((s as ts.Statement & { readonly name?: ts.Node }).name?.getText(source) ?? "");
    const identity = `${kind}:${name}`,
      occurrence = seen.get(identity) ?? 0;
    seen.set(identity, occurrence + 1);
    const start = s.getStart(source),
      docStart = s.getStart(source, true),
      fullStart = s.getFullStart(),
      end = s.end;
    let role: ImportRole | ExportRole | null = null;
    if (ts.isImportDeclaration(s)) {
      const c = s.importClause,
        b = c?.namedBindings;
      role = {
        module: ts.isStringLiteral(s.moduleSpecifier) ? s.moduleSpecifier.text : null,
        typeOnly: c?.isTypeOnly ?? false,
        default: c?.name?.text ?? null,
        namespace: b && ts.isNamespaceImport(b) ? b.name.text : null,
        symbols:
          b && ts.isNamedImports(b)
            ? b.elements.map((e) => ({
                name: (e.propertyName ?? e.name).text,
                alias: e.name.text,
                typeOnly: e.isTypeOnly,
              }))
            : [],
      };
    }
    if (ts.isExportDeclaration(s)) {
      const c = s.exportClause;
      role = {
        module: s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) ? s.moduleSpecifier.text : null,
        typeOnly: s.isTypeOnly,
        symbols:
          c && ts.isNamedExports(c)
            ? c.elements.map((e) => ({
                name: (e.propertyName ?? e.name).text,
                alias: e.name.text,
                typeOnly: e.isTypeOnly,
              }))
            : null,
      };
    }
    if (role === null && !name && !isPreparedTransactionFreeze(path, s)) fail(`unnamed declaration: ${path}`);
    return {
      path,
      kind,
      name,
      ordinal,
      occurrence,
      fullStart,
      docStart,
      start,
      end,
      fullStartByte: Buffer.byteLength(text.slice(0, fullStart)),
      docStartByte: Buffer.byteLength(text.slice(0, docStart)),
      startByte: Buffer.byteLength(text.slice(0, start)),
      endByte: Buffer.byteLength(text.slice(0, end)),
      body: pin(text.slice(start, end)),
      docs: pin(text.slice(docStart, start)),
      full: pin(text.slice(fullStart, end)),
      role,
    };
  });
}
/** Standalone guard is useful for adversarial controls; callers cannot replace the operation's fixed pins. */
export function assertRuntimeProgramRelocationSource(text: string, expected: Pin, label: string): void {
  if (typeof text !== "string" || Buffer.from(text, "utf8").toString("utf8") !== text) fail(`UTF8 source: ${label}`);
  if (Buffer.byteLength(text) !== expected.bytes || runtimeProgramRelocationSha256(text) !== expected.sha256)
    fail(`length/SHA256: ${label}`);
  if (runtimeProgramRelocationGitBlob(text) !== expected.gitBlob) fail(`Git blob: ${label}`);
}
function keys(value: unknown, expected: readonly string[], label: string): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !same(Object.keys(value).sort(), [...expected].sort())
  )
    fail(`schema keys: ${label}`);
}
function pinSchema(p: Pin): void {
  keys(p, ["bytes", "sha256", "gitBlob"], "pin");
  if (
    !Number.isSafeInteger(p.bytes) ||
    p.bytes < 0 ||
    !/^[a-f0-9]{64}$/.test(p.sha256) ||
    !/^[a-f0-9]{40}$/.test(p.gitBlob)
  )
    fail("pin schema");
}
function statementSchema(s: RuntimeProgramRelocationStatement): void {
  keys(
    s,
    [
      "path",
      "kind",
      "name",
      "ordinal",
      "occurrence",
      "fullStart",
      "docStart",
      "start",
      "end",
      "fullStartByte",
      "docStartByte",
      "startByte",
      "endByte",
      "body",
      "docs",
      "full",
      "role",
    ],
    "statement",
  );
  for (const n of [
    s.ordinal,
    s.occurrence,
    s.fullStart,
    s.docStart,
    s.start,
    s.end,
    s.fullStartByte,
    s.docStartByte,
    s.startByte,
    s.endByte,
  ])
    if (!Number.isSafeInteger(n) || n < 0) fail("statement offset");
  if (
    !(
      s.fullStart <= s.docStart &&
      s.docStart <= s.start &&
      s.start <= s.end &&
      s.fullStartByte <= s.docStartByte &&
      s.docStartByte <= s.startByte &&
      s.startByte <= s.endByte
    )
  )
    fail("statement span");
  for (const p of [s.body, s.docs, s.full]) pinSchema(p);
  if (s.role !== null) {
    keys(
      s.role,
      s.kind === "ImportDeclaration"
        ? ["module", "typeOnly", "default", "namespace", "symbols"]
        : ["module", "typeOnly", "symbols"],
      "module role",
    );
    for (const symbol of s.role.symbols ?? []) keys(symbol, ["name", "alias", "typeOnly"], "symbol role");
  }
}
function scaffold(text: string): void {
  if (parsed("c1-scaffold.ts", text).statements.some((s) => !ts.isImportDeclaration(s) && !ts.isExportDeclaration(s)))
    fail("executable scaffold");
}
/** Receipt bytes are pinned before parsing; neither overrides nor alternate historical profiles are admitted. */
export function authenticateRuntimeProgramRelocationReceipt(
  text = readRuntimeProgramRelocationActual(runtimeProgramRelocationReceiptPath),
): RuntimeProgramRelocationReceipt {
  if (runtimeProgramRelocationSha256(text) !== receiptSha256) fail("receipt digest");
  const r = JSON.parse(text) as RuntimeProgramRelocationReceipt;
  keys(r, ["schema", "kind", "scope", "donorOwners", "dependencies", "transfers", "originals", "current"], "receipt");
  if (
    r.schema !== 1 ||
    r.kind !== "phase-c1-reciprocal-runtime-program-source-preservation" ||
    r.scope !== "four original donors; eight current files; no C2/C3 or retirement certification"
  )
    fail("profile");
  if (
    !same(
      r.donorOwners,
      runtimeProgramRelocationPairs.map(([donor, owner]) => ({ donor, owner })),
    ) ||
    !same(
      r.originals.map((s) => s.path),
      runtimeProgramRelocationPairs.map(([donor]) => donor),
    ) ||
    !same(
      r.current.map((s) => s.path),
      runtimeProgramRelocationCurrentPaths,
    ) ||
    !same(
      r.dependencies.map((s) => s.path),
      runtimeProgramRelocationDependencyPaths,
    )
  )
    fail("fixed population/order");
  for (const d of r.dependencies) {
    keys(d, ["path", "bytes", "sha256", "gitBlob"], "dependency");
    pinSchema({ bytes: d.bytes, sha256: d.sha256, gitBlob: d.gitBlob });
  }
  for (const record of [...r.originals, ...r.current]) {
    keys(record, ["path", "bytes", "sha256", "gitBlob", "statements", "recipe"], "source record");
    pinSchema({ bytes: record.bytes, sha256: record.sha256, gitBlob: record.gitBlob });
    record.statements.forEach((s, index) => {
      statementSchema(s);
      if (s.path !== record.path || s.ordinal !== index) fail("statement census/order");
    });
    for (const p of record.recipe) {
      if ("literal" in p) {
        keys(p, ["literal"], "literal");
        scaffold(p.literal);
      } else {
        keys(p, ["slice"], "piece");
        keys(p.slice, ["path", "docStart", "end", "sha256"], "slice");
      }
    }
  }
  const before = r.originals.flatMap((s) => s.statements.filter((d) => d.role === null)),
    after = r.current.flatMap((s) => s.statements.filter((d) => d.role === null));
  if (
    before.length !== 91 ||
    after.length !== 91 ||
    r.transfers.length !== 91 ||
    r.transfers.filter((t) => t.moved).length !== 12 ||
    !same(
      r.transfers.map((t) => t.before),
      before,
    )
  )
    fail("91/12/79 transfer census");
  const used = new Set<string>();
  for (const t of r.transfers) {
    keys(t, ["before", "after", "moved"], "transfer");
    statementSchema(t.before);
    statementSchema(t.after);
    const pair = runtimeProgramRelocationPairs.find(([donor]) => donor === t.before.path);
    if (
      !pair ||
      !pair.some((p) => p === t.after.path) ||
      t.moved !== (t.before.path !== t.after.path) ||
      t.before.kind !== t.after.kind ||
      t.before.name !== t.after.name ||
      t.before.occurrence !== t.after.occurrence ||
      !same(t.before.body, t.after.body) ||
      !same(t.before.docs, t.after.docs) ||
      !after.some((s) => same(s, t.after))
    )
      fail("transfer relationship");
    const id = JSON.stringify([t.after.path, t.after.ordinal]);
    if (used.has(id)) fail("duplicate transfer");
    used.add(id);
  }
  for (const [records, inverse] of [
    [r.originals, true],
    [r.current, false],
  ] as const)
    for (const record of records) {
      const expected = r.transfers
        .filter((t) => (inverse ? t.before : t.after).path === record.path)
        .sort((a, b) => (inverse ? a.before : a.after).ordinal - (inverse ? b.before : b.after).ordinal)
        .map((t) => (inverse ? t.after : t.before));
      const slices = record.recipe.flatMap((p) => ("slice" in p ? [p.slice] : []));
      if (
        slices.length !== expected.length ||
        slices.some(
          (s, i) => s.path !== expected[i]!.path || s.docStart !== expected[i]!.docStart || s.end !== expected[i]!.end,
        )
      )
        fail("recipe declaration census/order");
    }
  return r;
}
function render(record: SourceRecord, sources: ReadonlyMap<string, string>): string {
  return record.recipe
    .map((p) => {
      if ("literal" in p) return p.literal;
      const s = p.slice,
        text = sources.get(s.path);
      if (text === undefined) return fail(`absent slice: ${s.path}`);
      if (
        !Number.isSafeInteger(s.docStart) ||
        !Number.isSafeInteger(s.end) ||
        s.docStart < 0 ||
        s.end < s.docStart ||
        s.end > text.length
      )
        fail("slice bounds");
      for (const offset of [s.docStart, s.end])
        if (
          offset > 0 &&
          offset < text.length &&
          /[\uD800-\uDBFF]/.test(text[offset - 1]!) &&
          /[\uDC00-\uDFFF]/.test(text[offset]!)
        )
          fail("UTF8 split boundary");
      const result = text.slice(s.docStart, s.end);
      if (runtimeProgramRelocationSha256(result) !== s.sha256) fail("slice SHA256");
      return result;
    })
    .join("");
}
/** Exact-map arm rejects extra/absent population before emitting any reconstructed historical source. */
export function reconstructRuntimeProgramRelocationPopulation(
  population: ReadonlyMap<string, string>,
  receiptText?: string,
): ReadonlyMap<C1DonorPath, string> {
  const r = authenticateRuntimeProgramRelocationReceipt(receiptText);
  if (
    population.size !== runtimeProgramRelocationPopulationPaths.length ||
    !runtimeProgramRelocationPopulationPaths.every((p) => population.has(p))
  )
    fail("live population");
  const current = new Map(population); // A private per-operation snapshot, never a cross-operation cache.
  for (const record of [...r.current, ...r.dependencies])
    assertRuntimeProgramRelocationSource(current.get(record.path)!, record, record.path);
  for (const record of r.current)
    if (!same(runtimeProgramRelocationStatements(record.path, current.get(record.path)!), record.statements))
      fail(`current statement/doc/import roles: ${record.path}`);
  const originals = new Map<C1DonorPath, string>();
  for (const record of r.originals) {
    const text = render(record, current);
    assertRuntimeProgramRelocationSource(text, record, record.path);
    if (!same(runtimeProgramRelocationStatements(record.path, text), record.statements))
      fail(`original statement/doc/import roles: ${record.path}`);
    originals.set(record.path as C1DonorPath, text);
  }
  for (const record of r.current)
    if (render(record, originals) !== current.get(record.path)) fail(`nonreciprocal replay: ${record.path}`);
  return originals;
}
/** Fresh complete live capture exactly once per call. Missing files propagate; no historical fallback is allowed. */
export function reconstructRuntimeProgramRelocationSources(
  readLive: RuntimeProgramRelocationReader = readRuntimeProgramRelocationActual,
): ReadonlyMap<C1DonorPath, string> {
  const receiptText = readLive(runtimeProgramRelocationReceiptPath);
  const population = new Map(runtimeProgramRelocationPopulationPaths.map((path) => [path, readLive(path)]));
  return reconstructRuntimeProgramRelocationPopulation(population, receiptText);
}
