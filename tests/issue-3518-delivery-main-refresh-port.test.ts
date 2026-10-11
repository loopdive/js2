// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  applyDeliveryMainRefresh,
  authenticateDeliveryMainRefresh,
  beforeDeliveryMainRefresh,
  deliveryMainBlob,
  deliveryMainFixture,
  deliveryMainHash,
  deliveryMainMergeBase,
  deliveryMainPaths,
  deliveryMainPrior,
  deliveryMainUpstream,
  readDeliveryMainSource,
} from "./helpers/delivery-main-refresh-port.js";
import { beforeBigIntCarrierPort } from "./helpers/bigint-carrier-port.js";
import { beforeDescriptorAdapterRelocation } from "./helpers/descriptor-adapter-relocation.js";
import { readMergedSource } from "./helpers/resume-main-composition.js";

const receipt = authenticateDeliveryMainRefresh();
const damage = (text: string) => text.replace(/\S/, (character) => (character === "~" ? "!" : "~"));
const directions = [true, false] as const;
function positive(path: string) {
  const current = readDeliveryMainSource(path),
    prior = applyDeliveryMainRefresh(path, current, true);
  expect(prior).not.toBe(current);
  expect(applyDeliveryMainRefresh(path, prior, false)).toBe(current);
  expect(beforeDeliveryMainRefresh(path, current)).toBe(prior);
  return { current, prior };
}

describe("authenticated PR6205 main-refresh source composition", () => {
  it("pins the signed prior, incoming main, common ancestor and exact two-file population", () => {
    expect(receipt.priorCommit).toBe(deliveryMainPrior);
    expect(receipt.mainCommit).toBe(deliveryMainUpstream);
    expect(receipt.mergeBase).toBe(deliveryMainMergeBase);
    expect(receipt.records.map((row) => row.path)).toEqual(deliveryMainPaths);
    expect(receipt.records.map((row) => row.spans.length)).toEqual([2, 1]);
    expect(receipt.dependencies.map((row) => row.path)).toEqual(["src/codegen/object-proto-has-own-property.ts"]);
    expect(receipt.records.every((row) => row.upstream.before.gitBlob !== row.upstream.after.gitBlob)).toBe(true);
  });
  for (const row of receipt.records) {
    it("reconstructs and reciprocally replays the whole actual " + row.path, () => {
      const { current, prior } = positive(row.path);
      expect(deliveryMainHash(current)).toBe(row.after.sha256);
      expect(deliveryMainBlob(current)).toBe(row.after.gitBlob);
      expect(deliveryMainHash(prior)).toBe(row.before.sha256);
      expect(deliveryMainBlob(prior)).toBe(row.before.gitBlob);
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
            expect(() => applyDeliveryMainRefresh(row.path, changed, inverse)).toThrow(
              "delivery-main span missing or duplicated",
            );
          });
    for (const inverse of directions) {
      it(`${row.path} rejects shifted exact spans, inverse=${inverse}, after a positive`, () => {
        const { current, prior } = positive(row.path),
          source = inverse ? current : prior;
        expect(() => applyDeliveryMainRefresh(row.path, "\n" + source, inverse)).toThrow(
          "delivery-main span order or offset mismatch",
        );
      });
      it(`${row.path} rejects unowned edits, inverse=${inverse}, after a positive`, () => {
        const { current, prior } = positive(row.path),
          source = inverse ? current : prior;
        expect(() => applyDeliveryMainRefresh(row.path, source + "\n// outside the recorded spans\n", inverse)).toThrow(
          "delivery-main retained source mismatch",
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
          expect(() => applyDeliveryMainRefresh(row.path, changed, inverse)).toThrow(
            "delivery-main span order or offset mismatch",
          );
        });
    }
    it("rejects historical substitution and a wrong replay direction for " + row.path, () => {
      const { current, prior } = positive(row.path);
      expect(() => applyDeliveryMainRefresh(row.path, prior, true)).toThrow("delivery-main span missing or duplicated");
      expect(() => applyDeliveryMainRefresh(row.path, current, false)).toThrow(
        "delivery-main span missing or duplicated",
      );
    });
  }
  it("keeps the original BigInt and resume-main source readers after the new inverse", () => {
    for (const path of deliveryMainPaths) {
      const { prior } = positive(path);
      expect(readMergedSource(path)).toBe(
        beforeBigIntCarrierPort(path, beforeDescriptorAdapterRelocation(path, prior)),
      );
    }
  });
  it("retains both historical receipt authorities byte for byte", () => {
    expect(deliveryMainHash(readDeliveryMainSource("tests/fixtures/issue-3518-bigint-carrier-port.json"))).toBe(
      "4b6214afe2ccf68e3c45e3cd8e2497d22cd71ce4fc32c5cf572acad150be7a43",
    );
    expect(deliveryMainHash(readDeliveryMainSource("tests/fixtures/issue-3518-resume-main-composition.json"))).toBe(
      "caca5417a51a144f5948f3da2d92af1ee5d8f6fff175d973f14b712e1747658e",
    );
  });
  it("refuses edited receipt authority after an authenticated positive", () => {
    authenticateDeliveryMainRefresh();
    const text = readDeliveryMainSource(deliveryMainFixture);
    for (const changed of [text + "\n", text.replace(deliveryMainPrior, deliveryMainUpstream)]) {
      expect(changed).not.toBe(text);
      expect(() => authenticateDeliveryMainRefresh(changed)).toThrow("delivery-main receipt mismatch");
    }
  });
  it("refuses unrecorded transformations and passes unrelated readers through unchanged", () => {
    positive(deliveryMainPaths[0]);
    const text = readDeliveryMainSource(deliveryMainFixture);
    expect(() => applyDeliveryMainRefresh("unowned", text, true)).toThrow("unrecorded delivery-main source");
    expect(beforeDeliveryMainRefresh(deliveryMainFixture, text)).toBe(text);
  });
  for (const dependency of receipt.dependencies) {
    it("rejects a changed actual imported implementation after a positive: " + dependency.path, () => {
      authenticateDeliveryMainRefresh();
      const reader = (path: string) =>
        readDeliveryMainSource(path) + (path === dependency.path ? "\n// changed imported implementation\n" : "");
      expect(() => authenticateDeliveryMainRefresh(undefined, reader)).toThrow("delivery-main dependency mismatch");
    });
    it("rejects a missing actual imported implementation after a positive: " + dependency.path, () => {
      authenticateDeliveryMainRefresh();
      const reader = (path: string) => {
        if (path === dependency.path) throw Error("missing imported source");
        return readDeliveryMainSource(path);
      };
      expect(() => authenticateDeliveryMainRefresh(undefined, reader)).toThrow("delivery-main dependency missing");
    });
  }
});
