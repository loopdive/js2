// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyTypedArrayMainPreservation,
  authenticateTypedArrayMainPreservation,
  beforeTypedArrayMainPreservation,
  readTypedArrayMainActualSource,
  typedArrayMainBlob,
  typedArrayMainCommit,
  typedArrayMainCurrent,
  typedArrayMainDependency,
  typedArrayMainFixture,
  typedArrayMainHash,
  typedArrayMainPath,
  typedArrayMainPrior,
} from "./helpers/typedarray-main-preservation-port.js";
import {
  applyLaterMainPreservation,
  authenticateLaterMainPreservation,
  laterMainDependencies,
  laterMainFixture,
  laterMainPaths,
  readBeforeLaterMainPreservation,
  readLaterMainActualSource,
  readLaterMainPreservationInput,
} from "./helpers/later-main-preservation-port.js";
import { readBeforeClosureComposition } from "./helpers/closure-source-composition.js";

afterEach(async () => {
  await setImmediate();
});
const receiptText = readTypedArrayMainActualSource(typedArrayMainFixture);
const receipt = authenticateTypedArrayMainPreservation(receiptText);
const row = receipt.records[0]!;
const directions = [true, false] as const;
const damage = (text: string) => text.replace(/\S/, (character) => (character === "~" ? "!" : "~"));

function positive() {
  const current = readTypedArrayMainActualSource(typedArrayMainPath);
  const prior = applyTypedArrayMainPreservation(typedArrayMainPath, current, true);
  for (const [source, pin] of [
    [current, row.after],
    [prior, row.before],
  ] as const) {
    expect(typedArrayMainHash(source)).toBe(pin.sha256);
    expect(typedArrayMainBlob(source)).toBe(pin.gitBlob);
    expect(Buffer.byteLength(source)).toBe(pin.bytes);
    expect(source.length).toBe(pin.utf16Units);
    expect(source.length).toBeGreaterThan(500_000);
  }
  expect(prior).not.toBe(current);
  expect(applyTypedArrayMainPreservation(typedArrayMainPath, prior, false)).toBe(current);
  expect(beforeTypedArrayMainPreservation(typedArrayMainPath, current)).toBe(prior);
  return { current, prior };
}

describe("fixed TypedArray main preservation transport", () => {
  it("pins one published feature, two contextual spans and the actual imported implementation", () => {
    positive();
    expect(receipt.priorCommit).toBe(typedArrayMainPrior);
    expect(receipt.currentCommit).toBe(typedArrayMainCurrent);
    expect(receipt.sourceCommit).toBe(typedArrayMainCommit);
    expect(receipt.records.map((record) => record.path)).toEqual([typedArrayMainPath]);
    expect(row.spans.map((span) => span.ordinal)).toEqual([0, 1]);
    expect(row.spans.map((span) => [span.beforeOffset, span.afterOffset])).toEqual([
      [3438, 3438],
      [268847, 268947],
    ]);
    expect(receipt.dependencies.map((dependency) => dependency.path)).toEqual([typedArrayMainDependency]);
  });

  for (const span of row.spans)
    for (const inverse of directions)
      for (const mutation of ["damaged", "missing", "duplicate"] as const)
        it(`span ${span.ordinal} refuses ${mutation}, inverse=${inverse}, after a real positive`, () => {
          const { current, prior } = positive(),
            source = inverse ? current : prior,
            from = inverse ? span.after : span.before;
          expect(source.split(from)).toHaveLength(2);
          expect(source.indexOf(from)).toBe(inverse ? span.afterOffset : span.beforeOffset);
          const replacement = mutation === "damaged" ? damage(from) : mutation === "missing" ? "" : from + from;
          const changed = source.replace(from, () => replacement);
          expect(changed).not.toBe(source);
          expect(() => applyTypedArrayMainPreservation(typedArrayMainPath, changed, inverse)).toThrow(
            "typedarray-main span missing or duplicated: " + span.ordinal,
          );
        });
  for (const inverse of directions) {
    it(`refuses a shifted UTF16 offset, inverse=${inverse}, after a real positive`, () => {
      const { current, prior } = positive(),
        source = inverse ? current : prior;
      expect(() => applyTypedArrayMainPreservation(typedArrayMainPath, "😀" + source, inverse)).toThrow(
        "typedarray-main span order or offset mismatch: 0",
      );
    });
    it(`refuses reordered spans, inverse=${inverse}, after a real positive`, () => {
      const { current, prior } = positive(),
        source = inverse ? current : prior,
        first = row.spans[0]![inverse ? "after" : "before"],
        last = row.spans[1]![inverse ? "after" : "before"],
        marker = "__typedarray_main_span_swap__";
      expect(source).not.toContain(marker);
      const changed = source
        .replace(first, marker)
        .replace(last, () => first)
        .replace(marker, () => last);
      expect(() => applyTypedArrayMainPreservation(typedArrayMainPath, changed, inverse)).toThrow(
        "typedarray-main span order or offset mismatch: 0",
      );
    });
    it(`refuses unrecorded outside edits, inverse=${inverse}, after a real positive`, () => {
      const { current, prior } = positive(),
        source = inverse ? current : prior;
      expect(() => applyTypedArrayMainPreservation(typedArrayMainPath, source + "\n// unreviewed\n", inverse)).toThrow(
        "typedarray-main retained source mismatch",
      );
    });
  }

  it("refuses already-historical substitution and both wrong directions", () => {
    const { current, prior } = positive();
    expect(() => applyTypedArrayMainPreservation(typedArrayMainPath, prior, true)).toThrow(
      "typedarray-main span missing or duplicated",
    );
    expect(() => applyTypedArrayMainPreservation(typedArrayMainPath, current, false)).toThrow(
      "typedarray-main span missing or duplicated",
    );
    expect(() => beforeTypedArrayMainPreservation(typedArrayMainPath, prior)).toThrow(
      "typedarray-main span missing or duplicated",
    );
  });

  it("refuses malformed input, nonboolean direction and unowned paths", () => {
    const { current } = positive();
    expect(() => applyTypedArrayMainPreservation(typedArrayMainPath, null as unknown as string, true)).toThrow(
      "typedarray-main source must be text",
    );
    expect(() => applyTypedArrayMainPreservation(typedArrayMainPath, current, 1 as unknown as boolean)).toThrow(
      "typedarray-main direction must be boolean",
    );
    expect(() => applyTypedArrayMainPreservation("unowned.ts", current, true)).toThrow(
      "unrecorded typedarray-main source",
    );
  });

  it("refuses receipt population, provenance, hash, offset and text changes", () => {
    const { current } = positive();
    const mutations: ((copy: typeof receipt) => void)[] = [
      (copy) => {
        copy.schemaVersion++;
      },
      (copy) => {
        copy.scope = "unrestricted";
      },
      (copy) => {
        copy.priorCommit = copy.currentCommit;
      },
      (copy) => {
        copy.currentCommit = copy.sourceCommit;
      },
      (copy) => {
        copy.sourceCommit = "0".repeat(40);
      },
      (copy) => {
        copy.records.push(copy.records[0]!);
      },
      (copy) => {
        copy.records[0]!.path = "unowned.ts";
      },
      (copy) => {
        copy.records[0]!.before.sha256 = "0".repeat(64);
      },
      (copy) => {
        copy.records[0]!.after.gitBlob = "0".repeat(40);
      },
      (copy) => {
        copy.records[0]!.before.bytes++;
      },
      (copy) => {
        copy.records[0]!.after.utf16Units++;
      },
      (copy) => {
        copy.records[0]!.spans.reverse();
      },
      (copy) => {
        copy.records[0]!.spans.pop();
      },
      (copy) => {
        copy.records[0]!.spans[0]!.afterOffset++;
      },
      (copy) => {
        copy.records[0]!.spans[0]!.before = damage(copy.records[0]!.spans[0]!.before);
      },
      (copy) => {
        copy.records[0]!.spans[1]!.afterSha256 = "0".repeat(64);
      },
      (copy) => {
        copy.dependencies.pop();
      },
      (copy) => {
        copy.dependencies[0]!.path = "unowned.ts";
      },
      (copy) => {
        copy.dependencies[0]!.sha256 = "0".repeat(64);
      },
    ];
    for (const mutation of mutations) {
      const copy = JSON.parse(receiptText) as typeof receipt;
      mutation(copy);
      const changed = JSON.stringify(copy, null, 2) + "\n";
      expect(changed).not.toBe(receiptText);
      expect(() => authenticateTypedArrayMainPreservation(changed)).toThrow("typedarray-main receipt mismatch");
      expect(() => applyTypedArrayMainPreservation(typedArrayMainPath, current, true, changed)).toThrow(
        "typedarray-main receipt mismatch",
      );
    }
    for (const changed of ["not JSON", receiptText + "\n"])
      expect(() => authenticateTypedArrayMainPreservation(changed)).toThrow("typedarray-main receipt mismatch");
  });

  it("authenticates the real dependency without asking a reader for historical source", () => {
    positive();
    const seen: string[] = [];
    authenticateTypedArrayMainPreservation(receiptText, (path) => {
      seen.push(path);
      return readTypedArrayMainActualSource(path);
    });
    expect(seen).toEqual([typedArrayMainDependency]);
    const source = readTypedArrayMainActualSource(typedArrayMainDependency),
      pin = receipt.dependencies[0]!;
    expect(typedArrayMainHash(source)).toBe(pin.sha256);
    expect(typedArrayMainBlob(source)).toBe(pin.gitBlob);
    expect(Buffer.byteLength(source)).toBe(pin.bytes);
    expect(source.length).toBe(pin.utf16Units);
  });
  it("refuses changed dependency bytes supplied by a caller reader", () => {
    const { current } = positive();
    const reader = (path: string) => readTypedArrayMainActualSource(path) + "\n// changed import\n";
    const message = "typedarray-main dependency " + typedArrayMainDependency + " source mismatch";
    expect(() => authenticateTypedArrayMainPreservation(receiptText, reader)).toThrow(message);
    expect(() => applyTypedArrayMainPreservation(typedArrayMainPath, current, true, receiptText, reader)).toThrow(
      message,
    );
  });
  it("refuses a missing actual dependency", () => {
    const { current } = positive();
    const reader = () => {
      throw Error("missing actual file");
    };
    const message = "typedarray-main dependency missing: " + typedArrayMainDependency;
    expect(() => authenticateTypedArrayMainPreservation(receiptText, reader)).toThrow(message);
    expect(() => applyTypedArrayMainPreservation(typedArrayMainPath, current, true, receiptText, reader)).toThrow(
      message,
    );
  });

  it("transports only the initial read to the unchanged complete later-main receipt", () => {
    const { current, prior } = positive();
    const oldText = readLaterMainActualSource(laterMainFixture),
      old = authenticateLaterMainPreservation(oldText),
      oldRow = old.records.find((record) => record.path === typedArrayMainPath)!;
    expect(typedArrayMainHash(oldText)).toBe("1db8b018682040ff4d5a248b364b126c5ed6743543e40e26a72c4cfee1b5d1ea");
    expect(readLaterMainActualSource(typedArrayMainPath)).toBe(current);
    expect(readLaterMainPreservationInput(typedArrayMainPath)).toBe(prior);
    expect(typedArrayMainHash(prior)).toBe(oldRow.after.sha256);
    expect(typedArrayMainBlob(prior)).toBe(oldRow.after.gitBlob);
    const earlier = applyLaterMainPreservation(typedArrayMainPath, prior, true);
    expect(readBeforeLaterMainPreservation(typedArrayMainPath)).toBe(earlier);
    expect(applyLaterMainPreservation(typedArrayMainPath, earlier, false)).toBe(prior);
    expect(applyTypedArrayMainPreservation(typedArrayMainPath, prior, false)).toBe(current);
  });

  it("retains old mutation authority after the one initial transport", () => {
    positive();
    const source = readLaterMainPreservationInput(typedArrayMainPath),
      oldRow = authenticateLaterMainPreservation().records.find((record) => record.path === typedArrayMainPath)!;
    for (const span of oldRow.spans) {
      const changed = source.replace(span.after, () => damage(span.after));
      expect(changed).not.toBe(source);
      expect(() => applyLaterMainPreservation(typedArrayMainPath, changed, true)).toThrow(
        `later-main span missing or duplicated: ${typedArrayMainPath}:${span.ordinal}`,
      );
    }
    expect(() =>
      applyLaterMainPreservation(typedArrayMainPath, source + "\n// changed after transport\n", true),
    ).toThrow("later-main retained source mismatch: " + typedArrayMainPath);
  });

  it("keeps the other three targets, eight old dependencies and receipts as exact raw input", () => {
    positive();
    const old = authenticateLaterMainPreservation();
    for (const record of old.records.filter((record) => record.path !== typedArrayMainPath)) {
      expect(typedArrayMainHash(readLaterMainActualSource(record.path))).toBe(record.after.sha256);
      expect(typedArrayMainBlob(readLaterMainActualSource(record.path))).toBe(record.after.gitBlob);
    }
    expect(laterMainPaths.filter((path) => path !== typedArrayMainPath)).toHaveLength(3);
    expect(laterMainDependencies).toHaveLength(8);
    for (const path of [
      ...laterMainPaths.filter((path) => path !== typedArrayMainPath),
      ...laterMainDependencies,
      laterMainFixture,
      typedArrayMainFixture,
    ]) {
      const raw = readLaterMainActualSource(path);
      expect(readTypedArrayMainActualSource(path)).toBe(raw);
      expect(readLaterMainPreservationInput(path)).toBe(raw);
      expect(beforeTypedArrayMainPreservation(path, raw)).toBe(raw);
    }
  });

  it("reaches the original nonempty complete closure reconstruction", () => {
    positive();
    const old = JSON.parse(readLaterMainActualSource("tests/fixtures/issue-3518-closure-source-composition.json")) as {
      records: { path: string; beforeSha256: string; beforeBlob: string }[];
    };
    const original = old.records.find((record) => record.path === typedArrayMainPath)!;
    expect(original).toBeDefined();
    const source = readBeforeClosureComposition(typedArrayMainPath);
    expect(source.length).toBeGreaterThan(100_000);
    expect(typedArrayMainHash(source)).toBe(original.beforeSha256);
    expect(typedArrayMainBlob(source)).toBe(original.beforeBlob);
  });
});
