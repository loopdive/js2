// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readBeforeResumeMain } from "./resume-main-composition.js";
import { beforeBuiltinMetadataMain } from "./builtin-metadata-main-port.js";

export const closureCompositionFixturePath = "tests/fixtures/issue-3518-closure-source-composition.json";
export const closureCompositionSha = (source: string): string => createHash("sha256").update(source).digest("hex");
const fixtureSha = "f37b47b66eb1dd2ec2591a9ad9af0efd0c7bd70ded7bde58115e78b06950e23e";
const expected = [
  ["src/codegen/closures/funcref-wrapper-types.ts", "bfe17bb4691881ebcb39e9848f52d7df1d4d620f", 2],
  ["src/codegen/expressions/calls.ts", "ea46c33ddcfaf6a62203f7c50c628ce57acd17d4", 1],
  ["src/runtime/wasmgc/values/closure-layouts.ts", "cb64af7b0315d59d08809e404c1216c846270654", 1],
] as const;
interface Span {
  beforeStart: number;
  afterStart: number;
  before: string;
  after: string;
  beforeSha256: string;
  afterSha256: string;
}
interface Record {
  path: string;
  parent: string;
  commit: string;
  beforeBlob: string;
  afterBlob: string;
  beforeSha256: string;
  afterSha256: string;
  spans: Span[];
}
interface Receipt {
  schema: number;
  records: Record[];
}
export function authenticateClosureComposition(text = readBeforeResumeMain(closureCompositionFixturePath)): Receipt {
  if (closureCompositionSha(text) !== fixtureSha) throw new Error("closure composition receipt digest mismatch");
  const receipt = JSON.parse(text) as Receipt;
  if (receipt.schema !== 1 || receipt.records.length !== expected.length)
    throw new Error("closure composition provenance mismatch");
  receipt.records.forEach((r, i) => {
    const [path, commit, count] = expected[i]!;
    if (
      r.path !== path ||
      r.commit !== commit ||
      r.spans.length !== count ||
      ![r.parent, r.beforeBlob, r.afterBlob].every((v) => /^[a-f0-9]{40}$/.test(v))
    )
      throw new Error("closure composition source provenance mismatch");
    for (const s of r.spans) {
      if (
        !s.before ||
        !s.after ||
        s.before === s.after ||
        closureCompositionSha(s.before) !== s.beforeSha256 ||
        closureCompositionSha(s.after) !== s.afterSha256
      )
        throw new Error("closure composition span digest mismatch");
    }
  });
  return receipt;
}
function transform(source: string, r: Record, inverse: boolean): string {
  let end = 0;
  const edits = r.spans.map((s) => {
    const from = inverse ? s.after : s.before;
    const to = inverse ? s.before : s.after;
    const at = source.indexOf(from);
    if (at < 0 || source.indexOf(from, at + 1) !== -1)
      throw new Error("closure composition span missing or duplicated");
    if (at < end) throw new Error("closure composition span order mismatch");
    end = at + from.length;
    if (at !== (inverse ? s.afterStart : s.beforeStart)) throw new Error("closure composition span offset mismatch");
    return { at, end, to };
  });
  if (closureCompositionSha(source) !== (inverse ? r.afterSha256 : r.beforeSha256))
    throw new Error("closure composition retained source mismatch");
  for (const edit of edits.reverse()) source = source.slice(0, edit.at) + edit.to + source.slice(edit.end);
  if (closureCompositionSha(source) !== (inverse ? r.beforeSha256 : r.afterSha256))
    throw new Error("closure composition reconstructed source mismatch");
  return source;
}
/** Preservation-only inverse of fixed published changes. Runtime uses the current implementations. */
export function applyClosureComposition(path: string, source: string, inverse: boolean, text?: string): string {
  const row = authenticateClosureComposition(text).records.find((r) => r.path === path);
  if (!row) throw new Error("unrecorded closure composition source");
  const result = transform(source, row, inverse);
  if (transform(result, row, !inverse) !== source) throw new Error("closure composition reciprocal replay mismatch");
  return result;
}
export function readBeforeClosureComposition(path: string): string {
  const source = beforeBuiltinMetadataMain(path, readBeforeResumeMain(path));
  return expected.some(([p]) => p === path) ? applyClosureComposition(path, source, true) : source;
}
