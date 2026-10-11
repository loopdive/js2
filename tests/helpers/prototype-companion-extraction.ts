// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const receiptPath = "tests/fixtures/issue-3518-prototype-companion-extraction.json";
const builderPath = "src/runtime/wasmgc/values/prototype-companion-body.ts";
const copyright = "// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\n";

/** Remove only the authenticated later extraction; older whole-source checks remain mandatory. */
export function applyPrototypeCompanionExtraction(
  source: string,
  inverse: boolean,
  reader: (path: string) => string = read,
): string {
  const text = reader(receiptPath);
  if (sha(text) !== "edf78072c621f8dd72ed74307c33857772beb4ee82ffdba118e67c73b97be739")
    throw new Error("prototype companion receipt mismatch");
  if (sha(reader(builderPath)) !== "d20f8f40948ac698207ac1bd177ea6ff141a2bf20d0b451493833ca9a0b3a4f7")
    throw new Error("prototype companion builder mismatch");
  const receipt = JSON.parse(text) as { before: string; after: string; import: string };
  let priorEnd = 0;
  const spans = [{ before: copyright, after: copyright + receipt.import }, receipt].map((span) => {
    const from = inverse ? span.after : span.before;
    const to = inverse ? span.before : span.after;
    const start = source.indexOf(from);
    if (!from || start < priorEnd || source.indexOf(from, start + 1) !== -1)
      throw new Error("prototype companion span missing, duplicated or reordered");
    priorEnd = start + from.length;
    return { start, end: priorEnd, to };
  });
  for (const span of spans.reverse()) source = source.slice(0, span.start) + span.to + source.slice(span.end);
  return source;
}
