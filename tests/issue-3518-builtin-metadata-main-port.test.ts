// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  applyBuiltinMetadataMain,
  authenticateBuiltinMetadataMain,
  beforeBuiltinMetadataMain,
  builtinMetadataBlob,
  builtinMetadataFixture,
  builtinMetadataHash,
  builtinMetadataMain,
  builtinMetadataParent,
  builtinMetadataPath,
  readBuiltinMetadataSource,
} from "./helpers/builtin-metadata-main-port.js";
import { readBeforeClosureComposition } from "./helpers/closure-source-composition.js";
import { readBeforeResumeMain } from "./helpers/resume-main-composition.js";

const receipt = authenticateBuiltinMetadataMain();
const donorFixture = "tests/fixtures/issue-3518-native-closure-donors.json";
const donorFixtureHash = "be6904328b9bb25981ca9ae109c3526d86931832eeb433bce66af41f99b96575";
function positive() {
  const current = readBuiltinMetadataSource(builtinMetadataPath),
    prior = applyBuiltinMetadataMain(builtinMetadataPath, current, true);
  expect(prior).not.toBe(current);
  expect(applyBuiltinMetadataMain(builtinMetadataPath, prior, false)).toBe(current);
  expect(beforeBuiltinMetadataMain(builtinMetadataPath, current)).toBe(prior);
  return { current, prior };
}

describe("authenticated Object.create metadata addition before original closure preservation", () => {
  it("pins the actual Git parent, incoming commit, complete source blobs and exact UTF-16 offsets", () => {
    expect(receipt.parentCommit).toBe(builtinMetadataParent);
    expect(receipt.mainCommit).toBe(builtinMetadataMain);
    expect(receipt.record.path).toBe(builtinMetadataPath);
    expect(receipt.record.before.gitBlob).toBe("ca008873b1a7e9d85c9107876720c93890350a84");
    expect(receipt.record.after.gitBlob).toBe("a898c6e57391ad2f6aee3bd694462eab721e4808");
    expect(receipt.record.span.beforeOffset).toBe(3462);
    expect(receipt.record.span.afterOffset).toBe(3462);
  });
  it("reconstructs and reciprocally replays both complete sources while the current metadata stays present", () => {
    const { current, prior } = positive();
    expect(builtinMetadataHash(current)).toBe(receipt.record.after.sha256);
    expect(builtinMetadataBlob(current)).toBe(receipt.record.after.gitBlob);
    expect(builtinMetadataHash(prior)).toBe(receipt.record.before.sha256);
    expect(builtinMetadataBlob(prior)).toBe(receipt.record.before.gitBlob);
    expect(current).toContain(receipt.record.span.after);
    expect(prior).toContain(receipt.record.span.before);
    expect(current).toContain('"Object.create": { name: "create", length: 2 }');
    expect(prior).not.toContain('"Object.create"');
    expect(readBuiltinMetadataSource(builtinMetadataPath)).toBe(current);
  });
  it("joins only the initial metadata reader and leaves unrelated reader inputs unchanged", () => {
    const { prior } = positive();
    expect(readBeforeClosureComposition(builtinMetadataPath)).toBe(prior);
    for (const path of [
      "src/codegen/closures/closure-header-layout.ts",
      donorFixture,
      "tests/fixtures/issue-3518-closure-source-composition.json",
    ]) {
      const source = readBeforeResumeMain(path);
      expect(beforeBuiltinMetadataMain(path, source)).toBe(source);
      expect(readBeforeClosureComposition(path)).toBe(source);
    }
  });
  it("retains the original 100-case suite, both frozen fixtures and the older composition assertions", () => {
    for (const [path, digest] of [
      [
        "tests/issue-3518-native-closure-resources.test.ts",
        "27887b73aec30063a20b2ac3567a05b120cb22c84e7dd648f5d725ad63d8cbf9",
      ],
      [donorFixture, donorFixtureHash],
      [
        "tests/fixtures/issue-3518-closure-source-composition.json",
        "f37b47b66eb1dd2ec2591a9ad9af0efd0c7bd70ded7bde58115e78b06950e23e",
      ],
      [
        "tests/issue-3518-closure-source-composition.test.ts",
        "fe71e6900dca4e6fe805868272ed82aba0401bab4bbf074ad6bf01b5dd01433c",
      ],
    ] as const)
      expect(builtinMetadataHash(readBuiltinMetadataSource(path))).toBe(digest);
  });
  it("restores all six original extraction offsets and the exact original complete metadata donor", () => {
    const { prior } = positive();
    const text = readBuiltinMetadataSource(donorFixture);
    expect(builtinMetadataHash(text)).toBe(donorFixtureHash);
    const original = JSON.parse(text) as {
      base: string;
      sources: {
        path: string;
        text: string;
        sha256: string;
        edits: { newStart: number; newCount: number; replacement: string[]; old: string[] }[];
      }[];
    };
    expect(original.base).toBe("bfe31c8bd96d748e867562e3e9b78343b72d1877");
    const donor = original.sources.find((source) => source.path === builtinMetadataPath)!;
    expect(donor).toBeDefined();
    expect(donor.edits).toHaveLength(6);
    expect(donor.sha256).toBe("f6da70eacab0e9ba87469f827f309372e3b853ce92e522c7172a5ba47fcdd284");
    const lines = prior.split("\n");
    for (const edit of [...donor.edits].reverse()) {
      const start = edit.newCount === 0 ? edit.newStart : edit.newStart - 1;
      expect(lines.slice(start, start + edit.newCount)).toEqual(edit.replacement);
      lines.splice(start, edit.newCount, ...edit.old);
    }
    const reconstructed = lines.join("\n");
    expect(reconstructed).toBe(donor.text);
    expect(builtinMetadataHash(reconstructed)).toBe(donor.sha256);
    expect(builtinMetadataBlob(reconstructed)).toBe("b48a9f089adacf19abb99c57082cc41aa8d84554");
  });
  for (const inverse of [true, false] as const) {
    for (const mutation of ["damaged", "missing", "duplicate"] as const) {
      it(`rejects ${mutation} spans after a genuine positive, inverse=${inverse}`, () => {
        const { current, prior } = positive(),
          source = inverse ? current : prior,
          span = receipt.record.span[inverse ? "after" : "before"];
        expect(source.split(span)).toHaveLength(2);
        const replacement =
          mutation === "damaged"
            ? span.replace("Object.keys", "Object.changedKeys")
            : mutation === "missing"
              ? ""
              : span + span;
        const changed = source.replace(span, () => replacement);
        expect(changed).not.toBe(source);
        expect(() => applyBuiltinMetadataMain(builtinMetadataPath, changed, inverse)).toThrow(
          "builtin-metadata span missing or duplicated",
        );
      });
    }
    it(`rejects an exact span at a shifted offset after a genuine positive, inverse=${inverse}`, () => {
      const { current, prior } = positive();
      expect(() => applyBuiltinMetadataMain(builtinMetadataPath, "\n" + (inverse ? current : prior), inverse)).toThrow(
        "builtin-metadata span offset mismatch",
      );
    });
    it(`rejects retained-source changes outside the span after a genuine positive, inverse=${inverse}`, () => {
      const { current, prior } = positive(),
        source = inverse ? current : prior;
      expect(() =>
        applyBuiltinMetadataMain(builtinMetadataPath, source + "\n// unrelated metadata change\n", inverse),
      ).toThrow("builtin-metadata retained source mismatch");
    });
    it(`rejects the wrong replay direction after a genuine positive, inverse=${inverse}`, () => {
      const { current, prior } = positive();
      expect(() => applyBuiltinMetadataMain(builtinMetadataPath, inverse ? prior : current, inverse)).toThrow(
        "builtin-metadata span missing or duplicated",
      );
    });
  }
  it("refuses a second peel instead of substituting a historical source for current input", () => {
    const { prior } = positive();
    expect(() => beforeBuiltinMetadataMain(builtinMetadataPath, prior)).toThrow(
      "builtin-metadata span missing or duplicated",
    );
  });
  it("refuses an unrecorded transformation after a genuine positive", () => {
    const { current } = positive();
    expect(() => applyBuiltinMetadataMain("unowned", current, true)).toThrow("unrecorded builtin-metadata source");
  });
  for (const mutation of [
    "whitespace",
    "parent",
    "commit",
    "before-blob",
    "after-hash",
    "before-offset",
    "after-offset",
    "span",
    "path",
  ] as const) {
    it("rejects changed receipt authority through the fixed digest after a positive: " + mutation, () => {
      positive();
      const text = readBuiltinMetadataSource(builtinMetadataFixture);
      const changed =
        mutation === "whitespace"
          ? text + "\n"
          : mutation === "parent"
            ? text.replace(builtinMetadataParent, builtinMetadataMain)
            : mutation === "commit"
              ? text.replace(builtinMetadataMain, builtinMetadataParent)
              : mutation === "before-blob"
                ? text.replace(receipt.record.before.gitBlob, receipt.record.after.gitBlob)
                : mutation === "after-hash"
                  ? text.replace(receipt.record.after.sha256, receipt.record.before.sha256)
                  : mutation === "before-offset"
                    ? text.replace('"beforeOffset": 3462', '"beforeOffset": 3463')
                    : mutation === "after-offset"
                      ? text.replace('"afterOffset": 3462', '"afterOffset": 3463')
                      : mutation === "span"
                        ? text.replace("Object.create", "Object.changedCreate")
                        : text.replace(builtinMetadataPath, "src/codegen/unrecorded-metadata.ts");
      expect(changed).not.toBe(text);
      expect(() => authenticateBuiltinMetadataMain(changed)).toThrow("builtin-metadata receipt mismatch");
    });
  }
});
