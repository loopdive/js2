// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { inverseAnyToStringGroups, type AnyToStringInverseInputs } from "./issue-3518-any-to-string-inverse.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export const anyToStringCompositionReceiptPath = "tests/fixtures/issue-3518-any-to-string-source-composition.json";
export function anyToStringCompositionReceipt(reader = read) {
  const text = reader(anyToStringCompositionReceiptPath);
  if (sha(text) !== "037680e53e55160192added3e433da579188c639d3422ada939b27f9033676d2")
    throw Error("AnyToString composition receipt mismatch");
  const record = JSON.parse(text) as {
    path: string;
    beforeSha256: string;
    afterSha256: string;
    spans: { before: string; after: string }[];
    modules: { key: keyof AnyToStringInverseInputs; path: string; sha256: string }[];
    donorFixture: string;
    donorFixtureSha256: string;
  };
  for (const module of record.modules)
    if (sha(reader(module.path)) !== module.sha256) throw Error("AnyToString builder mismatch");
  if (sha(reader(record.donorFixture)) !== record.donorFixtureSha256) throw Error("AnyToString donor fixture mismatch");
  return record;
}
/** Tests-only inverse of the signed extraction; no execution-path normalization. */
export function composeAnyToStringSource(source: string, inverse: boolean, reader = read): string {
  const record = anyToStringCompositionReceipt(reader);
  const input = source;
  let end = 0;
  const spans = record.spans.map((span) => {
    const from = inverse ? span.after : span.before;
    const start = source.indexOf(from);
    if (!from || start < end || source.indexOf(from, start + 1) !== -1)
      throw Error("AnyToString extraction span missing, altered, duplicated or reordered");
    end = start + from.length;
    return { start, end, text: inverse ? span.before : span.after };
  });
  if (sha(input) !== (inverse ? record.afterSha256 : record.beforeSha256))
    throw Error("AnyToString complete input mismatch");
  for (const span of spans.reverse()) source = source.slice(0, span.start) + span.text + source.slice(span.end);
  if (sha(source) !== (inverse ? record.beforeSha256 : record.afterSha256))
    throw Error("AnyToString complete output mismatch");
  if (inverse) {
    const donor = JSON.parse(reader(record.donorFixture)).source as string;
    if (sha(donor) !== record.beforeSha256) throw Error("AnyToString donor source mismatch");
    const inputs = Object.fromEntries(
      record.modules.map((m) => [m.key, reader(m.path)]),
    ) as unknown as AnyToStringInverseInputs;
    let adapter = input;
    for (const text of [
      'import { buildAnyToStringBody } from "../runtime/wasmgc/values/any-to-string-body.js";\n',
      'import type { AnyToStringResponse } from "../runtime/wasmgc/values/any-to-string-types.js";\n',
    ]) {
      if (adapter.split(text).length !== 2) throw Error("AnyToString adapter import mismatch");
      adapter = adapter.replace(text, "");
    }
    const marker = "  // Preserve donor capture order";
    const endMarker = "  const typeIdx = addFuncType(ctx, [anyref]";
    const start = adapter.indexOf(marker),
      end = adapter.indexOf(endMarker, start);
    if (start < 0 || end <= start || adapter.indexOf(marker, start + 1) !== -1)
      throw Error("AnyToString adapter range mismatch");
    const actual = adapter.slice(0, start) + inverseAnyToStringGroups(donor, inputs) + adapter.slice(end);
    if (actual !== source) throw Error("AnyToString actual recipe reconstruction mismatch");
  }
  return source;
}
