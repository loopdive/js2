// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  applyHistoricalPromiseSuccessor,
  authenticateHistoricalPromiseSuccessors,
  historicalPromiseBlob,
  historicalPromiseCommit,
  historicalPromiseFixture,
  historicalPromiseHash,
  historicalPromisePaths,
  projectHistoricalPromiseSource,
  readHistoricalPromiseRaw as raw,
  readHistoricalPromiseSuccessor,
  type HistoricalPromiseRecord,
} from "./helpers/historical-promise-successors.js";
import { applyFlatLayoutRelocation, flatLayoutDrivePath } from "./helpers/flat-layout-relocation.js";
import {
  authenticatePromiseExportMain,
  beforePromiseExportMain,
  readHistoricalPromiseExportSource,
  readPromiseExportSource,
} from "./helpers/promise-export-main-port.js";
import { authenticateEarlierPromiseMain, beforeEarlierPromiseMain } from "./helpers/promise-earlier-main-port.js";
import { originalB1Source, B1_DONOR_HASHES } from "./helpers/native-delay-combinator-b1-inverse.mjs";
import { verifyForwardDelayHistorical } from "./helpers/native-delay-combinator-source-receipts.mjs";

const receipt = authenticateHistoricalPromiseSuccessors();
function positive(row: HistoricalPromiseRecord) {
  const after = projectHistoricalPromiseSource(row.path, raw(row.path));
  const before = applyHistoricalPromiseSuccessor(row.path, after, true);
  expect(before).not.toBe(after);
  expect(historicalPromiseHash(after)).toBe(row.after.sha256);
  expect(historicalPromiseBlob(after)).toBe(row.after.gitBlob);
  expect(historicalPromiseHash(before)).toBe(row.before.sha256);
  expect(historicalPromiseBlob(before)).toBe(row.before.gitBlob);
  expect(applyHistoricalPromiseSuccessor(row.path, before, false)).toBe(after);
  return { before, after };
}
describe("bounded historical Promise reader successors", () => {
  it("pins seven actual endpoints, 47 ordered spans, current owners and real parent/child provenance", () => {
    expect(receipt.currentCommit).toBe(historicalPromiseCommit);
    expect(receipt.records.map((row) => row.path)).toEqual(historicalPromisePaths);
    expect(receipt.records.map((row) => row.spans.length)).toEqual([10, 4, 2, 9, 3, 4, 15]);
    expect(receipt.records.reduce((n, row) => n + row.spans.length, 0)).toBe(47);
    expect(receipt.dependencies).toHaveLength(27);
    expect(receipt.provenance).toHaveLength(14);
    for (const producer of receipt.provenance) {
      expect(producer.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(producer.parents.length).toBeGreaterThan(0);
      expect(producer.sourceChanges.length).toBeGreaterThan(0);
      for (const change of producer.sourceChanges)
        for (const pin of [change.before, change.after])
          if (pin !== null) {
            expect(pin.gitBlob).toMatch(/^[a-f0-9]{40}$/);
            expect(pin.sha256).toMatch(/^[a-f0-9]{64}$/);
          }
    }
    expect(receipt.semanticScope).toContain("9feade6d77");
    expect(receipt.semanticScope).toContain("c698ec6020");
    expect(receipt.layerOrder).toEqual([
      "raw-current",
      "flat-drive-only",
      "later-and-extraction-inverse",
      "original-export-inverse",
      "original-earlier-inverse",
      "existing-B1-and-delay-reconstruction",
    ]);
  });
  for (const row of receipt.records) {
    it("inverts/replays the complete actual operand and every retained region: " + row.path, () => {
      const { before, after } = positive(row);
      expect(row.retained).toHaveLength(row.spans.length + 1);
      for (const retained of row.retained) {
        const oldBytes = before.slice(retained.beforeOffset, retained.beforeOffset + retained.length);
        const newBytes = after.slice(retained.afterOffset, retained.afterOffset + retained.length);
        expect(oldBytes).toBe(newBytes);
        expect(historicalPromiseHash(oldBytes)).toBe(retained.sha256);
      }
    });
    it("normalizes only the default initial read while explicit source remains an operand: " + row.path, () => {
      const { before, after } = positive(row);
      expect(readHistoricalPromiseSuccessor(row.path)).toBe(before);
      expect(readHistoricalPromiseExportSource(row.path)).toBe(before);
      expect(readPromiseExportSource(row.path)).toBe(row.path === flatLayoutDrivePath ? after : raw(row.path));
      expect(applyHistoricalPromiseSuccessor(row.path, before, false)).toBe(after);
      expect(() => applyHistoricalPromiseSuccessor(row.path, "not the supplied source", true)).toThrow(
        "historical-promise successor span missing or duplicated",
      );
    });
    for (const span of row.spans)
      for (const inverse of [true, false] as const)
        for (const mutation of ["damaged", "missing", "duplicate"] as const)
          it(`${row.path}:${span.ordinal} refuses ${mutation}, inverse=${inverse}, after a positive`, () => {
            const { before, after } = positive(row);
            const source = inverse ? after : before;
            const from = span[inverse ? "after" : "before"];
            expect(source.split(from)).toHaveLength(2);
            const replacement =
              mutation === "damaged"
                ? from.replace(/\S/, "~")
                : mutation === "missing"
                  ? "\n/* removed recorded successor span */\n"
                  : from + from;
            const changed = source.replace(from, () => replacement);
            expect(changed).not.toBe(source);
            expect(() => applyHistoricalPromiseSuccessor(row.path, changed, inverse)).toThrow(
              "historical-promise successor span missing or duplicated: " + row.path + ":" + span.ordinal,
            );
          });
    for (const inverse of [true, false] as const) {
      it(`${row.path} refuses shifted offsets, inverse=${inverse}, after a positive`, () => {
        const { before, after } = positive(row);
        expect(() => applyHistoricalPromiseSuccessor(row.path, "\n" + (inverse ? after : before), inverse)).toThrow(
          "historical-promise successor span order or offset mismatch: " + row.path,
        );
      });
      it(`${row.path} refuses changed retained bytes, inverse=${inverse}, after a positive`, () => {
        const { before, after } = positive(row);
        expect(() =>
          applyHistoricalPromiseSuccessor(row.path, (inverse ? after : before) + "\n// unrecorded\n", inverse),
        ).toThrow("historical-promise successor retained source mismatch: " + row.path);
      });
      it(`${row.path} refuses reordered spans, inverse=${inverse}, after a positive`, () => {
        const { before, after } = positive(row);
        const source = inverse ? after : before;
        const first = row.spans[0]![inverse ? "after" : "before"];
        const last = row.spans.at(-1)![inverse ? "after" : "before"];
        const marker = "__historical_promise_successor_swap__";
        expect(source).not.toContain(marker);
        const changed = source
          .replace(first, marker)
          .replace(last, () => first)
          .replace(marker, () => last);
        expect(changed).not.toBe(source);
        expect(() => applyHistoricalPromiseSuccessor(row.path, changed, inverse)).toThrow(
          "historical-promise successor span order or offset mismatch: " + row.path,
        );
      });
    }
    it("refuses both wrong directions and a second successor peel: " + row.path, () => {
      const { before, after } = positive(row);
      const refusal =
        /historical-promise successor (span (missing or duplicated|order or offset mismatch)|retained source mismatch)/;
      expect(() => applyHistoricalPromiseSuccessor(row.path, before, true)).toThrow(refusal);
      expect(() => applyHistoricalPromiseSuccessor(row.path, after, false)).toThrow(refusal);
    });
  }
  for (const dependency of receipt.dependencies)
    for (const mutation of ["missing", "changed"] as const)
      it(`requires real dependency ${dependency.path}: ${mutation}, after a positive`, () => {
        authenticateHistoricalPromiseSuccessors();
        const read = (path: string): string => {
          if (path === dependency.path) {
            if (mutation === "missing") throw Error("injected missing actual dependency");
            return raw(path) + "\n// injected dependency mutation\n";
          }
          return raw(path);
        };
        expect(() => authenticateHistoricalPromiseSuccessors(raw(historicalPromiseFixture), read)).toThrow(
          "historical-promise successor dependency " +
            (mutation === "missing" ? "missing: " : "mismatch: ") +
            dependency.path,
        );
      });
  for (const row of receipt.records)
    for (const mutation of ["missing", "changed"] as const)
      it(`requires raw operand ${row.path}: ${mutation}, after a positive`, () => {
        positive(row);
        const read = (path: string): string => {
          if (path === row.path) {
            if (mutation === "missing") throw Error("injected missing actual operand");
            return raw(path) + "\n// injected current operand mutation\n";
          }
          return raw(path);
        };
        expect(() => authenticateHistoricalPromiseSuccessors(raw(historicalPromiseFixture), read)).toThrow(
          "historical-promise successor current operand " +
            (mutation === "missing" ? "missing: " : "mismatch: ") +
            row.path,
        );
      });
  it("refuses changed receipt authority after a positive", () => {
    authenticateHistoricalPromiseSuccessors();
    expect(() => authenticateHistoricalPromiseSuccessors(raw(historicalPromiseFixture) + "\n")).toThrow(
      "historical-promise successor receipt mismatch",
    );
  });
  it("refuses unknown transforms and passes unrelated reader input through exactly", () => {
    positive(receipt.records[0]!);
    expect(() => applyHistoricalPromiseSuccessor("unowned", "explicit input", true)).toThrow(
      "unrecorded historical-promise successor source",
    );
    expect(readHistoricalPromiseSuccessor("unowned", () => "explicit input")).toBe("explicit input");
  });
  it("keeps three already-matching dependency sources raw, with no unnecessary inverse", () => {
    for (const path of [
      "src/codegen/closure-classifier.ts",
      "src/codegen/carrier-bag-visibility.ts",
      "src/ir/try-table.ts",
    ]) {
      const dependency = receipt.dependencies.find((row) => row.path === path)!;
      expect(historicalPromiseHash(raw(path))).toBe(dependency.sha256);
      expect(readHistoricalPromiseSuccessor(path)).toBe(raw(path));
    }
  });
  it("composes successor/export/earlier/B1 and delay inverses without changing original authority", () => {
    const read = (path: string): string =>
      beforeEarlierPromiseMain(path, beforePromiseExportMain(path, readHistoricalPromiseSuccessor(path)));
    const exportReceipt = authenticatePromiseExportMain();
    const earlierReceipt = authenticateEarlierPromiseMain();
    expect(historicalPromiseHash(readHistoricalPromiseExportSource(exportReceipt.record.path))).toBe(
      exportReceipt.record.after.sha256,
    );
    for (const dependency of earlierReceipt.dependencies)
      expect(historicalPromiseHash(readHistoricalPromiseExportSource(dependency.path))).toBe(dependency.sha256);
    for (const [path, digest] of Object.entries(B1_DONOR_HASHES))
      expect(historicalPromiseHash(originalB1Source(path, read))).toBe(digest);
    expect(verifyForwardDelayHistorical(read).historical).toEqual({
      historicalDonors: 8,
      delayRows: 4,
      vectorLoops: 1,
      sharedDispatchHelpers: 1,
    });
  });
  it("peels relocation exactly once at the drive boundary, never twice or for other operands", () => {
    const row = receipt.records.find((entry) => entry.path === flatLayoutDrivePath)!;
    const actual = raw(row.path);
    const projected = projectHistoricalPromiseSource(row.path, actual);
    expect(historicalPromiseHash(actual)).toBe(row.rawAfter.sha256);
    expect(historicalPromiseHash(projected)).toBe(row.after.sha256);
    expect(projected).not.toBe(actual);
    expect(readPromiseExportSource(row.path)).toBe(projected);
    const historical = readHistoricalPromiseExportSource(row.path);
    expect(historicalPromiseHash(historical)).toBe(row.before.sha256);
    expect(historical).not.toBe(projected);
    expect(applyHistoricalPromiseSuccessor(row.path, historical, false)).toBe(projected);
    expect(projected).toBe(applyFlatLayoutRelocation(row.path, actual, true));
    expect(() => projectHistoricalPromiseSource(row.path, projected)).toThrow("flat-layout span missing or duplicated");
    const other = receipt.records[0]!;
    expect(projectHistoricalPromiseSource(other.path, raw(other.path))).toBe(raw(other.path));
  });
  it("uses the injected raw reader for every actual owner and dependency, never a disk fallback", () => {
    const seen = new Set<string>();
    const read = (path: string): string => {
      seen.add(path);
      return raw(path);
    };
    const row = receipt.records.at(-1)!;
    expect(readHistoricalPromiseSuccessor(row.path, read)).toBe(positive(row).before);
    for (const path of [
      ...receipt.records.map((record) => record.path),
      ...receipt.dependencies.map((dep) => dep.path),
    ])
      expect(seen.has(path)).toBe(true);
    const owner = "src/codegen/promises/promise-combinator-observable-protocol.ts";
    expect(() =>
      readHistoricalPromiseSuccessor(row.path, (path) => (path === owner ? raw(path) + "\n" : raw(path))),
    ).toThrow("historical-promise successor dependency mismatch: " + owner);
  });
});
