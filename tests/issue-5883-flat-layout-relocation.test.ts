// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  applyFlatLayoutRelocation,
  authenticateFlatLayoutRelocation,
  flatLayoutFixture,
  flatLayoutDrivePath,
  flatLayoutHash,
  flatLayoutBlob,
  readBeforeFlatLayoutDrive,
  readFlatLayoutSource,
  type FlatLayoutReader,
  type FlatLayoutReceipt,
  type FlatLayoutRecord,
} from "./helpers/flat-layout-relocation.js";
import { readPromiseExportSource } from "./helpers/promise-export-main-port.js";

const receipt = JSON.parse(readFlatLayoutSource(flatLayoutFixture)) as FlatLayoutReceipt;
function positive(row: FlatLayoutRecord) {
  const after = readFlatLayoutSource(row.afterPath);
  const before = applyFlatLayoutRelocation(row.afterPath, after, true);
  expect([flatLayoutHash(after), flatLayoutBlob(after)]).toEqual([row.after.sha256, row.after.gitBlob]);
  expect([flatLayoutHash(before), flatLayoutBlob(before)]).toEqual([row.before.sha256, row.before.gitBlob]);
  expect(applyFlatLayoutRelocation(row.afterPath, before, false)).toBe(after);
  return { before, after };
}
function substitute(path: string, source: string): FlatLayoutReader {
  return (requested) => (requested === path ? source : readFlatLayoutSource(requested));
}

for (const row of receipt.records)
  describe("authenticated flat relocation: " + row.afterPath, () => {
    it("reconstructs every published byte and reciprocally reproduces the actual moved module", () => {
      positive(row);
    });
    for (const span of row.spans) {
      for (const mutation of ["damaged", "missing", "duplicate", "shifted offset"] as const) {
        it(`refuses ${mutation} span ${span.ordinal} after a real positive`, () => {
          const { after } = positive(row),
            at = span.afterOffset;
          expect(after.indexOf(span.after)).toBe(at);
          const mutant =
            mutation === "damaged"
              ? after.slice(0, at) + "!" + after.slice(at + 1)
              : mutation === "missing"
                ? after.slice(0, at) + after.slice(at + span.after.length)
                : mutation === "duplicate"
                  ? after + span.after
                  : after.slice(0, at) + " " + after.slice(at);
          expect(mutant).not.toBe(after);
          expect(() => applyFlatLayoutRelocation(row.afterPath, mutant, true)).toThrow(/flat-layout span/);
        });
      }
    }
    if (row.spans.length > 1)
      it("refuses reordered unique spans after a real positive", () => {
        const { after } = positive(row),
          first = row.spans[0]!,
          second = row.spans[1]!;
        const mutant =
          after.slice(0, first.afterOffset) +
          second.after +
          after.slice(first.afterOffset + first.after.length, second.afterOffset) +
          first.after +
          after.slice(second.afterOffset + second.after.length);
        expect(mutant).not.toBe(after);
        expect(() => applyFlatLayoutRelocation(row.afterPath, mutant, true)).toThrow(/order or offset mismatch/);
      });
    it("refuses retained-byte changes outside every owned import span", () => {
      const { after } = positive(row);
      expect(() => applyFlatLayoutRelocation(row.afterPath, after + "\n// unowned\n", true)).toThrow(
        /retained input mismatch/,
      );
    });
    it("refuses both wrong directions and never admits already-historical input", () => {
      const { before, after } = positive(row);
      expect(() => applyFlatLayoutRelocation(row.afterPath, before, true)).toThrow(/flat-layout/);
      expect(() => applyFlatLayoutRelocation(row.afterPath, after, false)).toThrow(/flat-layout/);
    });
    it("refuses changed receipt bytes supplied by the injected raw reader", () => {
      const { after } = positive(row);
      const changed = structuredClone(receipt);
      changed.records.find((record) => record.afterPath === row.afterPath)!.spans[0]!.afterOffset++;
      expect(() =>
        applyFlatLayoutRelocation(
          row.afterPath,
          after,
          true,
          undefined,
          substitute(flatLayoutFixture, JSON.stringify(changed)),
        ),
      ).toThrow(/receipt mismatch/);
    });
    it("refuses an unknown explicit transform path", () => {
      const { after } = positive(row);
      expect(() => applyFlatLayoutRelocation("src/unrecorded.ts", after, true)).toThrow(/unrecorded/);
    });
  });

for (const dependency of receipt.dependencies) {
  it("refuses changed moved-owner dependency: " + dependency.path, () => {
    positive(receipt.records[3]!);
    const reads: string[] = [];
    const reader: FlatLayoutReader = (path) => {
      reads.push(path);
      return readFlatLayoutSource(path) + (path === dependency.path ? "\n// changed owner\n" : "");
    };
    expect(() => authenticateFlatLayoutRelocation(undefined, reader)).toThrow(/dependency mismatch/);
    expect(reads).toContain(dependency.path);
  });
  it("refuses missing moved-owner dependency without disk fallback: " + dependency.path, () => {
    positive(receipt.records[3]!);
    const reader: FlatLayoutReader = (path) => {
      if (path === dependency.path) throw Error("injected missing owner");
      return readFlatLayoutSource(path);
    };
    expect(() => authenticateFlatLayoutRelocation(undefined, reader)).toThrow(/dependency missing/);
  });
}

it("peels the drive import exactly once at the original default-reader seam", () => {
  const row = receipt.records[3]!,
    { before } = positive(row);
  expect(readBeforeFlatLayoutDrive(flatLayoutDrivePath)).toBe(before);
  expect(readPromiseExportSource(flatLayoutDrivePath)).toBe(before);
  expect(() => applyFlatLayoutRelocation(flatLayoutDrivePath, before, true)).toThrow(/flat-layout/);
});
it("leaves all other paths raw and honors an injected reader without extra reads", () => {
  const row = receipt.records[0]!,
    { after } = positive(row);
  expect(readPromiseExportSource(row.afterPath)).toBe(after);
  const reads: string[] = [];
  const reader: FlatLayoutReader = (path) => {
    reads.push(path);
    return "injected raw";
  };
  expect(readBeforeFlatLayoutDrive("unknown/path", reader)).toBe("injected raw");
  expect(reads).toEqual(["unknown/path"]);
});
it("never substitutes disk bytes for explicit mutated drive input", () => {
  const row = receipt.records[3]!,
    { after } = positive(row);
  expect(() => applyFlatLayoutRelocation(row.afterPath, after + "\n// explicit mutation\n", true)).toThrow(
    /retained input mismatch/,
  );
});
it("keeps injected mutated drive bytes observable at the initial reader boundary", () => {
  const row = receipt.records[3]!,
    { after } = positive(row);
  expect(() =>
    readBeforeFlatLayoutDrive(row.afterPath, substitute(row.afterPath, after + "\n// injected mutation\n")),
  ).toThrow(/retained input mismatch/);
});
