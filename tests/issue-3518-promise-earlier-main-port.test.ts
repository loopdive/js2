// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  applyEarlierPromiseMain,
  applyEarlierPromiseStep,
  authenticateEarlierPromiseMain,
  beforeEarlierPromiseMain,
  earlierPromiseBase,
  earlierPromiseCommits,
  earlierPromiseFixture,
  earlierPromisePath,
  earlierPromisePrior,
} from "./helpers/promise-earlier-main-port.js";
import {
  beforePromiseExportMain,
  promiseExportBlob,
  promiseExportFixture,
  promiseExportHash,
  readPromiseExportSource,
} from "./helpers/promise-export-main-port.js";
import { B1_DONOR_HASHES, originalB1Source } from "./helpers/native-delay-combinator-b1-inverse.mjs";
import { verifyRetainedDeclarations } from "./helpers/native-delay-combinator-source-receipts.mjs";

const receipt = authenticateEarlierPromiseMain();
const read = (path: string): string =>
  beforeEarlierPromiseMain(path, beforePromiseExportMain(path, readPromiseExportSource(path)));

/** Every intermediate comes from inverse spans of the actual current file, never a historical file operand. */
function versions(): string[] {
  const current = readPromiseExportSource(earlierPromisePath);
  const sources = [beforePromiseExportMain(earlierPromisePath, current)];
  for (const record of [...receipt.records].reverse())
    sources.push(applyEarlierPromiseStep(record.commit, sources.at(-1)!, true));
  return sources.reverse();
}
function positive(index: number) {
  const sources = versions(),
    before = sources[index]!,
    after = sources[index + 1]!,
    record = receipt.records[index]!;
  expect(before).not.toBe(after);
  expect(applyEarlierPromiseStep(record.commit, after, true)).toBe(before);
  expect(applyEarlierPromiseStep(record.commit, before, false)).toBe(after);
  return { before, after };
}

describe("authenticated earlier Promise main composition", () => {
  it("pins the post-B1 source, three actual Git deltas, 28 spans and eight actual dependencies", () => {
    expect(receipt.baseCommit).toBe(earlierPromiseBase);
    expect(receipt.priorCommit).toBe(earlierPromisePrior);
    expect(receipt.sourcePath).toBe(earlierPromisePath);
    expect(receipt.records.map((record) => record.commit)).toEqual(earlierPromiseCommits);
    expect(receipt.records.map((record) => record.spans.length)).toEqual([4, 10, 14]);
    expect(receipt.dependencies).toHaveLength(8);
    expect(receipt.baseSource.sha256).toBe("4c14d929347b28e46cd5b6fe050d14f40baec1313881506db9619fbf59c7aa1a");
    expect(receipt.priorSource.sha256).toBe("f428fbde2ac63f35d2308a183cf9937a11af2e625fa63ac79b71fd9afa03ca92");
  });
  for (const [index, record] of receipt.records.entries()) {
    it("inverts and reciprocally replays complete actual sources for " + record.commit, () => {
      const { before, after } = positive(index);
      expect(promiseExportHash(before)).toBe(record.before.sha256);
      expect(promiseExportBlob(before)).toBe(record.before.gitBlob);
      expect(promiseExportHash(after)).toBe(record.after.sha256);
      expect(promiseExportBlob(after)).toBe(record.after.gitBlob);
    });
    for (const span of record.spans) {
      for (const inverse of [true, false] as const) {
        for (const mutation of ["damaged", "missing", "duplicate"] as const) {
          it(`${record.commit}:${span.ordinal} rejects ${mutation} after a positive, inverse=${inverse}`, () => {
            const { before, after } = positive(index),
              source = inverse ? after : before;
            const from = span[inverse ? "after" : "before"];
            expect(source.split(from)).toHaveLength(2);
            const replacement =
              mutation === "damaged"
                ? from.replace(/\S/, "~")
                : mutation === "missing"
                  ? "\n/* removed recorded span */\n"
                  : from + from;
            const changed = source.replace(from, () => replacement);
            expect(changed).not.toBe(source);
            expect(() => applyEarlierPromiseStep(record.commit, changed, inverse)).toThrow(
              `earlier-promise span missing or duplicated: ${record.commit}:${span.ordinal}`,
            );
          });
        }
      }
    }
    for (const inverse of [true, false] as const) {
      it(`${record.commit} rejects shifted exact spans after a positive, inverse=${inverse}`, () => {
        const { before, after } = positive(index);
        expect(() => applyEarlierPromiseStep(record.commit, "\n" + (inverse ? after : before), inverse)).toThrow(
          "earlier-promise span offset mismatch",
        );
      });
      it(`${record.commit} rejects unowned changes after a positive, inverse=${inverse}`, () => {
        const { before, after } = positive(index);
        expect(() =>
          applyEarlierPromiseStep(record.commit, (inverse ? after : before) + "\n// unowned change\n", inverse),
        ).toThrow("earlier-promise retained source mismatch");
      });
      it(`${record.commit} rejects reordered spans after a positive, inverse=${inverse}`, () => {
        const { before, after } = positive(index),
          source = inverse ? after : before;
        const first = record.spans[0]![inverse ? "after" : "before"],
          last = record.spans.at(-1)![inverse ? "after" : "before"];
        const marker = "__earlier_promise_span_swap__";
        expect(source).not.toContain(marker);
        const changed = source
          .replace(first, marker)
          .replace(last, () => first)
          .replace(marker, () => last);
        expect(changed).not.toBe(source);
        expect(() => applyEarlierPromiseStep(record.commit, changed, inverse)).toThrow(
          "earlier-promise span offset mismatch",
        );
      });
    }
    it("rejects historical substitution and the wrong replay direction for " + record.commit, () => {
      const { before, after } = positive(index);
      expect(() => applyEarlierPromiseStep(record.commit, before, true)).toThrow(
        "earlier-promise span missing or duplicated",
      );
      expect(() => applyEarlierPromiseStep(record.commit, after, false)).toThrow(
        "earlier-promise span missing or duplicated",
      );
    });
  }
  it("peels the entire earlier chain after the separate export view and replays it to that exact source", () => {
    const current = readPromiseExportSource(earlierPromisePath),
      prior = beforePromiseExportMain(earlierPromisePath, current);
    const historical = applyEarlierPromiseMain(earlierPromisePath, prior, true);
    expect(historical).toBe(versions()[0]);
    expect(read(earlierPromisePath)).toBe(historical);
    expect(applyEarlierPromiseMain(earlierPromisePath, historical, false)).toBe(prior);
    expect(promiseExportHash(historical)).toBe(receipt.baseSource.sha256);
    expect(promiseExportBlob(historical)).toBe(receipt.baseSource.gitBlob);
    expect(readPromiseExportSource(earlierPromisePath)).toBe(current);
    expect(promiseExportHash(readPromiseExportSource(promiseExportFixture))).toBe(
      "5a227bc727181737e46bb2d9b857b305805abf930ff8ba7cf563fb3f3faec63e",
    );
  });
  it("refuses historical endpoint substitution or a second peel after a positive chain", () => {
    const historical = read(earlierPromisePath);
    expect(() => beforeEarlierPromiseMain(earlierPromisePath, historical)).toThrow(
      "earlier-promise span missing or duplicated",
    );
    expect(() => applyEarlierPromiseMain(earlierPromisePath, versions().at(-1)!, false)).toThrow(
      "earlier-promise span missing or duplicated",
    );
  });
  it("refuses unrecorded sources and commits while leaving unrelated readers intact", () => {
    positive(0);
    const text = readPromiseExportSource(earlierPromiseFixture);
    expect(beforeEarlierPromiseMain(earlierPromiseFixture, text)).toBe(text);
    expect(() => applyEarlierPromiseMain("unowned", text, true)).toThrow("unrecorded earlier-promise source");
    expect(() => applyEarlierPromiseStep("unowned", text, true)).toThrow("unrecorded earlier-promise commit");
  });
  for (const mutation of ["whitespace", "commit", "span"] as const) {
    it("rejects edited earlier receipt authority after a positive: " + mutation, () => {
      authenticateEarlierPromiseMain();
      const text = readPromiseExportSource(earlierPromiseFixture);
      const changed =
        mutation === "whitespace"
          ? text + "\n"
          : mutation === "commit"
            ? text.replace(earlierPromiseBase, earlierPromisePrior)
            : text.replace('"ordinal": 0', '"ordinal": 1');
      expect(changed).not.toBe(text);
      expect(() => authenticateEarlierPromiseMain(changed)).toThrow("earlier-promise receipt mismatch");
    });
  }
  it("reaches the unchanged complete B1 donor and original 20+4 declaration ledger", () => {
    const historical = read(earlierPromisePath);
    expect(promiseExportHash(historical)).toBe(receipt.baseSource.sha256);
    expect(promiseExportHash(originalB1Source(earlierPromisePath, read))).toBe(B1_DONOR_HASHES[earlierPromisePath]);
    expect(verifyRetainedDeclarations(read)).toEqual({ combinator: 20, delay: 4 });
  });
  for (const dependency of receipt.dependencies) {
    it("rejects changed actual dependency bytes after a positive: " + dependency.path, () => {
      authenticateEarlierPromiseMain();
      const reader = (path: string) =>
        readPromiseExportSource(path) + (path === dependency.path ? "\n// changed dependency\n" : "");
      expect(() => authenticateEarlierPromiseMain(undefined, reader)).toThrow(
        "earlier-promise dependency mismatch: " + dependency.path,
      );
    });
    it("rejects missing actual dependency bytes after a positive: " + dependency.path, () => {
      authenticateEarlierPromiseMain();
      const reader = (path: string) => {
        if (path === dependency.path) throw Error("missing dependency");
        return readPromiseExportSource(path);
      };
      expect(() => authenticateEarlierPromiseMain(undefined, reader)).toThrow(
        "earlier-promise dependency missing: " + dependency.path,
      );
    });
  }
});
