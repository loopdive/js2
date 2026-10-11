// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { applyClosureApplyExtraction } from "./helpers/object-runtime-apply-extraction.js";
import { applyFnctorGuardForward } from "./helpers/object-runtime-fnctor-guard-forward.js";
import { describe, expect, it } from "vitest";
import {
  authenticateWriteExtraction,
  invertObjectWriteSource,
  originalWriteDonors,
  readWriteSource,
  replayObjectWriteSource,
  writeDonorPath,
  writeExtractionPath,
  writeSourceHash,
} from "./helpers/native-object-write-donor.js";
import { objectRuntimePath, verifyConversionComposition } from "./helpers/conversion-source-composition.js";
import {
  verifyObjectRuntimeComposition as verifyCurrentObjectRuntimeComposition,
  verifyPreWriteObjectRuntimeComposition,
} from "./helpers/object-get-key-composition.js";
import { verifyObjectRuntimeMainComposition } from "./helpers/object-runtime-main-composition.js";

const actual = readWriteSource(objectRuntimePath);
const current = applyFnctorGuardForward(applyClosureApplyExtraction(actual, true), true);
const replayOuter = (source: string) => applyClosureApplyExtraction(applyFnctorGuardForward(source, false), false);
const verifyObjectRuntimeComposition = (source: string) => verifyCurrentObjectRuntimeComposition(replayOuter(source));
const receipt = authenticateWriteExtraction();
const delta = receipt.deltas.find((row) => row.file === objectRuntimePath)!;
const readerWith = (path: string, text: string) => (file: string) =>
  file === path ? (path === objectRuntimePath ? replayOuter(text) : text) : readWriteSource(file);

function positive() {
  expect(replayOuter(current)).toBe(actual);
  const historical = verifyObjectRuntimeComposition(current);
  const before = invertObjectWriteSource(objectRuntimePath, current);
  expect(replayObjectWriteSource(objectRuntimePath, before)).toBe(current);
  expect(verifyPreWriteObjectRuntimeComposition(before)).toEqual(historical);
  return before;
}

describe("storage extraction precedes the unchanged full-source preservation chain", () => {
  it("reconstructs the exact signed write donor and preserves every earlier full-source authority", () => {
    const before = positive();
    const donor = originalWriteDonors().find((row) => row.file === objectRuntimePath)!;
    expect(before).toBe(donor.source);
    expect(writeSourceHash(before)).toBe("f1c8179b216fda0565b8cbf7286c92a8d2ca6e4efa5688984a1ebfe6a72f2ab0");
    expect(donor.gitBlob).toBe("b159de4cf8bc7af3d89ddca3b2d31dcd3ce46529");
    expect(writeSourceHash(verifyObjectRuntimeMainComposition(before))).toBe(
      "2cc32a6af0e913340ac8a27c77befb6b345a61688893aa1cb3fc29d6161719b7",
    );
    expect(verifyConversionComposition().map((row) => writeSourceHash(row.original))).toEqual([
      "c511036fa9b5a106e5c9a14d435a822114528b95eb10a039ce8cd13b4f7d91ac",
      "7fd8bed971077dced3f69ca65b7d10957d55bdee94f1af02a5128add2ce2d653",
    ]);
    expect(delta.spans).toHaveLength(4);
  });

  it.each(delta.spans.map((span, ordinal) => ({ span, ordinal })))(
    "positive first: current write span $ordinal rejects altered, removed and duplicated bytes",
    ({ span }) => {
      positive();
      expect(current.split(span.after)).toHaveLength(2);
      const altered = span.after.replace(/\S/, (character) => (character === "~" ? "!" : "~"));
      for (const replacement of [altered, "", span.after + span.after]) {
        const changed = current.replace(span.after, replacement);
        expect(changed).not.toBe(current);
        expect(() => verifyObjectRuntimeComposition(changed)).toThrow("write extraction source mismatch");
        expect(() => verifyConversionComposition(readerWith(objectRuntimePath, changed))).toThrow(
          "write extraction source mismatch",
        );
      }
    },
  );

  it("positive first: reversed write spans cannot reach an older validator", () => {
    positive();
    const first = delta.spans[0]!.after;
    const last = delta.spans.at(-1)!.after;
    const marker = "__write_composition_reorder__";
    expect(current).not.toContain(marker);
    const changed = current.replace(first, marker).replace(last, first).replace(marker, last);
    expect(changed).not.toBe(current);
    expect(() => verifyObjectRuntimeComposition(changed)).toThrow("write extraction source mismatch");
  });

  it("positive first: outside edits and old-source substitution remain rejected", () => {
    const before = positive();
    const retained = 'name: "previousActive"';
    expect(current.split(retained)).toHaveLength(2);
    expect(delta.spans.every((span) => !span.after.includes(retained))).toBe(true);
    const changed = current.replace(retained, 'name: "corruptedActive"');
    expect(changed).not.toBe(current);
    for (const invalid of [changed, current + "\n", before]) {
      expect(() => verifyObjectRuntimeComposition(invalid)).toThrow("write extraction source mismatch");
      expect(() => verifyConversionComposition(readerWith(objectRuntimePath, invalid))).toThrow(
        "write extraction source mismatch",
      );
    }
    expect(() => replayObjectWriteSource(objectRuntimePath, before + "\n")).toThrow("write donor base mismatch");
  });

  it.each(Object.keys(receipt.modules))("positive first: actual relocated %s remains bound to the inverse", (path) => {
    positive();
    const source = readWriteSource(path);
    for (const changed of ["", source + "\n", source.replace("export", "/* changed */ export")]) {
      expect(changed).not.toBe(source);
      expect(() => verifyConversionComposition(readerWith(path, changed))).toThrow("write relocated module mismatch");
    }
  });

  it.each([writeDonorPath, writeExtractionPath])("positive first: changed %s cannot reseed history", (path) => {
    positive();
    expect(() => verifyConversionComposition(readerWith(path, readWriteSource(path) + "\n"))).toThrow(
      path === writeDonorPath ? "write donor fixture mismatch" : "write extraction receipt mismatch",
    );
  });

  it("refuses an unrecorded write path instead of treating it as an empty composition", () => {
    positive();
    expect(() => invertObjectWriteSource("src/codegen/index.ts", readWriteSource("src/codegen/index.ts"))).toThrow(
      "unknown write donor path",
    );
  });
});
