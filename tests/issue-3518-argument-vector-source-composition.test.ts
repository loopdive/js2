// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readBeforeResumeMain } from "./helpers/resume-main-composition.js";
import { verifyObjectRuntimeComposition } from "./helpers/object-get-key-composition.js";
import { inversePreparedSourceForward } from "./helpers/prepared-source-forward-receipts.js";
import {
  argumentMainReceipt,
  argumentMainReceiptPath,
  composeArgumentMainSource,
  readArgumentVectorObjectSource,
  replayHistoricalSymbolInput,
} from "./helpers/argument-vector-source-composition.js";
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const record = argumentMainReceipt();
const current = () => verifyObjectRuntimeComposition(readBeforeResumeMain("src/codegen/object-runtime.ts")).original;
describe("argument vector historical source composition", () => {
  it("inverts and replays every later main change on authenticated actual source", () => {
    const source = current(),
      prior = composeArgumentMainSource(source, true);
    expect(sha(prior)).toBe(record.beforeSha256);
    expect(composeArgumentMainSource(prior, false)).toBe(source);
  });
  it("reorders the signed Symbol span into the exact historical input and back", () => {
    const source = readArgumentVectorObjectSource();
    const text = read("tests/fixtures/issue-3518-main-object-runtime-forward.json");
    expect(sha(source)).toBe(JSON.parse(text).change.priorCheckpointProjectedSha256);
    const prior = inversePreparedSourceForward(
      source,
      text,
      "0fd52e36fb7e44c9ffc7f710228be16da332859fa0c22e26644d67be588528e9",
    );
    expect(composeArgumentMainSource(prior, false)).toBe(current());
    const prepared = JSON.parse(read("tests/fixtures/issue-3518-prepared-object-runtime-forward.json"));
    for (const span of prepared.spans) expect(prior.split(span.after)).toHaveLength(2);
  });
  for (const [i, span] of record.spans.entries()) {
    it(`rejects missing span ${i}`, () => {
      expect(() => composeArgumentMainSource(current().replace(span.after, span.before), true)).toThrow(/span/);
    });
    it(`rejects changed span ${i}`, () => {
      expect(() =>
        composeArgumentMainSource(current().replace(span.after, span.after.replace("\n", "\n// changed\n")), true),
      ).toThrow(/span/);
    });
    it(`rejects duplicated span ${i}`, () => {
      expect(() => composeArgumentMainSource(current() + span.after, true)).toThrow(/span/);
    });
  }
  it("rejects reversed span order", () => {
    expect(() =>
      composeArgumentMainSource(
        [...record.spans]
          .reverse()
          .map((s) => s.after)
          .join("\n"),
        true,
      ),
    ).toThrow(/span/);
  });
  it("rejects unowned changes", () => {
    expect(() => composeArgumentMainSource(current() + "\n// foreign\n", true)).toThrow(/complete input/);
  });
  it("rejects receipt substitution", () => {
    expect(() => argumentMainReceipt((p) => read(p) + (p === argumentMainReceiptPath ? " " : ""))).toThrow(/receipt/);
  });
  it("rejects Symbol fixture substitution", () => {
    expect(() => replayHistoricalSymbolInput(composeArgumentMainSource(current(), true), (p) => read(p) + " ")).toThrow(
      /receipt/,
    );
  });
  it("rejects Symbol replay on an unrelated source", () => {
    expect(() => replayHistoricalSymbolInput(current())).toThrow(/input/);
  });
});
