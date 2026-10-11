// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readBeforeResumeMain } from "./helpers/resume-main-composition.js";
import {
  composeAnyToStringSource,
  anyToStringCompositionReceipt,
  anyToStringCompositionReceiptPath,
} from "./helpers/any-to-string-source-composition.js";
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const record = anyToStringCompositionReceipt();
const current = () => readBeforeResumeMain(record.path);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
describe("signed AnyToString source composition", () => {
  it("restores the complete signed parent and reciprocally replays the live source", () => {
    const source = current();
    const original = composeAnyToStringSource(source, true);
    expect(sha(original)).toBe(record.beforeSha256);
    expect(composeAnyToStringSource(original, false)).toBe(source);
  });
  for (const [index, span] of record.spans.entries()) {
    it(`rejects missing extraction span ${index}`, () => {
      expect(() => composeAnyToStringSource(current().replace(span.after, span.before), true)).toThrow(/span/);
    });
    it(`rejects altered extraction span ${index}`, () => {
      expect(() =>
        composeAnyToStringSource(current().replace(span.after, span.after.replace("\n", "\n// altered\n")), true),
      ).toThrow(/span/);
    });
    it(`rejects duplicate extraction span ${index}`, () => {
      expect(() => composeAnyToStringSource(current() + span.after, true)).toThrow(/span/);
    });
  }
  it("rejects reversed span order", () => {
    expect(() =>
      composeAnyToStringSource(
        [...record.spans]
          .reverse()
          .map((s) => s.after)
          .join("\n"),
        true,
      ),
    ).toThrow(/span/);
  });
  it("rejects unowned changes outside the spans", () => {
    expect(() => composeAnyToStringSource(current() + "\n// foreign\n", true)).toThrow(/complete input/);
  });
  it("rejects a second inverse", () => {
    expect(() => composeAnyToStringSource(composeAnyToStringSource(current(), true), true)).toThrow();
  });
  it("rejects fixture substitution", () => {
    expect(() =>
      anyToStringCompositionReceipt((path) => read(path) + (path === anyToStringCompositionReceiptPath ? " " : "")),
    ).toThrow(/receipt/);
  });
  for (const module of record.modules) {
    it(`rejects changed actual builder ${module.path}`, () => {
      expect(() =>
        composeAnyToStringSource(
          current(),
          true,
          (path) => read(path) + (path === module.path ? "\n// changed\n" : ""),
        ),
      ).toThrow(/builder/);
    });
  }
});
