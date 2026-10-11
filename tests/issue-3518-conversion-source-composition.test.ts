// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { applyClosureApplyExtraction } from "./helpers/object-runtime-apply-extraction.js";
import { applyFnctorGuardForward } from "./helpers/object-runtime-fnctor-guard-forward.js";
import { describe, expect, it } from "vitest";
import { invertObjectRuntimeMainComposition } from "./helpers/object-runtime-main-composition.js";
import { invertObjectWriteSource } from "./helpers/native-object-write-donor.js";
import {
  applyConversionSpans,
  authenticateConversionComposition,
  authenticatedProtoIndexReadSource,
  conversionBase,
  conversionFixturePath,
  conversionSha,
  invertConversionSource,
  objectRuntimePath,
  protoIndexReadPath,
  protoIndexStorePath,
  readConversionSource,
  verifyConversionComposition,
} from "./helpers/conversion-source-composition.js";
import {
  verifyHistoricalObjectRuntimeComposition,
  verifyObjectRuntimeComposition,
  verifyPreWriteObjectRuntimeComposition,
} from "./helpers/object-get-key-composition.js";

const readerWith = (path: string, text: string) => (p: string) => (p === path ? text : readConversionSource(p));
const record = authenticateConversionComposition();
const originals = {
  [objectRuntimePath]: "c511036fa9b5a106e5c9a14d435a822114528b95eb10a039ce8cd13b4f7d91ac",
  [protoIndexStorePath]: "7fd8bed971077dced3f69ca65b7d10957d55bdee94f1af02a5128add2ce2d653",
};
describe("conversion changes compose before the unchanged getter/key donor chain", () => {
  it("reconstructs both exact signed 0ef8 source blobs and reciprocally reproduces current files", () => {
    expect(record.receipt.base).toBe(conversionBase);
    const restored = verifyConversionComposition();
    expect(restored.map((r) => r.path)).toEqual([objectRuntimePath, protoIndexStorePath]);
    for (const row of restored) {
      expect(conversionSha(row.original)).toBe(originals[row.path]);
      expect(row.original).not.toBe(row.current);
    }
    expect(record.receipt.records.map((r) => r.spans.length)).toEqual([3, 0]);
    expect(record.forward.records.filter((r) => r.path in originals).map((r) => r.spans.length)).toEqual([8, 6]);
    expect(record.presence.store.spans).toHaveLength(14);
    const historical = verifyObjectRuntimeComposition(readConversionSource(objectRuntimePath));
    expect(() => verifyHistoricalObjectRuntimeComposition(readConversionSource(objectRuntimePath))).toThrow(
      "peer span missing or duplicated",
    );
    expect(verifyHistoricalObjectRuntimeComposition(restored[0]!.original)).toEqual(historical);
    expect(conversionSha(historical.original)).toBe("692133e0345a24e3c45071ed031036b96dc3f6e7702dc358e2f99651820eed9e");
  });

  it("preserves all three extraction spans and their original full-source authority", () => {
    verifyConversionComposition();
    const row = record.receipt.records[0]!;
    const forward = record.forward.records.find((r) => r.path === row.path)!;
    const measured = applyConversionSpans(
      invertObjectRuntimeMainComposition(
        invertObjectWriteSource(
          row.path,
          applyFnctorGuardForward(applyClosureApplyExtraction(readConversionSource(row.path), true), true),
        ),
      ),
      forward.spans,
      true,
    );
    expect(conversionSha(measured)).toBe(row.extractionSha256);
    const original = applyConversionSpans(measured, row.spans, true);
    expect(conversionSha(original)).toBe(row.baseSha256);
    expect(applyConversionSpans(original, row.spans, false)).toBe(measured);
    for (const span of row.spans) {
      for (const replacement of [span.after + "/* corrupt */", "", span.after + span.after]) {
        const changed = measured.replace(span.after, replacement);
        expect(changed).not.toBe(measured);
        expect(() => {
          const result = applyConversionSpans(changed, row.spans, true);
          if (conversionSha(result) !== row.baseSha256) throw new Error("retained extraction source changed");
        }).toThrow();
      }
    }
    const first = row.spans[0]!.after;
    const last = row.spans.at(-1)!.after;
    const token = "__conversion_composition_reorder__";
    expect(measured).not.toContain(token);
    expect(() =>
      applyConversionSpans(measured.replace(first, token).replace(last, first).replace(token, last), row.spans, true),
    ).toThrow("span order mismatch");
  });

  it.each(["altered", "removed", "duplicated", "reordered"])(
    "positive first: %s reconstructed conversion spans cannot enter the old peer chain",
    (kind) => {
      const current = readConversionSource(objectRuntimePath);
      verifyObjectRuntimeComposition(current);
      const source = invertObjectWriteSource(
        objectRuntimePath,
        applyFnctorGuardForward(applyClosureApplyExtraction(current, true), true),
      );
      verifyPreWriteObjectRuntimeComposition(source);
      const spans = record.forward.records.find((r) => r.path === objectRuntimePath)!.spans;
      if (kind === "reordered") {
        const first = spans[0]!.after;
        const last = spans.at(-1)!.after;
        const token = "__conversion_forward_reorder__";
        expect(source).not.toContain(token);
        const changed = source.replace(first, token).replace(last, first).replace(token, last);
        expect(changed).not.toBe(source);
        expect(() => verifyPreWriteObjectRuntimeComposition(changed)).toThrow("span order mismatch");
      } else {
        for (const span of spans) {
          const replacement =
            kind === "removed"
              ? ""
              : kind === "duplicated"
                ? span.after + span.after
                : "/* altered */" + span.after.slice(1);
          const changed = source.replace(span.after, replacement);
          expect(changed).not.toBe(source);
          expect(() => verifyPreWriteObjectRuntimeComposition(changed)).toThrow("span missing or duplicated");
        }
      }
    },
  );

  it.each([objectRuntimePath, protoIndexStorePath])(
    "positive first: %s rejects unowned changes and old-source substitution",
    (path) => {
      const rows = verifyConversionComposition();
      const row = rows.find((r) => r.path === path)!;
      expect(() =>
        verifyConversionComposition(readerWith(path, row.current + "\n/* outside all declared spans */\n")),
      ).toThrow();
      expect(() => verifyConversionComposition(readerWith(path, row.original))).toThrow();
    },
  );

  it.each(record.presence.modules)("positive first: the real relocated $path is authenticated", (module) => {
    verifyConversionComposition();
    const source = readConversionSource(module.path);
    for (const changed of ["", source + "\n", source.replace("export", "/* changed */ export")]) {
      expect(changed).not.toBe(source);
      expect(() => verifyConversionComposition(readerWith(module.path, changed))).toThrow(
        "changed extracted presence module",
      );
    }
  });

  it("requires the actual read-helper body and its compatibility export binding", () => {
    verifyConversionComposition();
    const current = authenticatedProtoIndexReadSource();
    expect(current).toBe(readConversionSource(protoIndexReadPath));
    const changed = current.replace("accessorReceiver: accessorRecvLocal", "accessorReceiver: recvLocal");
    expect(changed).not.toBe(current);
    expect(() => authenticatedProtoIndexReadSource(readerWith(protoIndexReadPath, changed))).toThrow(
      "changed extracted presence module",
    );
    const store = readConversionSource(protoIndexStorePath);
    expect(store).toContain('from "./proto-index-read-bindings.js"');
    expect(() =>
      invertConversionSource(
        protoIndexStorePath,
        store.replace('from "./proto-index-read-bindings.js"', 'from "./foreign.js"'),
      ),
    ).toThrow("changed composed presence store");
  });

  it.each([
    conversionFixturePath,
    "tests/fixtures/issue-3518-to-primitive-wrapper-forward.json",
    "tests/fixtures/issue-3518-to-primitive-presence-extraction.json",
    "tests/fixtures/issue-3518-to-primitive-extraction-baseline.json",
  ])("positive first: changed %s cannot reseed any authority", (path) => {
    verifyConversionComposition();
    expect(() => verifyConversionComposition(readerWith(path, readConversionSource(path) + "\n"))).toThrow(
      "receipt digest mismatch",
    );
  });

  it("refuses unrecorded paths instead of treating an absent inventory as success", () => {
    verifyConversionComposition();
    expect(() => invertConversionSource("src/codegen/index.ts", readConversionSource("src/codegen/index.ts"))).toThrow(
      "unrecorded conversion source",
    );
  });
});
