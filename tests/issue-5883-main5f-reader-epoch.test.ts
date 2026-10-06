// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { readMain4bffSuccessorSource } from "./helpers/historical-promise-main4bff-successor.js";
import {
  applyMain5fEpochSource,
  authenticateMain5fEpoch,
  createMain5fEpochProjection,
  main5fEpochBlob,
  main5fEpochFixture,
  main5fEpochHash,
  main5fEpochPaths,
  main5fEpochReceiptHash,
  projectMain5fEpochSource,
  type Main5fEpochReceipt,
  type Main5fEpochRecord,
} from "./helpers/historical-promise-main5f-epoch.js";
import {
  authenticateHistoricalPromiseSuccessors,
  historicalPromiseFixture,
  projectHistoricalPromiseSource,
  readHistoricalPromiseRaw as raw,
  readHistoricalPromiseSuccessor,
} from "./helpers/historical-promise-successors.js";

const receiptText = raw(main5fEpochFixture);
const receipt = authenticateMain5fEpoch(receiptText);
const oldReceiptText = raw(historicalPromiseFixture);
function positive(row: Main5fEpochRecord) {
  const current = readMain4bffSuccessorSource(row.path, raw);
  expect(main5fEpochHash(current)).toBe(row.after.sha256);
  expect(main5fEpochBlob(current)).toBe(row.after.gitBlob);
  const prior = applyMain5fEpochSource(row.path, current, true, receiptText);
  expect(main5fEpochHash(prior)).toBe(row.before.sha256);
  expect(main5fEpochBlob(prior)).toBe(row.before.gitBlob);
  expect(applyMain5fEpochSource(row.path, prior, false, receiptText)).toBe(current);
  return { current, prior };
}

describe("main5f seven-path historical reader epoch (separate new population)", () => {
  it("pins seven composed endpoints, 30 spans, 37 retained regions and both merge parents", () => {
    expect(main5fEpochHash(receiptText)).toBe(main5fEpochReceiptHash);
    expect(receipt.records.map((row) => row.path)).toEqual(main5fEpochPaths);
    expect(receipt.records.map((row) => row.spans.length)).toEqual([2, 6, 2, 3, 13, 3, 1]);
    expect(receipt.records.reduce((n, row) => n + row.retained.length, 0)).toBe(37);
    expect(receipt.records.filter((row) => !row.equalsIncoming).map((row) => row.path)).toEqual([
      "src/codegen/context/create-context.ts",
      "src/codegen/context/types.ts",
    ]);
    expect(receipt.mergeParents).toEqual([receipt.beforeCommit, receipt.incomingCommit]);
    expect(receipt.provenance).toHaveLength(18);
    for (const producer of receipt.provenance)
      for (const change of producer.sourceChanges)
        expect(change.parents.map((parent) => parent.commit)).toEqual(producer.parents);
  });
  it("preserves the complete original control suite as nonexecuted evidence and records the failure", () => {
    const evidence = raw(receipt.historicalEvidence.path);
    expect(main5fEpochHash(evidence)).toBe(receipt.historicalEvidence.sha256);
    expect(main5fEpochBlob(evidence)).toBe(receipt.historicalEvidence.gitBlob);
    expect(Buffer.byteLength(evidence)).toBe(13581);
    expect(evidence).toContain('it("keeps three already-matching dependency sources raw, with no unnecessary inverse"');
    expect(receipt.historicalEvidence.observedFailure).toBe(
      "historical-promise successor dependency mismatch: src/codegen/carrier-bag-visibility.ts",
    );
    expect(main5fEpochHash(oldReceiptText)).toBe(receipt.oldReceipt.sha256);
    expect(main5fEpochBlob(oldReceiptText)).toBe(receipt.oldReceipt.gitBlob);
  });
  for (const row of receipt.records) {
    it("recovers and replays the complete source and every retained region: " + row.path, () => {
      const { current, prior } = positive(row);
      for (const keep of row.retained) {
        const before = prior.slice(keep.beforeOffset, keep.beforeOffset + keep.length);
        expect(current.slice(keep.afterOffset, keep.afterOffset + keep.length)).toBe(before);
        expect(main5fEpochHash(before)).toBe(keep.sha256);
      }
      expect(projectMain5fEpochSource(row.path, current)).toBe(prior);
      if (row.role === "dependency") expect(readHistoricalPromiseSuccessor(row.path)).toBe(prior);
      else expect(projectHistoricalPromiseSource(row.path, current)).toBe(prior);
    });
    it("uses explicit input and supplied authority without reading a replacement source: " + row.path, () => {
      const { current, prior } = positive(row);
      const seen: string[] = [];
      const reader = (path: string): string => {
        seen.push(path);
        if (path !== main5fEpochFixture) throw Error("unexpected replacement read: " + path);
        return receiptText;
      };
      expect(applyMain5fEpochSource(row.path, current, true, undefined, reader)).toBe(prior);
      expect(seen).toEqual([main5fEpochFixture]);
      expect(() => applyMain5fEpochSource(row.path, current + "\n", true, undefined, reader)).toThrow(
        "main5f epoch input mismatch: " + row.path,
      );
      expect(() =>
        projectMain5fEpochSource(row.path, current, () => {
          throw Error("missing supplied authority");
        }),
      ).toThrow("missing supplied authority");
    });
    for (const inverse of [true, false] as const) {
      it(`refuses wrong direction and double application: ${row.path}, inverse=${inverse}`, () => {
        const { current, prior } = positive(row);
        expect(() => applyMain5fEpochSource(row.path, inverse ? prior : current, inverse, receiptText)).toThrow(
          "main5f epoch input mismatch: " + row.path,
        );
      });
      for (const span of row.spans)
        for (const mutation of ["damage", "delete", "duplicate"] as const) {
          const from = inverse ? span.after : span.before;
          if (!from.length) continue; // Empty insertion endpoints use offsets, never an empty-string search.
          it(`refuses ${mutation} of explicit span ${row.path}:${span.ordinal}, inverse=${inverse}`, () => {
            const { current, prior } = positive(row);
            const source = inverse ? current : prior;
            const at = inverse ? span.afterOffset : span.beforeOffset;
            const changed =
              source.slice(0, at) +
              (mutation === "damage" ? "~" + from.slice(1) : mutation === "delete" ? "" : from + from) +
              source.slice(at + from.length);
            expect(changed).not.toBe(source);
            expect(() => applyMain5fEpochSource(row.path, changed, inverse, receiptText)).toThrow(
              "main5f epoch input mismatch: " + row.path,
            );
          });
        }
      for (const [ordinal, keep] of row.retained.entries()) {
        if (!keep.length) continue;
        it(`refuses changed retained region ${row.path}:${ordinal}, inverse=${inverse}`, () => {
          const { current, prior } = positive(row);
          const source = inverse ? current : prior;
          const at = inverse ? keep.afterOffset : keep.beforeOffset;
          const changed = source.slice(0, at) + (source[at] === "~" ? "!" : "~") + source.slice(at + 1);
          expect(() => applyMain5fEpochSource(row.path, changed, inverse, receiptText)).toThrow(
            "main5f epoch input mismatch: " + row.path,
          );
        });
      }
    }
    for (const mutation of ["missing", "changed", "old-epoch"] as const)
      it(`preserves the supplied raw-reader refusal: ${row.path}, ${mutation}`, () => {
        const { prior } = positive(row);
        const reader = (path: string): string => {
          if (path !== row.path) return raw(path);
          if (mutation === "missing") throw Error("missing supplied current source");
          return mutation === "old-epoch" ? prior : raw(path) + "\n// tampered current input\n";
        };
        const role = row.role === "dependency" ? "dependency" : "current operand";
        expect(() => authenticateHistoricalPromiseSuccessors(oldReceiptText, reader)).toThrow(
          `historical-promise successor ${role} ${mutation === "missing" ? "missing" : "mismatch"}: ${row.path}`,
        );
      });
  }
  const mutations: [string, (r: Main5fEpochReceipt) => void][] = [
    [
      "missing path",
      (r) => {
        r.records.pop();
      },
    ],
    [
      "extra path",
      (r) => {
        r.records.push({ ...r.records[0]!, path: "unowned" });
      },
    ],
    [
      "duplicate path",
      (r) => {
        r.records[1] = r.records[0]!;
      },
    ],
    [
      "reordered paths",
      (r) => {
        r.records.reverse();
      },
    ],
    [
      "forged span",
      (r) => {
        r.records[0]!.spans[0]!.after += "x";
      },
    ],
    [
      "missing span",
      (r) => {
        r.records[0]!.spans.pop();
      },
    ],
    [
      "duplicate span",
      (r) => {
        r.records[0]!.spans.push(r.records[0]!.spans[0]!);
      },
    ],
    [
      "reordered spans",
      (r) => {
        r.records[0]!.spans.reverse();
      },
    ],
    [
      "wrong offset",
      (r) => {
        r.records[0]!.spans[0]!.afterOffset++;
      },
    ],
    [
      "wrong empty insertion offset",
      (r) => {
        r.records[0]!.spans[0]!.beforeOffset++;
      },
    ],
    [
      "forged retained hash",
      (r) => {
        r.records[0]!.retained[0]!.sha256 = "0".repeat(64);
      },
    ],
    [
      "missing retained region",
      (r) => {
        r.records[0]!.retained.pop();
      },
    ],
    [
      "forged endpoint",
      (r) => {
        r.records[0]!.after.sha256 = "0".repeat(64);
      },
    ],
    [
      "false context main identity",
      (r) => {
        r.records[2]!.equalsIncoming = true;
      },
    ],
    [
      "wrong parent",
      (r) => {
        r.mergeParents.reverse();
      },
    ],
    [
      "missing producer",
      (r) => {
        r.provenance.pop();
      },
    ],
    [
      "forged producer parent",
      (r) => {
        r.provenance[0]!.parents[0] = "0".repeat(40);
      },
    ],
    [
      "forged historical evidence",
      (r) => {
        r.historicalEvidence.sha256 = "0".repeat(64);
      },
    ],
    [
      "forged old receipt",
      (r) => {
        r.oldReceipt.sha256 = "0".repeat(64);
      },
    ],
  ];
  for (const [name, mutate] of mutations)
    it("rejects independent receipt tampering: " + name, () => {
      positive(receipt.records[0]!);
      const changed = JSON.parse(receiptText) as Main5fEpochReceipt;
      mutate(changed);
      const text = JSON.stringify(changed, null, 2) + "\n";
      expect(text).not.toBe(receiptText);
      expect(() => authenticateMain5fEpoch(text)).toThrow("main5f epoch receipt mismatch");
      expect(() => applyMain5fEpochSource(receipt.records[0]!.path, raw(receipt.records[0]!.path), true, text)).toThrow(
        "main5f epoch receipt mismatch",
      );
    });
  it("uses supplied receipt bytes at integration, never falls back to disk authority", () => {
    authenticateHistoricalPromiseSuccessors(oldReceiptText);
    expect(() =>
      authenticateHistoricalPromiseSuccessors(
        oldReceiptText,
        (path) => raw(path) + (path === main5fEpochFixture ? "\n" : ""),
      ),
    ).toThrow("main5f epoch receipt mismatch");
    expect(() =>
      createMain5fEpochProjection(() => {
        throw Error("missing epoch receipt");
      }),
    ).toThrow("missing epoch receipt");
  });
  it("passes unrelated explicit input through without any read, and rejects unknown transforms", () => {
    const forbidden = (): string => {
      throw Error("unexpected disk or authority read");
    };
    expect(projectMain5fEpochSource("unowned", "supplied bytes", forbidden)).toBe("supplied bytes");
    expect(readHistoricalPromiseSuccessor("unowned", () => "supplied bytes")).toBe("supplied bytes");
    expect(() => applyMain5fEpochSource("unowned", "supplied bytes", true, undefined, forbidden)).toThrow(
      "unrecorded main5f epoch source",
    );
  });
});
