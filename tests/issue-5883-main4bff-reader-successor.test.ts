// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  applyMain4bffSuccessorSource,
  authenticateMain4bffSuccessorReceipt,
  main4bffSuccessorReceiptPath,
  projectMain4bffSuccessorSource,
  readMain4bffSuccessorRaw as physicalRaw,
  readMain4bffSuccessorSource,
} from "./helpers/historical-promise-main4bff-successor.js";
import {
  applyHistoricalPromiseSuccessor,
  authenticateHistoricalPromiseSuccessors,
  historicalPromiseFixture,
  projectHistoricalPromiseSource,
} from "./helpers/historical-promise-successors.js";
import {
  applyMain5fEpochSource,
  main5fEpochFixture,
  projectMain5fEpochSource,
} from "./helpers/historical-promise-main5f-epoch.js";
const hash = (source: string): string => createHash("sha256").update(source).digest("hex");
const profiles = [
  {
    path: "src/codegen/context/types.ts",
    beforeBytes: 274246,
    afterBytes: 274362,
    beforeHash: "58f3fa0f768168bf654ea7dd4697ee59b25b9676bd60acd7865cb1c59d875c99",
    afterHash: "38399c87933f2812ad3f36b1e5a7199216d725da7560be33815982358da22b20",
    insertions: [
      {
        offset: 49941,
        text: "  /** (#6417) A `boolean` host callback: an i32 return boxes via `__box_boolean`. */\n  hostBooleanReturn?: boolean;\n",
      },
    ],
    retainedOffsets: [0, 50057],
  },
  {
    path: "src/codegen/object-runtime.ts",
    beforeBytes: 551621,
    afterBytes: 551964,
    beforeHash: "4faf6ce56327a9c46cb7479c7f11a16fc3c8ac219673cb38710b2fc0d66fe937",
    afterHash: "4e9d437a7ef699388b47e6d9e60adfaf4ada104c9ac02abff6ac9c5d322f461b",
    insertions: [
      {
        offset: 16553,
        text: 'import { ensureStandaloneTaSubclassParentCtor } from "./dataview-native.js"; // (#6651 V3) faithful TA subclass parent\n',
      },
      {
        offset: 34461,
        text: '  // (#6651 V3) number-element TypedArray parents construct for real.\n  const faithful = ensureStandaloneTaSubclassParentCtor(ctx, importName.slice("__new_".length), argCount);\n  if (faithful !== undefined) return faithful;\n',
      },
    ],
    retainedOffsets: [0, 16672, 34685],
  },
];
type Profile = (typeof profiles)[number];
function positive(profile: Profile) {
  const current = physicalRaw(profile.path);
  expect(Buffer.byteLength(current)).toBe(profile.afterBytes);
  expect(hash(current)).toBe(profile.afterHash);
  const prior = projectMain4bffSuccessorSource(profile.path, current);
  expect(Buffer.byteLength(prior)).toBe(profile.beforeBytes);
  expect(hash(prior)).toBe(profile.beforeHash);
  let explicit = current;
  for (const insertion of profile.insertions) {
    expect(current.indexOf(insertion.text)).toBe(insertion.offset);
    expect(current.split(insertion.text)).toHaveLength(2);
    explicit = explicit.replace(insertion.text, "");
  }
  expect(prior).toBe(explicit);
  expect(applyMain4bffSuccessorSource(profile.path, prior, false)).toBe(current);
  return { current, prior };
}
describe("exact two-path main4bff historical acquisition successor", () => {
  for (const profile of profiles)
    describe(profile.path, () => {
      it("pins complete endpoints and replays the new and unchanged main5f layers", () => {
        const { current, prior } = positive(profile);
        const historical = applyMain5fEpochSource(profile.path, prior, true);
        expect(applyMain5fEpochSource(profile.path, historical, false)).toBe(prior);
        expect(applyMain4bffSuccessorSource(profile.path, prior, false)).toBe(current);
        expect(() => applyMain5fEpochSource(profile.path, current, true)).toThrow(
          "main5f epoch input mismatch: " + profile.path,
        );
      });
      it("uses explicit source and one fresh authority read without a replacement source", () => {
        const { current, prior } = positive(profile);
        const seen: string[] = [];
        expect(
          projectMain4bffSuccessorSource(profile.path, current, (path) => {
            seen.push(path);
            if (path !== main4bffSuccessorReceiptPath) throw Error("replacement source read");
            return physicalRaw(path);
          }),
        ).toBe(prior);
        expect(seen).toEqual([main4bffSuccessorReceiptPath]);
      });
      for (const [ordinal, insertion] of profile.insertions.entries())
        for (const mutation of ["damage", "missing", "duplicate"] as const)
          it("rejects explicit insertion " + ordinal + " " + mutation, () => {
            const { current } = positive(profile);
            const replacement =
              mutation === "damage"
                ? "~" + insertion.text.slice(1)
                : mutation === "missing"
                  ? ""
                  : insertion.text + insertion.text;
            const changed = current.replace(insertion.text, replacement);
            expect(changed).not.toBe(current);
            expect(() => projectMain4bffSuccessorSource(profile.path, changed)).toThrow(
              "main4bff successor input mismatch: " + profile.path,
            );
          });
      for (const [ordinal, at] of profile.retainedOffsets.entries())
        it("rejects explicit retained-region mutation " + ordinal, () => {
          const { current } = positive(profile);
          const changed = current.slice(0, at) + (current[at] === "~" ? "!" : "~") + current.slice(at + 1);
          expect(changed).not.toBe(current);
          expect(() => projectMain4bffSuccessorSource(profile.path, changed)).toThrow(
            "main4bff successor input mismatch: " + profile.path,
          );
        });
      for (const inverse of [true, false])
        it("rejects wrong epoch and double application, inverse=" + inverse, () => {
          const { current, prior } = positive(profile);
          expect(() => applyMain4bffSuccessorSource(profile.path, inverse ? prior : current, inverse)).toThrow(
            "main4bff successor input mismatch: " + profile.path,
          );
        });
      it("recaptures physical mutation and restoration with the same reader", () => {
        const { current, prior } = positive(profile);
        let source = current;
        const seen: string[] = [];
        const reader = (path: string): string => {
          seen.push(path);
          return path === profile.path ? source : physicalRaw(path);
        };
        expect(readMain4bffSuccessorSource(profile.path, reader)).toBe(prior);
        source += "\n";
        expect(() => readMain4bffSuccessorSource(profile.path, reader)).toThrow(
          "main4bff successor input mismatch: " + profile.path,
        );
        source = current;
        expect(readMain4bffSuccessorSource(profile.path, reader)).toBe(prior);
        expect(seen).toEqual([
          profile.path,
          main4bffSuccessorReceiptPath,
          profile.path,
          main4bffSuccessorReceiptPath,
          profile.path,
          main4bffSuccessorReceiptPath,
        ]);
      });
      it("recaptures receipt mutation and restoration with the same reader", () => {
        const { current, prior } = positive(profile);
        const original = physicalRaw(main4bffSuccessorReceiptPath);
        let receipt = original;
        const reader = (): string => receipt;
        expect(projectMain4bffSuccessorSource(profile.path, current, reader)).toBe(prior);
        receipt += "\n";
        expect(() => projectMain4bffSuccessorSource(profile.path, current, reader)).toThrow(
          "main4bff successor receipt mismatch",
        );
        receipt = original;
        expect(projectMain4bffSuccessorSource(profile.path, current, reader)).toBe(prior);
      });
      it("preserves explicit main5f mutants, their error owner and authority read trace", () => {
        const { prior } = positive(profile),
          seen: string[] = [];
        const changed = prior + "\n";
        expect(changed).not.toBe(prior);
        expect(() =>
          applyMain5fEpochSource(profile.path, changed, true, undefined, (path) => {
            seen.push(path);
            return physicalRaw(path);
          }),
        ).toThrow("main5f epoch input mismatch: " + profile.path);
        expect(seen).toEqual([main5fEpochFixture]);
      });
      it("retains complete causes under the historical dependency missing and mismatch owners", () => {
        authenticateHistoricalPromiseSuccessors();
        const physicalFailure = Error("missing physical source");
        let missing: unknown;
        try {
          authenticateHistoricalPromiseSuccessors(physicalRaw(historicalPromiseFixture), (path) => {
            if (path === profile.path) throw physicalFailure;
            return physicalRaw(path);
          });
        } catch (error) {
          missing = error;
        }
        expect(missing).toBeInstanceOf(Error);
        expect((missing as Error).message).toBe("historical-promise successor dependency missing: " + profile.path);
        expect((missing as Error).cause).toBe(physicalFailure);
        let changed: unknown;
        try {
          authenticateHistoricalPromiseSuccessors(
            physicalRaw(historicalPromiseFixture),
            (path) => physicalRaw(path) + (path === profile.path ? "\n" : ""),
          );
        } catch (error) {
          changed = error;
        }
        expect(changed).toBeInstanceOf(Error);
        expect((changed as Error).message).toBe("historical-promise successor dependency mismatch: " + profile.path);
        expect(((changed as Error).cause as Error).message).toBe("main4bff successor input mismatch: " + profile.path);
      });
      it("does not fall back when supplied authority is missing", () => {
        const { current } = positive(profile),
          missing = Error("missing supplied successor receipt");
        expect(() =>
          projectMain4bffSuccessorSource(profile.path, current, () => {
            throw missing;
          }),
        ).toThrow(missing);
      });
      it("rejects nontext owned input before authority I/O", () => {
        expect(() =>
          projectMain4bffSuccessorSource(profile.path, undefined as unknown as string, () => {
            throw Error("unexpected authority read");
          }),
        ).toThrow("main4bff successor input must be text");
      });
    });
  it("pins the exact two-path receipt while preserving immutable main5f authority", () => {
    const receipt = authenticateMain4bffSuccessorReceipt();
    expect(receipt.records.map((row) => row.path)).toEqual([
      "src/codegen/context/types.ts",
      "src/codegen/object-runtime.ts",
    ]);
    expect(receipt.records.map((row) => row.spans.length)).toEqual([1, 2]);
    expect(receipt.records.map((row) => row.retained.length)).toEqual([2, 3]);
    expect(hash(physicalRaw(main4bffSuccessorReceiptPath))).toBe(
      "c5d6dd1866cb5db4f21affcabc93e1810036d7921ff91e85a5e7dde3e74ea836",
    );
    expect(hash(physicalRaw(main5fEpochFixture))).toBe(
      "c33cc1682761adb29ea8f1ca83b6682d265ab3533f6f4383e976734fc3479bcd",
    );
  });
  for (const mutation of [
    "missing-path",
    "duplicate-path",
    "reordered-paths",
    "endpoint",
    "span",
    "offset",
    "retained",
    "missing-span",
  ] as const)
    it("rejects supplied receipt mutation: " + mutation, () => {
      const { current } = positive(profiles[1]!);
      const r = authenticateMain4bffSuccessorReceipt(physicalRaw(main4bffSuccessorReceiptPath));
      if (mutation === "missing-path") r.records.pop();
      else if (mutation === "duplicate-path") r.records[1] = r.records[0]!;
      else if (mutation === "reordered-paths") r.records.reverse();
      else if (mutation === "endpoint") r.records[1]!.after.sha256 = "0".repeat(64);
      else if (mutation === "span") r.records[1]!.spans[1]!.after += "\n";
      else if (mutation === "offset") r.records[1]!.spans[1]!.afterOffset++;
      else if (mutation === "retained") r.records[1]!.retained[1]!.sha256 = "0".repeat(64);
      else r.records[1]!.spans.pop();
      expect(() => projectMain4bffSuccessorSource(profiles[1]!.path, current, () => JSON.stringify(r))).toThrow(
        "main4bff successor receipt mismatch",
      );
    });
  it("passes foreign explicit source unchanged with no reads", () => {
    expect(
      projectMain4bffSuccessorSource("foreign", "supplied bytes", () => {
        throw Error("unexpected read");
      }),
    ).toBe("supplied bytes");
  });
  it("captures a foreign physical source once with no authority read", () => {
    const seen: string[] = [];
    expect(
      readMain4bffSuccessorSource("foreign", (path) => {
        seen.push(path);
        return "physical bytes";
      }),
    ).toBe("physical bytes");
    expect(seen).toEqual(["foreign"]);
  });
  it("rejects foreign transform before reading authority", () => {
    expect(() =>
      applyMain4bffSuccessorSource("foreign", "supplied bytes", true, () => {
        throw Error("unexpected read");
      }),
    ).toThrow("unrecorded main4bff successor source");
  });
  it("authenticates the complete 27-dependency and seven-operand historical closure after composition", () => {
    const seen: string[] = [];
    const reader = (path: string): string => {
      seen.push(path);
      return physicalRaw(path);
    };
    const receipt = authenticateHistoricalPromiseSuccessors(physicalRaw(historicalPromiseFixture), reader);
    expect(receipt.dependencies).toHaveLength(27);
    expect(receipt.records).toHaveLength(7);
    expect(seen.filter((path) => path === main4bffSuccessorReceiptPath)).toEqual([
      main4bffSuccessorReceiptPath,
      main4bffSuccessorReceiptPath,
    ]);
    for (const row of receipt.dependencies) {
      expect(seen.filter((path) => path === row.path)).toHaveLength(1);
      const predecessor = readMain4bffSuccessorSource(row.path, physicalRaw);
      expect(hash(projectMain5fEpochSource(row.path, predecessor))).toBe(row.sha256);
    }
    for (const row of receipt.records) {
      expect(seen.filter((path) => path === row.path)).toHaveLength(1);
      const current = physicalRaw(row.path);
      expect(hash(projectMain5fEpochSource(row.path, projectMain4bffSuccessorSource(row.path, current)))).toBe(
        row.rawAfter.sha256,
      );
      const projected = projectHistoricalPromiseSource(row.path, current);
      expect(hash(projected)).toBe(row.after.sha256);
      const prior = applyHistoricalPromiseSuccessor(row.path, projected, true);
      expect(hash(prior)).toBe(row.before.sha256);
      expect(applyHistoricalPromiseSuccessor(row.path, prior, false)).toBe(projected);
    }
  });
});
