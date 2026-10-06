// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { applyFlatLayoutRelocation, flatLayoutDrivePath } from "./flat-layout-relocation.js";
import { createMain5fEpochProjection, projectMain5fEpochSource } from "./historical-promise-main5f-epoch.js";
import { projectMain4bffSuccessorSource } from "./historical-promise-main4bff-successor.js";

export type HistoricalPromiseReader = (path: string) => string;
export const historicalPromiseFixture = "tests/fixtures/issue-5883-historical-reader-successors.json";
export const historicalPromiseCommit = "5c63aae46653370f5a2169dd08947d5c69b568e8";
export const historicalPromisePaths = [
  "src/codegen/promise-class-receiver-drive.ts",
  "src/codegen/builtin-static-globals.ts",
  "src/codegen/builtin-value-read.ts",
  "src/codegen/async-scheduler.ts",
  "src/codegen/promise-custom-combinator.ts",
  "src/codegen/promise-combinator-drive.ts",
  "src/codegen/promise-combinators.ts",
] as const;
export const readHistoricalPromiseRaw: HistoricalPromiseReader = (path) =>
  readFileSync(new URL("../../" + path, import.meta.url), "utf8");
export const historicalPromiseHash = (source: string): string => createHash("sha256").update(source).digest("hex");
export const historicalPromiseBlob = (source: string): string =>
  createHash("sha1")
    .update("blob " + Buffer.byteLength(source) + "\0")
    .update(source)
    .digest("hex");
interface Pin {
  sha256: string;
  gitBlob: string;
}
export interface HistoricalPromiseSpan {
  ordinal: number;
  before: string;
  after: string;
  beforeOffset: number;
  afterOffset: number;
  beforeSha256: string;
  afterSha256: string;
}
export interface HistoricalPromiseRecord {
  path: string;
  beforeCommit: string;
  afterCommit: string;
  before: Pin;
  after: Pin;
  rawAfter: Pin;
  initialLayer: string;
  spans: HistoricalPromiseSpan[];
  retained: { beforeOffset: number; afterOffset: number; length: number; sha256: string }[];
}
export interface HistoricalPromiseReceipt {
  schemaVersion: number;
  kind: string;
  currentCommit: string;
  offsetUnit: string;
  layerOrder: string[];
  semanticScope: string;
  records: HistoricalPromiseRecord[];
  dependencies: (Pin & { path: string; commit: string; role: string })[];
  provenance: {
    commit: string;
    parents: string[];
    subject: string;
    sourceChanges: { path: string; before: Pin | null; after: Pin | null }[];
  }[];
}
const validPin = (pin: Pin): boolean => /^[a-f0-9]{64}$/.test(pin.sha256) && /^[a-f0-9]{40}$/.test(pin.gitBlob);
const matches = (source: string, pin: Pin): boolean =>
  historicalPromiseHash(source) === pin.sha256 && historicalPromiseBlob(source) === pin.gitBlob;
const dependencyPaths = [
  "src/codegen/builtin-fn-meta.ts",
  "src/codegen/carrier-bag-visibility.ts",
  "src/codegen/closure-classifier.ts",
  "src/codegen/closures/closure-header-layout.ts",
  "src/codegen/closures/funcref-wrapper-types.ts",
  "src/codegen/context/create-context.ts",
  "src/codegen/context/locals.ts",
  "src/codegen/context/types.ts",
  "src/codegen/func-space.ts",
  "src/codegen/native-strings.ts",
  "src/codegen/object-runtime.ts",
  "src/codegen/promise-dynamic-member-read.ts",
  "src/codegen/promise-species-then.ts",
  "src/codegen/promises/promise-combinator-observable-protocol.ts",
  "src/codegen/promises/promise-observable-combinators.ts",
  "src/codegen/registry/error-types.ts",
  "src/codegen/registry/imports.ts",
  "src/codegen/registry/types.ts",
  "src/ir/try-table.ts",
  "src/ir/types.ts",
  "src/wasm/physical/exception-control.ts",
  "tests/fixtures/issue-3518-promise-export-main-port.json",
  "tests/fixtures/issue-3518-promise-earlier-main-port.json",
  "tests/helpers/native-delay-combinator-b1-inverse.mjs",
  "tests/helpers/native-delay-combinator-source-receipts.mjs",
  "tests/fixtures/issue-5883-flat-layout-relocation.json",
  "src/codegen/vectors/vec-pop-body.ts",
] as const;

/** All current operands, moved owners, services and immutable authorities come through this raw reader. */
export function authenticateHistoricalPromiseSuccessors(
  text = readHistoricalPromiseRaw(historicalPromiseFixture),
  reader: HistoricalPromiseReader = readHistoricalPromiseRaw,
): HistoricalPromiseReceipt {
  if (historicalPromiseHash(text) !== "32c7b8d9dff6071c8f468335c9300a931ae34dae772ea5095c096b9aaa444ff7")
    throw Error("historical-promise successor receipt mismatch");
  const receipt = JSON.parse(text) as HistoricalPromiseReceipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "5883-historical-reader-successors" ||
    receipt.currentCommit !== historicalPromiseCommit ||
    receipt.offsetUnit !== "utf16-code-units" ||
    JSON.stringify(receipt.records.map((row) => row.path)) !== JSON.stringify(historicalPromisePaths) ||
    JSON.stringify(receipt.records.map((row) => row.spans.length)) !== JSON.stringify([10, 4, 2, 9, 3, 4, 15]) ||
    JSON.stringify(receipt.dependencies.map((row) => row.path)) !== JSON.stringify(dependencyPaths) ||
    JSON.stringify(receipt.layerOrder) !==
      JSON.stringify([
        "raw-current",
        "flat-drive-only",
        "later-and-extraction-inverse",
        "original-export-inverse",
        "original-earlier-inverse",
        "existing-B1-and-delay-reconstruction",
      ])
  )
    throw Error("historical-promise successor provenance mismatch");
  for (const row of receipt.records) {
    if (![row.before, row.after, row.rawAfter].every(validPin))
      throw Error("historical-promise successor endpoint mismatch");
    let beforeEnd = 0,
      afterEnd = 0;
    for (const [ordinal, span] of row.spans.entries()) {
      if (
        span.ordinal !== ordinal ||
        !span.before ||
        !span.after ||
        span.before === span.after ||
        historicalPromiseHash(span.before) !== span.beforeSha256 ||
        historicalPromiseHash(span.after) !== span.afterSha256 ||
        !Number.isInteger(span.beforeOffset) ||
        !Number.isInteger(span.afterOffset) ||
        span.beforeOffset < beforeEnd ||
        span.afterOffset < afterEnd
      )
        throw Error("historical-promise successor span authority mismatch");
      beforeEnd = span.beforeOffset + span.before.length;
      afterEnd = span.afterOffset + span.after.length;
    }
    if (row.retained.length !== row.spans.length + 1)
      throw Error("historical-promise successor retained authority mismatch");
  }
  // Authenticate actual extracted owners and their dependencies BEFORE reintroducing any old declarations.
  const epoch = createMain5fEpochProjection(reader);
  for (const dependency of receipt.dependencies) {
    let source: string;
    try {
      source = reader(dependency.path);
    } catch (cause) {
      throw Error("historical-promise successor dependency missing: " + dependency.path, { cause });
    }
    try {
      source = epoch(dependency.path, projectMain4bffSuccessorSource(dependency.path, source, reader));
    } catch (cause) {
      throw Error("historical-promise successor dependency mismatch: " + dependency.path, { cause });
    }
    if (!validPin(dependency) || dependency.commit !== historicalPromiseCommit || !matches(source, dependency))
      throw Error("historical-promise successor dependency mismatch: " + dependency.path);
  }
  for (const row of receipt.records) {
    let source: string;
    try {
      source = reader(row.path);
    } catch (cause) {
      throw Error("historical-promise successor current operand missing: " + row.path, { cause });
    }
    try {
      source = epoch(row.path, projectMain4bffSuccessorSource(row.path, source, reader));
    } catch (cause) {
      throw Error("historical-promise successor current operand mismatch: " + row.path, { cause });
    }
    if (!matches(source, row.rawAfter))
      throw Error("historical-promise successor current operand mismatch: " + row.path);
  }
  return receipt;
}

/** The sole relocation peel; callers passing explicit source to apply must use this projection for the drive. */
export function projectHistoricalPromiseSource(
  path: string,
  source: string,
  reader: HistoricalPromiseReader = readHistoricalPromiseRaw,
): string {
  return path === flatLayoutDrivePath
    ? applyFlatLayoutRelocation(
        path,
        source,
        true,
        reader("tests/fixtures/issue-5883-flat-layout-relocation.json"),
        reader,
      )
    : projectMain5fEpochSource(path, projectMain4bffSuccessorSource(path, source, reader), reader);
}

function transform(row: HistoricalPromiseRecord, source: string, inverse: boolean): string {
  const from = inverse ? "after" : "before",
    to = inverse ? "before" : "after";
  let cursor = 0,
    result = "";
  for (const span of row.spans) {
    const at = source.indexOf(span[from]);
    if (at < 0 || source.indexOf(span[from], at + 1) >= 0)
      throw Error("historical-promise successor span missing or duplicated: " + row.path + ":" + span.ordinal);
    if (at < cursor || at !== span[inverse ? "afterOffset" : "beforeOffset"])
      throw Error("historical-promise successor span order or offset mismatch: " + row.path);
    result += source.slice(cursor, at) + span[to];
    cursor = at + span[from].length;
  }
  if (!matches(source, row[from])) throw Error("historical-promise successor retained source mismatch: " + row.path);
  result += source.slice(cursor);
  if (!matches(result, row[to]))
    throw Error("historical-promise successor reconstructed endpoint mismatch: " + row.path);
  for (const retained of row.retained) {
    const inputOffset = inverse ? retained.afterOffset : retained.beforeOffset;
    const outputOffset = inverse ? retained.beforeOffset : retained.afterOffset;
    const input = source.slice(inputOffset, inputOffset + retained.length);
    const output = result.slice(outputOffset, outputOffset + retained.length);
    if (input !== output || historicalPromiseHash(input) !== retained.sha256)
      throw Error("historical-promise successor retained bytes mismatch: " + row.path);
  }
  return result;
}

/** Explicit strings are transformed only by authenticated spans; never replaced by disk or historical whole files. */
export function applyHistoricalPromiseSuccessor(
  path: string,
  source: string,
  inverse: boolean,
  text?: string,
  reader: HistoricalPromiseReader = readHistoricalPromiseRaw,
): string {
  const receipt = authenticateHistoricalPromiseSuccessors(text ?? reader(historicalPromiseFixture), reader);
  const row = receipt.records.find((record) => record.path === path);
  if (!row) throw Error("unrecorded historical-promise successor source");
  const result = transform(row, source, inverse);
  if (transform(row, result, !inverse) !== source)
    throw Error("historical-promise successor reciprocal replay mismatch");
  return result;
}

/** Default initial-read seam only; original export/earlier authenticators and explicit mutants stay unchanged. */
export function readHistoricalPromiseSuccessor(
  path: string,
  reader: HistoricalPromiseReader = readHistoricalPromiseRaw,
): string {
  const source = reader(path);
  if (!historicalPromisePaths.some((candidate) => candidate === path))
    return projectMain5fEpochSource(path, projectMain4bffSuccessorSource(path, source, reader), reader);
  return applyHistoricalPromiseSuccessor(
    path,
    projectHistoricalPromiseSource(path, source, reader),
    true,
    undefined,
    reader,
  );
}
