// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { readBeforeResumeMain } from "./helpers/resume-main-composition.js";
import {
  authenticateClosureComposition,
  applyClosureComposition,
  readBeforeClosureComposition,
  closureCompositionFixturePath,
  closureCompositionSha,
} from "./helpers/closure-source-composition.js";
const receipt = authenticateClosureComposition();
for (const row of receipt.records) {
  const current = readBeforeResumeMain(row.path);
  describe(`unchanged closure donor composition: ${row.path}`, () => {
    it("authenticates both complete sources and reciprocal replay", () => {
      expect(closureCompositionSha(current)).toBe(row.afterSha256);
      const parent = applyClosureComposition(row.path, current, true);
      expect(closureCompositionSha(parent)).toBe(row.beforeSha256);
      expect(applyClosureComposition(row.path, parent, false)).toBe(current);
      expect(readBeforeClosureComposition(row.path)).toBe(parent);
    });
    row.spans.forEach((span, index) => {
      it(`rejects missing span ${index}`, () => {
        expect(() => applyClosureComposition(row.path, current.replace(span.after, ""), true)).toThrow();
      });
      it(`rejects duplicated span ${index}`, () => {
        expect(() =>
          applyClosureComposition(row.path, current.replace(span.after, span.after + span.after), true),
        ).toThrow();
      });
      it(`rejects altered span ${index}`, () => {
        const changed = current.replace(span.after, span.after.replace("\n", "\n// altered span\n"));
        expect(changed).not.toBe(current);
        expect(() => applyClosureComposition(row.path, changed, true)).toThrow();
      });
    });
    it("rejects retained-source edits outside all spans", () => {
      expect(() => applyClosureComposition(row.path, current + "\n// unrelated edit\n", true)).toThrow(
        "retained source",
      );
    });
    it("refuses already inverted source", () => {
      const parent = applyClosureComposition(row.path, current, true);
      expect(() => applyClosureComposition(row.path, parent, true)).toThrow();
    });
    it("rejects edits to the historical replay input", () => {
      const parent = applyClosureComposition(row.path, current, true);
      expect(() => applyClosureComposition(row.path, parent + "\n", false)).toThrow("retained source");
    });
  });
}
it("rejects reordered wrapper spans", () => {
  const row = receipt.records[0]!;
  const current = readBeforeResumeMain(row.path);
  const [a, b] = row.spans;
  const mutant = current
    .replace(a!.after, "__WRAPPER_SPAN__")
    .replace(b!.after, a!.after)
    .replace("__WRAPPER_SPAN__", b!.after);
  expect(() => applyClosureComposition(row.path, mutant, true)).toThrow();
});
it("rejects receipt tampering", () => {
  const row = receipt.records[0]!;
  const text = readBeforeResumeMain(closureCompositionFixturePath);
  expect(() => applyClosureComposition(row.path, readBeforeResumeMain(row.path), true, text + " ")).toThrow(
    "receipt digest",
  );
  expect(() => authenticateClosureComposition(text.replace(row.commit, row.parent))).toThrow("receipt digest");
});
it("rejects unrecorded paths and leaves their existing reader unchanged", () => {
  const path = "src/codegen/closures/closure-header-layout.ts";
  expect(readBeforeClosureComposition(path)).toBe(readBeforeResumeMain(path));
  expect(() => applyClosureComposition(path, readBeforeResumeMain(path), true)).toThrow("unrecorded");
});
