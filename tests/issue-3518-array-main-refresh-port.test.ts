// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  applyArrayMainRefresh,
  authenticateArrayMainRefresh,
  beforeArrayMainRefresh,
  arrayMainBlob,
  arrayMainFixture,
  arrayMainHash,
  arrayMainMergeBase,
  arrayMainPaths,
  arrayMainPrior,
  arrayMainUpstream,
  readArrayMainSource,
} from "./helpers/array-main-refresh-port.js";
import { beforeDeliveryMainRefresh, readDeliveryMainSource } from "./helpers/delivery-main-refresh-port.js";
import { applyOwnPropertyExtraction } from "./helpers/own-property-extraction.js";
import { beforeBigIntCarrierPort } from "./helpers/bigint-carrier-port.js";
import { beforeDescriptorAdapterRelocation } from "./helpers/descriptor-adapter-relocation.js";
import { readMergedSource } from "./helpers/resume-main-composition.js";

const receipt = authenticateArrayMainRefresh();
const damage = (text: string) => text.replace(/\S/, (character) => (character === "~" ? "!" : "~"));
const directions = [true, false] as const;
function positive(path: string) {
  const current = readArrayMainSource(path),
    prior = applyArrayMainRefresh(path, current, true);
  expect(prior).not.toBe(current);
  expect(applyArrayMainRefresh(path, prior, false)).toBe(current);
  expect(beforeArrayMainRefresh(path, current)).toBe(prior);
  return { current, prior };
}

describe("authenticated PR6205 array-main source composition", () => {
  it("pins the signed prior, incoming main, common ancestor and exact three-file population", () => {
    expect(receipt.priorCommit).toBe(arrayMainPrior);
    expect(receipt.mainCommit).toBe(arrayMainUpstream);
    expect(receipt.mergeBase).toBe(arrayMainMergeBase);
    expect(receipt.records.map((row) => row.path)).toEqual(arrayMainPaths);
    expect(receipt.records.map((row) => row.spans.length)).toEqual([2, 3, 2]);
    expect(receipt.dependencies.map((row) => row.path)).toEqual(["src/codegen/apply-closure-variadic-builtin.ts"]);
    expect(receipt.records.every((row) => row.upstream.before.gitBlob !== row.upstream.after.gitBlob)).toBe(true);
  });
  for (const row of receipt.records) {
    it("reconstructs and reciprocally replays the whole actual " + row.path, () => {
      const { current, prior } = positive(row.path);
      expect(arrayMainHash(current)).toBe(row.after.sha256);
      expect(arrayMainBlob(current)).toBe(row.after.gitBlob);
      expect(arrayMainHash(prior)).toBe(row.before.sha256);
      expect(arrayMainBlob(prior)).toBe(row.before.gitBlob);
    });
    for (const span of row.spans)
      for (const inverse of directions)
        for (const mutation of ["damaged", "missing", "duplicate"] as const)
          it(`${row.path}:${span.ordinal} rejects ${mutation} spans, inverse=${inverse}, after a positive`, () => {
            const { current, prior } = positive(row.path),
              source = inverse ? current : prior,
              from = inverse ? span.after : span.before;
            expect(source.split(from)).toHaveLength(2);
            const replacement = mutation === "damaged" ? damage(from) : mutation === "missing" ? "" : from + from;
            const changed = source.replace(from, () => replacement);
            expect(changed).not.toBe(source);
            expect(() => applyArrayMainRefresh(row.path, changed, inverse)).toThrow(
              "array-main span missing or duplicated",
            );
          });
    for (const inverse of directions) {
      it(`${row.path} rejects shifted exact spans, inverse=${inverse}, after a positive`, () => {
        const { current, prior } = positive(row.path),
          source = inverse ? current : prior;
        expect(() => applyArrayMainRefresh(row.path, "\n" + source, inverse)).toThrow(
          "array-main span order or offset mismatch",
        );
      });
      it(`${row.path} rejects unowned edits, inverse=${inverse}, after a positive`, () => {
        const { current, prior } = positive(row.path),
          source = inverse ? current : prior;
        expect(() => applyArrayMainRefresh(row.path, source + "\n// outside the recorded spans\n", inverse)).toThrow(
          "array-main retained source mismatch",
        );
      });
      if (row.spans.length > 1)
        it(`${row.path} rejects reordered spans, inverse=${inverse}, after a positive`, () => {
          const { current, prior } = positive(row.path),
            source = inverse ? current : prior,
            first = row.spans[0]![inverse ? "after" : "before"],
            last = row.spans.at(-1)![inverse ? "after" : "before"],
            marker = "__delivery_main_span_swap__";
          expect(source).not.toContain(marker);
          const changed = source.replace(first, marker).replace(last, first).replace(marker, last);
          expect(changed).not.toBe(source);
          expect(() => applyArrayMainRefresh(row.path, changed, inverse)).toThrow(
            "array-main span order or offset mismatch",
          );
        });
    }
    it("rejects historical substitution and a wrong replay direction for " + row.path, () => {
      const { current, prior } = positive(row.path);
      expect(() => applyArrayMainRefresh(row.path, prior, true)).toThrow("array-main span missing or duplicated");
      if (row.path === "src/codegen/closure-exports.ts") {
        const span = row.spans[0]!;
        expect(current.split(span.before)).toHaveLength(2);
        expect(current.indexOf(span.before)).toBe(1220);
        expect(span.beforeOffset).toBe(1097);
        expect(() => applyArrayMainRefresh(row.path, current, false)).toThrow(
          "array-main span order or offset mismatch: src/codegen/closure-exports.ts:0",
        );
      } else {
        expect(() => applyArrayMainRefresh(row.path, current, false)).toThrow("array-main span missing or duplicated");
      }
    });
  }
  it("peels the new layer once before the original independent source readers", () => {
    for (const path of arrayMainPaths) {
      const { prior } = positive(path);
      expect(readDeliveryMainSource(path)).toBe(prior);
      const previous = beforeDeliveryMainRefresh(path, prior);
      const own = path === "src/codegen/object-runtime.ts" ? applyOwnPropertyExtraction(previous, true) : previous;
      expect(readMergedSource(path)).toBe(beforeBigIntCarrierPort(path, beforeDescriptorAdapterRelocation(path, own)));
    }
  });
  it("retains every affected historical receipt authority byte for byte", () => {
    for (const [name, digest] of [
      ["delivery-main-refresh-port", "e5d0c8de3cccd647b1f2c77aeb6a208241dcd6248781e580ce050ff8f5b39172"],
      ["resume-main-composition", "caca5417a51a144f5948f3da2d92af1ee5d8f6fff175d973f14b712e1747658e"],
      ["own-property-extraction", "b10bc19653336ab5117e7671a39e3419df27e8e38582cd3dfc2bd0859d44d145"],
      ["object-runtime-apply-extraction", "bf239cec5740142325107965d3a5e026ca3025ea427bfc64103c73e97ff2c647"],
      ["closure-source-composition", "f37b47b66eb1dd2ec2591a9ad9af0efd0c7bd70ded7bde58115e78b06950e23e"],
    ]) {
      expect(arrayMainHash(readArrayMainSource(`tests/fixtures/issue-3518-${name}.json`))).toBe(digest);
    }
  });
  it("refuses edited receipt authority after an authenticated positive", () => {
    authenticateArrayMainRefresh();
    const text = readArrayMainSource(arrayMainFixture);
    for (const changed of [text + "\n", text.replace(arrayMainPrior, arrayMainUpstream)]) {
      expect(changed).not.toBe(text);
      expect(() => authenticateArrayMainRefresh(changed)).toThrow("array-main receipt mismatch");
    }
  });
  it("refuses unrecorded transformations and passes unrelated readers through unchanged", () => {
    positive(arrayMainPaths[0]);
    const text = readArrayMainSource(arrayMainFixture);
    expect(() => applyArrayMainRefresh("unowned", text, true)).toThrow("unrecorded array-main source");
    expect(beforeArrayMainRefresh(arrayMainFixture, text)).toBe(text);
  });
  for (const dependency of receipt.dependencies) {
    it("rejects a changed actual imported implementation after a positive: " + dependency.path, () => {
      authenticateArrayMainRefresh();
      const reader = (path: string) =>
        readArrayMainSource(path) + (path === dependency.path ? "\n// changed imported implementation\n" : "");
      expect(() => authenticateArrayMainRefresh(undefined, reader)).toThrow("array-main dependency mismatch");
    });
    it("rejects a missing actual imported implementation after a positive: " + dependency.path, () => {
      authenticateArrayMainRefresh();
      const reader = (path: string) => {
        if (path === dependency.path) throw Error("missing imported source");
        return readArrayMainSource(path);
      };
      expect(() => authenticateArrayMainRefresh(undefined, reader)).toThrow("array-main dependency missing");
    });
  }
});
