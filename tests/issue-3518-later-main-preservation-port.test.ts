// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  applyLaterMainPreservation,
  authenticateLaterMainPreservation,
  beforeLaterMainPreservation,
  laterMainBlob,
  laterMainCommits,
  laterMainCurrent,
  laterMainDependencies,
  laterMainFixture,
  laterMainHash,
  laterMainPaths,
  laterMainPrior,
  laterMainUpstream,
  readBeforeLaterMainPreservation,
  readLaterMainActualSource,
  readLaterMainPreservationInput,
} from "./helpers/later-main-preservation-port.js";
import {
  applyArrayMainRefresh,
  authenticateArrayMainRefresh,
  arrayMainFixture,
  arrayMainPaths,
  readArrayMainSource,
} from "./helpers/array-main-refresh-port.js";
import { readBeforeClosureComposition } from "./helpers/closure-source-composition.js";

const receiptText = readLaterMainActualSource(laterMainFixture);
const receipt = authenticateLaterMainPreservation(receiptText);
const damage = (text: string) => text.replace(/\S/, (character) => (character === "~" ? "!" : "~"));
const directions = [true, false] as const;

function positive(path: string) {
  const row = receipt.records.find((candidate) => candidate.path === path)!;
  const current = readLaterMainPreservationInput(path);
  expect(laterMainHash(current)).toBe(row.after.sha256);
  expect(laterMainBlob(current)).toBe(row.after.gitBlob);
  const prior = applyLaterMainPreservation(path, current, true);
  expect(prior).not.toBe(current);
  expect(laterMainHash(prior)).toBe(row.before.sha256);
  expect(laterMainBlob(prior)).toBe(row.before.gitBlob);
  expect(applyLaterMainPreservation(path, prior, false)).toBe(current);
  expect(beforeLaterMainPreservation(path, current)).toBe(prior);
  return { current, prior };
}

describe("fixed later-main historical comparison authority", () => {
  it("pins four actual files, 32 spans, ten published commits and eight imported implementations", () => {
    expect(receipt.priorCommit).toBe(laterMainPrior);
    expect(receipt.currentCommit).toBe(laterMainCurrent);
    expect(receipt.upstreamCommit).toBe(laterMainUpstream);
    expect(receipt.records.map((row) => row.path)).toEqual(laterMainPaths);
    expect(receipt.records.map((row) => row.spans.length)).toEqual([11, 14, 5, 2]);
    expect(receipt.records.flatMap((row) => row.spans)).toHaveLength(32);
    expect(receipt.sourceCommits.map((row) => row.commit)).toEqual(laterMainCommits);
    expect(receipt.sourceCommits).toHaveLength(10);
    expect(receipt.sourceCommits.map((row) => row.path)).toEqual([
      ...Array<string>(5).fill(laterMainPaths[0]),
      ...Array<string>(3).fill(laterMainPaths[1]),
      laterMainPaths[2],
      laterMainPaths[3],
    ]);
    expect(receipt.dependencies.map((row) => row.path)).toEqual(laterMainDependencies);
    expect(receipt.dependencies).toHaveLength(8);
  });
  for (const row of receipt.records) {
    it("reconstructs and reciprocally replays the complete actual " + row.path, () => {
      positive(row.path);
    });
    for (const span of row.spans)
      for (const inverse of directions)
        for (const mutation of ["damaged", "missing", "duplicate"] as const)
          it(`${row.path}:${span.ordinal} refuses ${mutation}, inverse=${inverse}, after a positive`, () => {
            const { current, prior } = positive(row.path);
            const source = inverse ? current : prior;
            const from = inverse ? span.after : span.before;
            expect(source.split(from)).toHaveLength(2);
            expect(source.indexOf(from)).toBe(inverse ? span.afterOffset : span.beforeOffset);
            const replacement = mutation === "damaged" ? damage(from) : mutation === "missing" ? "" : from + from;
            const changed = source.replace(from, () => replacement);
            expect(changed).not.toBe(source);
            expect(() => applyLaterMainPreservation(row.path, changed, inverse)).toThrow(
              `later-main span missing or duplicated: ${row.path}:${span.ordinal}`,
            );
          });
    for (const inverse of directions) {
      it(`${row.path} refuses shifted spans, inverse=${inverse}, after a positive`, () => {
        const { current, prior } = positive(row.path);
        const source = inverse ? current : prior;
        expect(() => applyLaterMainPreservation(row.path, "\n" + source, inverse)).toThrow(
          `later-main span order or offset mismatch: ${row.path}:0`,
        );
      });
      it(`${row.path} refuses edits outside recorded spans, inverse=${inverse}, after a positive`, () => {
        const { current, prior } = positive(row.path);
        const source = inverse ? current : prior;
        expect(() => applyLaterMainPreservation(row.path, source + "\n// unowned edit\n", inverse)).toThrow(
          "later-main retained source mismatch: " + row.path,
        );
      });
      it(`${row.path} refuses reordered spans, inverse=${inverse}, after a positive`, () => {
        const { current, prior } = positive(row.path);
        const source = inverse ? current : prior;
        const first = row.spans[0]![inverse ? "after" : "before"];
        const last = row.spans.at(-1)![inverse ? "after" : "before"];
        const marker = "__later_main_span_swap__";
        expect(source).not.toContain(marker);
        const changed = source
          .replace(first, marker)
          .replace(last, () => first)
          .replace(marker, () => last);
        expect(changed).not.toBe(source);
        expect(() => applyLaterMainPreservation(row.path, changed, inverse)).toThrow(
          `later-main span order or offset mismatch: ${row.path}:0`,
        );
      });
    }
    it("refuses historical substitution and the wrong direction for " + row.path, () => {
      const { current, prior } = positive(row.path);
      expect(() => applyLaterMainPreservation(row.path, prior, true)).toThrow("later-main span missing or duplicated");
      expect(() => applyLaterMainPreservation(row.path, current, false)).toThrow(
        "later-main span missing or duplicated",
      );
      expect(() => beforeLaterMainPreservation(row.path, prior)).toThrow("later-main span missing or duplicated");
    });
  }

  it("uses unique enlarged closure-export contexts rather than ambiguous argument-conversion fragments", () => {
    const path = laterMainPaths[2];
    const { current, prior } = positive(path);
    const repeated =
      "  const needsExplicitUndefinedRefNormalization = entries.some((entry) => hasNullableRefFormal(ctx, entry.funcTypeIdx));";
    expect(current.split(repeated)).toHaveLength(3);
    const row = receipt.records.find((candidate) => candidate.path === path)!;
    const affected = row.spans.filter((span) => span.after.includes(repeated));
    expect(affected).toHaveLength(2);
    for (const span of affected) {
      expect(current.split(span.after)).toHaveLength(2);
      expect(prior.split(span.before)).toHaveLength(2);
      expect(span.after.split("\n").length).toBeGreaterThan(20);
      const changed = current.replace(span.after, () => span.after + span.after);
      expect(() => applyLaterMainPreservation(path, changed, true)).toThrow(
        `later-main span missing or duplicated: ${path}:${span.ordinal}`,
      );
    }
  });

  it("rejects every edited receipt field before granting transformation authority", () => {
    positive(laterMainPaths[0]);
    const mutations: ((copy: typeof receipt) => void)[] = [
      (copy) => {
        copy.schemaVersion = 2;
      },
      (copy) => {
        copy.priorCommit = copy.currentCommit;
      },
      (copy) => {
        copy.upstreamCommit = copy.priorCommit;
      },
      (copy) => {
        copy.records.reverse();
      },
      (copy) => {
        copy.records.pop();
      },
      (copy) => {
        copy.sourceCommits.reverse();
      },
      (copy) => {
        copy.sourceCommits[0]!.path = "unowned";
      },
      (copy) => {
        copy.dependencies.reverse();
      },
      (copy) => {
        copy.records[0]!.before.sha256 = "0".repeat(64);
      },
      (copy) => {
        copy.records[0]!.after.gitBlob = "0".repeat(40);
      },
      (copy) => {
        copy.records[0]!.spans[0]!.ordinal = 1;
      },
      (copy) => {
        copy.records[0]!.spans[0]!.afterOffset++;
      },
      (copy) => {
        copy.records[0]!.spans[0]!.before = damage(copy.records[0]!.spans[0]!.before);
      },
      (copy) => {
        copy.records[0]!.spans[0]!.afterSha256 = "0".repeat(64);
      },
      (copy) => {
        copy.records[0]!.spans.reverse();
      },
    ];
    for (const mutation of mutations) {
      const copy = JSON.parse(receiptText) as typeof receipt;
      mutation(copy);
      const changed = JSON.stringify(copy, null, 2) + "\n";
      expect(changed).not.toBe(receiptText);
      expect(() => authenticateLaterMainPreservation(changed)).toThrow("later-main receipt mismatch");
      expect(() =>
        applyLaterMainPreservation(laterMainPaths[0], readLaterMainPreservationInput(laterMainPaths[0]), true, changed),
      ).toThrow("later-main receipt mismatch");
    }
    for (const changed of ["not JSON", receiptText + "\n"])
      expect(() => authenticateLaterMainPreservation(changed)).toThrow("later-main receipt mismatch");
  });

  it("authenticates the eight actual imports before any historical reconstruction", () => {
    const seen: string[] = [];
    authenticateLaterMainPreservation(receiptText, (path) => {
      seen.push(path);
      return readLaterMainActualSource(path);
    });
    expect(seen).toEqual(laterMainDependencies);
    for (const row of receipt.dependencies) {
      const source = readLaterMainActualSource(row.path);
      expect(laterMainHash(source)).toBe(row.sha256);
      expect(laterMainBlob(source)).toBe(row.gitBlob);
    }
  });
  for (const dependency of receipt.dependencies) {
    it("refuses a changed actual dependency: " + dependency.path, () => {
      positive(laterMainPaths[0]);
      const reader = (path: string) =>
        readLaterMainActualSource(path) + (path === dependency.path ? "\n// changed import\n" : "");
      expect(() => authenticateLaterMainPreservation(receiptText, reader)).toThrow(
        "later-main dependency mismatch: " + dependency.path,
      );
      expect(() =>
        applyLaterMainPreservation(
          laterMainPaths[0],
          readLaterMainPreservationInput(laterMainPaths[0]),
          true,
          receiptText,
          reader,
        ),
      ).toThrow("later-main dependency mismatch: " + dependency.path);
    });
    it("refuses a missing actual dependency: " + dependency.path, () => {
      positive(laterMainPaths[0]);
      const reader = (path: string) => {
        if (path === dependency.path) throw Error("missing actual source");
        return readLaterMainActualSource(path);
      };
      expect(() => authenticateLaterMainPreservation(receiptText, reader)).toThrow(
        "later-main dependency missing: " + dependency.path,
      );
    });
  }

  it("peels once before both original array source and dependency authentication", () => {
    const old = authenticateArrayMainRefresh();
    expect(old.records.map((row) => row.path)).toEqual(arrayMainPaths);
    for (const row of old.records) {
      const { prior, current } = positive(row.path);
      expect(readBeforeLaterMainPreservation(row.path)).toBe(prior);
      expect(readArrayMainSource(row.path)).toBe(prior);
      expect(laterMainHash(prior)).toBe(row.after.sha256);
      expect(laterMainBlob(prior)).toBe(row.after.gitBlob);
      const earlier = applyArrayMainRefresh(row.path, prior, true);
      expect(laterMainHash(earlier)).toBe(row.before.sha256);
      expect(laterMainBlob(earlier)).toBe(row.before.gitBlob);
      expect(applyArrayMainRefresh(row.path, earlier, false)).toBe(prior);
      expect(laterMainHash(readLaterMainPreservationInput(row.path))).toBe(laterMainHash(current));
    }
    const dependency = old.dependencies[0]!;
    expect(laterMainHash(readArrayMainSource(dependency.path))).toBe(dependency.sha256);
    expect(laterMainBlob(readArrayMainSource(dependency.path))).toBe(dependency.gitBlob);
    expect(laterMainHash(readLaterMainActualSource(dependency.path))).not.toBe(dependency.sha256);
    expect(() => authenticateArrayMainRefresh(undefined, readLaterMainActualSource)).toThrow(
      "array-main dependency mismatch: " + dependency.path,
    );
  });

  it("preserves the old mutation authority after normalization", () => {
    const old = authenticateArrayMainRefresh();
    for (const row of old.records) {
      const source = readArrayMainSource(row.path);
      const earlier = applyArrayMainRefresh(row.path, source, true);
      expect(applyArrayMainRefresh(row.path, earlier, false)).toBe(source);
      for (const span of row.spans) {
        const changed = source.replace(span.after, () => damage(span.after));
        expect(changed).not.toBe(source);
        expect(() => applyArrayMainRefresh(row.path, changed, true)).toThrow(
          `array-main span missing or duplicated: ${row.path}:${span.ordinal}`,
        );
      }
      expect(() => applyArrayMainRefresh(row.path, source + "\n// changed after normalization\n", true)).toThrow(
        "array-main retained source mismatch: " + row.path,
      );
    }
    const path = old.dependencies[0]!.path;
    expect(() =>
      authenticateArrayMainRefresh(
        undefined,
        (candidate) => readArrayMainSource(candidate) + (candidate === path ? "\n" : ""),
      ),
    ).toThrow("array-main dependency mismatch: " + path);
  });

  it("keeps every original receipt authority and an unrelated source byte-identical", () => {
    for (const [path, digest] of [
      [arrayMainFixture, "2d6edda6a315a29cb754ecc9c0a352ee4a25116593e1d171018a45592b997763"],
      [
        "tests/fixtures/issue-3518-delivery-main-refresh-port.json",
        "e5d0c8de3cccd647b1f2c77aeb6a208241dcd6248781e580ce050ff8f5b39172",
      ],
      [
        "tests/fixtures/issue-3518-native-closure-donors.json",
        "be6904328b9bb25981ca9ae109c3526d86931832eeb433bce66af41f99b96575",
      ],
      [
        "tests/fixtures/issue-3518-closure-source-composition.json",
        "f37b47b66eb1dd2ec2591a9ad9af0efd0c7bd70ded7bde58115e78b06950e23e",
      ],
      [
        "tests/fixtures/issue-3518-resume-main-composition.json",
        "caca5417a51a144f5948f3da2d92af1ee5d8f6fff175d973f14b712e1747658e",
      ],
      [
        "tests/fixtures/issue-3518-own-property-extraction.json",
        "b10bc19653336ab5117e7671a39e3419df27e8e38582cd3dfc2bd0859d44d145",
      ],
      [
        "tests/fixtures/issue-3518-object-runtime-apply-extraction.json",
        "bf239cec5740142325107965d3a5e026ca3025ea427bfc64103c73e97ff2c647",
      ],
    ]) {
      const actual = readLaterMainActualSource(path!);
      expect(laterMainHash(actual)).toBe(digest);
      expect(readArrayMainSource(path!)).toBe(actual);
      expect(beforeLaterMainPreservation(path!, actual)).toBe(actual);
    }
    const path = "src/codegen/builtin-fn-meta.ts";
    expect(readBeforeLaterMainPreservation(path)).toBe(readLaterMainActualSource(path));
    expect(() => applyLaterMainPreservation(path, readLaterMainActualSource(path), true)).toThrow(
      "unrecorded later-main source",
    );
  });

  it("reaches the original complete closure reconstruction with a nonempty source", () => {
    const text = readLaterMainActualSource("tests/fixtures/issue-3518-closure-source-composition.json");
    const old = JSON.parse(text) as { records: { path: string; beforeSha256: string; beforeBlob: string }[] };
    const row = old.records.find((candidate) => candidate.path === laterMainPaths[0])!;
    expect(row).toBeDefined();
    const source = readBeforeClosureComposition(row.path);
    expect(source.length).toBeGreaterThan(100_000);
    expect(laterMainHash(source)).toBe(row.beforeSha256);
    expect(laterMainBlob(source)).toBe(row.beforeBlob);
  });
});
