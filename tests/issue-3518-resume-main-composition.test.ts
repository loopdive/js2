// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readBeforePrototypeRead } from "./helpers/prototype-read-extraction.js";
import { describe, expect, it } from "vitest";
import {
  applyResumeMainComposition,
  authenticateResumeMainComposition,
  readBeforeResumeMain,
  readMergedSource,
  resumeMainCompositionText,
  resumeMainFixturePath,
  resumeMainPaths,
  resumeMainPrior,
  resumeMainSha,
  resumeMainUpstream,
} from "./helpers/resume-main-composition.js";

const receipt = authenticateResumeMainComposition();
type Row = (typeof receipt.records)[number];
function positive(row: Row) {
  // Inspect the authenticated main layer before the later prototype extraction.
  const current = readBeforePrototypeRead(row.path, readMergedSource);
  expect(resumeMainSha(current)).toBe(row.mergedSha256);
  const prior = applyResumeMainComposition(row.path, current, true);
  expect(resumeMainSha(prior)).toBe(row.prior.sha256);
  expect(prior).not.toBe(current);
  expect(applyResumeMainComposition(row.path, prior, false)).toBe(current);
  return { current, prior };
}
function replaceOnce(source: string, before: string, after: string): string {
  expect(source.split(before)).toHaveLength(2);
  const changed = source.replace(before, () => after);
  expect(changed).not.toBe(source);
  return changed;
}
function damage(source: string): string {
  const at = source.search(/\S/);
  expect(at).toBeGreaterThanOrEqual(0);
  return source.slice(0, at) + (source[at] === "~" ? "!" : "~") + source.slice(at + 1);
}

describe("resume-main outer composition preserves exact earlier authority", () => {
  it("pins the actual signed prior, canonical main and common base independently", () => {
    expect(receipt.priorCommit).toBe(resumeMainPrior);
    expect(receipt.mainCommit).toBe(resumeMainUpstream);
    expect(receipt.mergeBase).toBe("62221769a87acdc32759c656702eede64936feb5");
    expect(receipt.records.map((row) => row.path)).toEqual(resumeMainPaths);
    expect(resumeMainPaths).toHaveLength(14);
    expect(receipt.records.reduce((count, row) => count + row.spans.length, 0)).toBe(105);
  });
  it("does not normalize fixture bytes or confer authority to unknown paths", () => {
    expect(readBeforeResumeMain(resumeMainFixturePath)).toBe(resumeMainCompositionText);
    expect(() => applyResumeMainComposition("src/codegen/unknown.ts", "", true)).toThrow(
      "unrecorded resume-main source",
    );
  });
  for (const row of receipt.records) {
    it(`reconstructs every prior byte and replays the actual merged ${row.path}`, () => {
      const { prior } = positive(row);
      expect(readBeforeResumeMain(row.path)).toBe(prior);
    });
    for (const span of row.spans)
      it(`${row.path}:${span.ordinal} rejects damaged, missing and duplicated spans in both directions`, () => {
        const { current, prior } = positive(row);
        for (const [source, from, inverse] of [
          [current, span.after, true],
          [prior, span.before, false],
        ] as const) {
          for (const replacement of [damage(from), "", from + from]) {
            const changed = replaceOnce(source, from, replacement);
            expect(() => applyResumeMainComposition(row.path, changed, inverse)).toThrow(
              "resume-main span missing or duplicated",
            );
          }
        }
      });
    it(`${row.path} rejects retained-source edits, reordered spans and historical substitution`, () => {
      const { current, prior } = positive(row);
      for (const [source, inverse] of [
        [current, true],
        [prior, false],
      ] as const) {
        expect(() => applyResumeMainComposition(row.path, source + "\n// unowned edit\n", inverse)).toThrow(
          "resume-main retained source mismatch",
        );
        const first = inverse ? row.spans[0]!.after : row.spans[0]!.before;
        const second = inverse ? row.spans[1]!.after : row.spans[1]!.before;
        const firstAt = source.indexOf(first);
        const secondAt = source.indexOf(second);
        expect(firstAt + first.length).toBeLessThanOrEqual(secondAt);
        const changed =
          source.slice(0, firstAt) +
          second +
          source.slice(firstAt + first.length, secondAt) +
          first +
          source.slice(secondAt + second.length);
        expect(changed).not.toBe(source);
        expect(() => applyResumeMainComposition(row.path, changed, inverse)).toThrow(
          /resume-main span (offset|order) mismatch/,
        );
      }
      expect(() => applyResumeMainComposition(row.path, prior, true)).toThrow(/resume-main span/);
      expect(() => applyResumeMainComposition(row.path, current, false)).toThrow(/resume-main span/);
    });
  }
  it("authenticates the moved numeric helper and shared vec-own recipe as real current files", () => {
    const numeric = receipt.records.find((row) => row.path === "src/codegen/runtime-ref-number.ts")!;
    const recipe = receipt.records.find((row) => row.path.endsWith("/to-primitive-bodies.ts"))!;
    positive(numeric);
    const { current, prior } = positive(recipe);
    expect(current).toContain("bindings.array.vecOwnToPrimIdx");
    expect(prior).not.toContain("bindings.array.vecOwnToPrimIdx");
    expect(() =>
      applyResumeMainComposition(
        recipe.path,
        current.replaceAll("bindings.array.vecOwnToPrimIdx", "bindings.array.arrayToPrimIdx"),
        true,
      ),
    ).toThrow("resume-main span missing or duplicated");
  });
  it("preserves the actual BigInt registry subtype adapter before restoring older donor checks", () => {
    const row = receipt.records.find((candidate) => candidate.path === "src/codegen/registry/imports.ts")!;
    const { current, prior } = positive(row);
    expect(current).toContain("ctx.mod.types.push({ ...buildBigIntPrimitiveType(), superTypeIdx: -1 });");
    expect(current).toContain("registerWideBigIntTypes(ctx, bigIntStructIdx);");
    expect(prior).toContain("ctx.mod.types.push(buildBigIntPrimitiveType());");
    expect(() =>
      applyResumeMainComposition(
        row.path,
        replaceOnce(current, "registerWideBigIntTypes(ctx, bigIntStructIdx);", ""),
        true,
      ),
    ).toThrow("resume-main span missing or duplicated");
  });
  for (const kind of ["prior", "main", "base", "span", "order", "path"] as const)
    it(`rejects ${kind} receipt corruption after the actual positive receipt`, () => {
      expect(authenticateResumeMainComposition()).toEqual(receipt);
      const changed = JSON.parse(resumeMainCompositionText) as typeof receipt;
      if (kind === "prior") changed.priorCommit = resumeMainUpstream;
      if (kind === "main") changed.mainCommit = resumeMainPrior;
      if (kind === "base") changed.mergeBase = resumeMainPrior;
      if (kind === "span") changed.records[0]!.spans[0]!.after += "\n";
      if (kind === "order") changed.records[0]!.spans.reverse();
      if (kind === "path") changed.records[0]!.path = "src/codegen/foreign.ts";
      expect(() => authenticateResumeMainComposition(JSON.stringify(changed))).toThrow(
        "resume-main receipt digest mismatch",
      );
    });
});
