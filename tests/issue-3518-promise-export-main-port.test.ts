// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  applyPromiseExportMain,
  authenticatePromiseExportMain,
  beforePromiseExportMain,
  promiseExportBase,
  promiseExportBlob,
  promiseExportFixture,
  promiseExportHash,
  promiseExportMain,
  promiseExportPath,
  promiseExportPrior,
  readHistoricalPromiseExportSource as readPromiseExportSource,
} from "./helpers/promise-export-main-port.js";
import { beforeEarlierPromiseMain } from "./helpers/promise-earlier-main-port.js";
import { B1_DONOR_HASHES, originalB1Source } from "./helpers/native-delay-combinator-b1-inverse.mjs";
import {
  fn,
  receipt as historicalReceipt,
  semanticReceipt,
  verifyRetainedDeclarations,
} from "./helpers/native-delay-combinator-source-receipts.mjs";

const receipt = authenticatePromiseExportMain();
const readPreExport = (path: string): string => beforePromiseExportMain(path, readPromiseExportSource(path));
const read = (path: string): string => beforeEarlierPromiseMain(path, readPreExport(path));
function positive() {
  const current = readPromiseExportSource(promiseExportPath),
    prior = applyPromiseExportMain(promiseExportPath, current, true);
  expect(prior).not.toBe(current);
  expect(applyPromiseExportMain(promiseExportPath, prior, false)).toBe(current);
  expect(readPreExport(promiseExportPath)).toBe(prior);
  return { current, prior };
}

describe("authenticated incoming Promise helper export", () => {
  it("pins the signed prior, incoming main, shared source and sole consumer dependency", () => {
    expect(receipt.priorCommit).toBe(promiseExportPrior);
    expect(receipt.mainCommit).toBe(promiseExportMain);
    expect(receipt.mergeBase).toBe(promiseExportBase);
    expect(receipt.record.path).toBe(promiseExportPath);
    expect(receipt.record.before).toEqual(receipt.record.upstream.before);
    expect(receipt.record.after).toEqual(receipt.record.upstream.after);
    expect(receipt.record.span.beforeOffset).toBe(39658);
    expect(receipt.dependencies.map((row) => row.path)).toEqual(["src/codegen/promise-class-receiver-drive.ts"]);
  });
  it("reconstructs and reciprocally replays the entire current source while the raw export stays present", () => {
    const { current, prior } = positive();
    expect(promiseExportHash(current)).toBe(receipt.record.after.sha256);
    expect(promiseExportBlob(current)).toBe(receipt.record.after.gitBlob);
    expect(promiseExportHash(prior)).toBe(receipt.record.before.sha256);
    expect(promiseExportBlob(prior)).toBe(receipt.record.before.gitBlob);
    expect(readPromiseExportSource(promiseExportPath)).toBe(current);
    expect(current).toContain(receipt.record.span.after);
    expect(prior).not.toContain(receipt.record.span.after);
  });
  for (const inverse of [true, false] as const) {
    for (const mutation of ["damaged", "missing", "duplicate"] as const) {
      it(`rejects ${mutation} spans after a positive, inverse=${inverse}`, () => {
        const { current, prior } = positive(),
          source = inverse ? current : prior,
          span = receipt.record.span[inverse ? "after" : "before"];
        expect(source.split(span)).toHaveLength(2);
        const replacement =
          mutation === "damaged"
            ? span.replace("ensureSettledAnyCombinators", "changedSettledAnyCombinators")
            : mutation === "missing"
              ? ""
              : span + span;
        const changed = source.replace(span, () => replacement);
        expect(changed).not.toBe(source);
        expect(() => applyPromiseExportMain(promiseExportPath, changed, inverse)).toThrow(
          "promise-export span missing or duplicated",
        );
      });
    }
    it(`rejects an exact span at a shifted offset after a positive, inverse=${inverse}`, () => {
      const { current, prior } = positive();
      expect(() => applyPromiseExportMain(promiseExportPath, "\n" + (inverse ? current : prior), inverse)).toThrow(
        "promise-export span offset mismatch",
      );
    });
    it(`rejects changes outside the export span after a positive, inverse=${inverse}`, () => {
      const { current, prior } = positive(),
        source = inverse ? current : prior;
      expect(() => applyPromiseExportMain(promiseExportPath, source + "\n// unrelated change\n", inverse)).toThrow(
        "promise-export retained source mismatch",
      );
    });
    it(`rejects historical substitution or the wrong replay direction after a positive, inverse=${inverse}`, () => {
      const { current, prior } = positive();
      expect(() => applyPromiseExportMain(promiseExportPath, inverse ? prior : current, inverse)).toThrow(
        "promise-export span missing or duplicated",
      );
    });
  }
  it("refuses a second peel rather than accepting a historical source as current", () => {
    const { prior } = positive();
    expect(() => beforePromiseExportMain(promiseExportPath, prior)).toThrow(
      "promise-export span missing or duplicated",
    );
  });
  it("refuses unrecorded transformations and leaves unrelated reader input intact", () => {
    positive();
    const text = readPromiseExportSource(promiseExportFixture);
    expect(beforePromiseExportMain(promiseExportFixture, text)).toBe(text);
    expect(() => applyPromiseExportMain("unowned", text, true)).toThrow("unrecorded promise-export source");
  });
  it("retains the complete original B1 and historical source authorities", () => {
    for (const [path, digest] of [
      [
        "tests/helpers/native-delay-combinator-b1-inverse.mjs",
        "2db08ac6dfb265df815f57a31f275dac1fa9887a740eb5b5ddd351afee8d575c",
      ],
      [
        "tests/helpers/native-delay-combinator-source-receipts.mjs",
        "5516c9edfc627cc331bfdcbcea0d651d7d07fcd9ff623c571292ae1b6c26f6fe",
      ],
      [
        "scripts/lib/fixtures/frame-delay-original-instruments/native-delay-combinator-b1-inverse.mjs.txt",
        "2db08ac6dfb265df815f57a31f275dac1fa9887a740eb5b5ddd351afee8d575c",
      ],
      [
        "scripts/lib/fixtures/frame-delay-original-instruments/native-delay-combinator-source-receipts.mjs.txt",
        "dcb2101fbfbb4e7a03c38ac0ec097da725d9c9bd254c24541ac07b997a45143f",
      ],
    ])
      expect(promiseExportHash(readPromiseExportSource(path!))).toBe(digest);
  });
  it("joins the unchanged whole-file donor and complete 20+4 declaration validators after a positive", () => {
    positive();
    expect(promiseExportHash(originalB1Source(promiseExportPath, read))).toBe(B1_DONOR_HASHES[promiseExportPath]);
    expect(verifyRetainedDeclarations(read)).toEqual({ combinator: 20, delay: 4 });
  });
  it("lets the historical semantic validator inspect a deliberate old-hash collision after normalization", () => {
    const { prior } = positive();
    const historical = beforeEarlierPromiseMain(promiseExportPath, prior);
    expect(verifyRetainedDeclarations(read)).toEqual({ combinator: 20, delay: 4 });
    const node = fn(historical, "emitStandalonePromiseCombinator"),
      declaration = node.getText();
    expect(declaration).toContain("i++");
    const changed =
      historical.slice(0, node.getStart()) + declaration.replace("i++", "i--") + historical.slice(node.end);
    expect(changed).not.toBe(historical);
    expect(historicalReceipt(changed)).toBe(historicalReceipt(historical));
    expect(semanticReceipt(changed)).not.toBe(semanticReceipt(historical));
    expect(() =>
      verifyRetainedDeclarations((path: string) => (path === promiseExportPath ? changed : read(path))),
    ).toThrow("original retained declaration ledger");
  });
  for (const mutation of ["whitespace", "commit", "offset"] as const) {
    it("rejects changed receipt authority after a positive: " + mutation, () => {
      authenticatePromiseExportMain();
      const text = readPromiseExportSource(promiseExportFixture),
        changed =
          mutation === "whitespace"
            ? text + "\n"
            : mutation === "commit"
              ? text.replace(promiseExportPrior, promiseExportMain)
              : text.replace('"beforeOffset": 39658', '"beforeOffset": 39659');
      expect(changed).not.toBe(text);
      expect(() => authenticatePromiseExportMain(changed)).toThrow("promise-export receipt mismatch");
    });
  }
  it("rejects a changed actual class-drive consumer after a positive", () => {
    authenticatePromiseExportMain();
    const dependency = receipt.dependencies[0]!;
    const reader = (path: string) => readPromiseExportSource(path) + (path === dependency.path ? "\n// change\n" : "");
    expect(() => authenticatePromiseExportMain(undefined, reader)).toThrow("promise-export dependency mismatch");
  });
  it("rejects a missing actual class-drive consumer after a positive", () => {
    authenticatePromiseExportMain();
    const dependency = receipt.dependencies[0]!;
    const reader = (path: string) => {
      if (path === dependency.path) throw Error("missing consumer");
      return readPromiseExportSource(path);
    };
    expect(() => authenticatePromiseExportMain(undefined, reader)).toThrow("promise-export dependency missing");
  });
});
