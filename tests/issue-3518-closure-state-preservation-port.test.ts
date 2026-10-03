// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyClosureStatePreservation,
  authenticateClosureStatePreservation,
  beforeClosureStatePreservation,
  closureStateBlob,
  closureStateFixture,
  closureStatePath,
  closureStateSha,
} from "./helpers/closure-state-preservation-port.js";
import { readBeforeResumeMain, readMergedSource } from "./helpers/resume-main-composition.js";
import { applyClosureComposition, readBeforeClosureComposition } from "./helpers/closure-source-composition.js";
import { buildBuiltinClosureValueInstrs } from "../src/runtime/wasmgc/values/closure-layouts.js";

const raw = (path: string): string => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const receipt = authenticateClosureStatePreservation();
const row = receipt.records[0]!;
const span = row.spans[0]!;
const addition =
  "  /** Stable handle issued by the native realm state owner; called after all captures. */\n" +
  "  readonly realmStateInitializer?: FuncHandle;\n";
function positive() {
  const current = raw(closureStatePath);
  const prior = applyClosureStatePreservation(closureStatePath, current, true);
  expect(prior).not.toBe(current);
  expect(closureStateSha(current)).toBe(row.after.sha256);
  expect(closureStateBlob(current)).toBe(row.after.gitBlob);
  expect(closureStateSha(prior)).toBe(row.before.sha256);
  expect(closureStateBlob(prior)).toBe(row.before.gitBlob);
  expect(applyClosureStatePreservation(closureStatePath, prior, false)).toBe(current);
  expect(beforeClosureStatePreservation(closureStatePath, current)).toBe(prior);
  return { current, prior };
}

describe("exact state-field inverse before the original closure preservation readers", () => {
  it("pins one contextual addition and honest uncommitted after provenance", () => {
    positive();
    expect(receipt.baseCommit).toBe("8a730516ced8ace5da216cbb8f5b5c54c064d421");
    expect(receipt.afterProvenance.kind).toBe("uncommitted-working-tree");
    expect(Object.hasOwn(receipt.afterProvenance, "commit")).toBe(false);
    expect(receipt.records).toHaveLength(1);
    expect(row.path).toBe(closureStatePath);
    expect(row.before).toEqual({
      sha256: "f79e77c4bb0a0286c0c3462d80613f8a1c3c3ee861cab689f6fb0f1ad3dc9d7b",
      gitBlob: "d62858d3ba7c3668a47287325410dbdbc33ec67e",
      bytes: 9156,
      utf16Units: 9128,
    });
    expect(row.after).toEqual({
      sha256: "7d9229c8c4a9bdae3d3105138b2c3c2685d0659e0b8f71df1b7fc2c0bc309d67",
      gitBlob: "931d2dcbf57b4c9c19160b30f82a92ab4121712e",
      bytes: 9293,
      utf16Units: 9265,
    });
    expect(row.spans).toHaveLength(1);
    expect(span.beforeOffset).toBe(3405);
    expect(span.afterOffset).toBe(3405);
    expect(span.after).toBe(span.before.replace("}\n", addition + "}\n"));
    expect(Buffer.byteLength(addition)).toBe(137);
  });

  it("replaces only the actual span and reciprocally recovers the complete live source", () => {
    const { current, prior } = positive();
    expect(current.indexOf(span.after)).toBe(3405);
    expect(Buffer.byteLength(current.slice(0, 3405))).toBe(3413);
    expect(prior).toBe(current.slice(0, 3405) + span.before + current.slice(3405 + span.after.length));
    expect(current).toContain(addition);
    expect(prior).not.toContain("realmStateInitializer");
    const suffix = "export type ClosureAllocationMode =";
    expect(current.slice(current.indexOf(suffix))).toBe(prior.slice(prior.indexOf(suffix)));
    expect(raw(closureStatePath)).toBe(current);
  });

  it("restores both initial reader levels without changing the original closure receipt", () => {
    const { current, prior } = positive();
    expect(readMergedSource(closureStatePath)).toBe(prior);
    expect(readBeforeResumeMain(closureStatePath)).toBe(prior);
    const original = applyClosureComposition(closureStatePath, prior, true);
    expect(readBeforeClosureComposition(closureStatePath)).toBe(original);
    expect(closureStateSha(original)).toBe("0f9e1fe72f60e7f24577bf12ef194629e0b77815339f335c37df5784950a5543");
    expect(closureStateBlob(original)).toBe("b4fd5fa3271a5740cd5a5defbbc601af56df7f71");
    expect(applyClosureComposition(closureStatePath, original, false)).toBe(prior);
    expect(applyClosureStatePreservation(closureStatePath, prior, false)).toBe(current);
    for (const [path, digest] of [
      [
        "tests/fixtures/issue-3518-closure-source-composition.json",
        "f37b47b66eb1dd2ec2591a9ad9af0efd0c7bd70ded7bde58115e78b06950e23e",
      ],
      [
        "tests/fixtures/issue-3518-native-closure-donors.json",
        "be6904328b9bb25981ca9ae109c3526d86931832eeb433bce66af41f99b96575",
      ],
      [
        "tests/issue-3518-native-closure-resources.test.ts",
        "27887b73aec30063a20b2ac3567a05b120cb22c84e7dd648f5d725ad63d8cbf9",
      ],
      [
        "tests/issue-3518-closure-source-composition.test.ts",
        "fe71e6900dca4e6fe805868272ed82aba0401bab4bbf074ad6bf01b5dd01433c",
      ],
    ])
      expect(closureStateSha(raw(path!))).toBe(digest);
  });

  it("keeps raw runtime imports live and the new reader outside all production modules", () => {
    const { current } = positive();
    expect(raw(closureStatePath)).toBe(current);
    expect(buildBuiltinClosureValueInstrs(37, 19, 4, true)).toEqual([
      { op: "ref.func", funcIdx: 19 },
      { op: "i32.const", value: 4 },
      { op: "ref.null.extern" },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 37 },
      { op: "struct.new", typeIdx: 37 },
    ]);
    let moduleCount = 0;
    function check(directory: URL): void {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
        if (entry.isDirectory()) check(file);
        else if (entry.name.endsWith(".ts")) {
          moduleCount++;
          expect(readFileSync(file, "utf8")).not.toContain("closure-state-preservation-port");
        }
      }
    }
    check(new URL("../src/", import.meta.url));
    expect(moduleCount).toBeGreaterThan(1000);
  });

  it("passes unrelated paths through and rejects direct unrecorded transformations", () => {
    const { current } = positive();
    for (const path of ["unrecorded", "src/codegen/closures/closure-header-layout.ts", closureStateFixture]) {
      expect(beforeClosureStatePreservation(path, current)).toBe(current);
      expect(() => applyClosureStatePreservation(path, current, true)).toThrow("unrecorded closure-state source");
    }
  });

  const changes: readonly [string, (source: string) => string, string][] = [
    ["delete field", (s) => s.replace("  readonly realmStateInitializer?: FuncHandle;\n", ""), "span missing"],
    ["delete documentation", (s) => s.replace(addition.split("\n")[0]! + "\n", ""), "span missing"],
    ["duplicate field", (s) => s.replace(addition, addition + addition), "span missing"],
    ["duplicate whole context", (s) => s.replace(span.after, span.after + span.after), "span missing or duplicated"],
    ["remove whole context", (s) => s.replace(span.after, ""), "span missing"],
    ["relocate field", (s) => s.replace(addition, "") + addition, "span missing"],
    ["relocate context", (s) => s.replace(span.after, "") + span.after, "span offset"],
    ["rename field", (s) => s.replace("realmStateInitializer", "substitutedStateInitializer"), "span missing"],
    [
      "change field type",
      (s) => s.replace("realmStateInitializer?: FuncHandle", "realmStateInitializer?: number"),
      "span missing",
    ],
    ["remove readonly", (s) => s.replace("readonly realmStateInitializer", "realmStateInitializer"), "span missing"],
    ["remove optional", (s) => s.replace("realmStateInitializer?:", "realmStateInitializer:"), "span missing"],
    ["alter documentation", (s) => s.replace("called after all captures", "called before captures"), "span missing"],
    [
      "alter retained DOM field",
      (s) => s.replace("domCallbackAuthorityGlobalIdx?:", "domCallbackAuthorityGlobalIdx:"),
      "span missing",
    ],
    [
      "extra state declaration",
      (s) => s + "\ninterface ExtraState { readonly realmStateInitializer?: number; }\n",
      "retained source",
    ],
    [
      "factory body",
      (s) =>
        s.replace(
          'return { kind: "struct" as const, name, fields, parent };',
          'return { kind: "struct" as const, name, fields, parent: undefined };',
        ),
      "retained source",
    ],
    [
      "header constant",
      (s) => s.replace("CLOSURE_FUNC_FIELD_IDX = 0", "CLOSURE_FUNC_FIELD_IDX = 9"),
      "retained source",
    ],
    ["extra declaration", (s) => s + "\nexport const unrelated = 1;\n", "retained source"],
    ["retained trivia", (s) => s + "\n// unreviewed change\n", "retained source"],
  ];
  it("retains a nonempty, fixed mutation population", () => {
    expect(changes).toHaveLength(18);
  });
  for (const [name, mutate, message] of changes)
    it("rejects " + name + " after a genuine current positive", () => {
      const { current } = positive();
      const changed = mutate(current);
      expect(changed).not.toBe(current);
      expect(() => applyClosureStatePreservation(closureStatePath, changed, true)).toThrow("closure-state " + message);
    });

  for (const inverse of [true, false]) {
    for (const mutation of ["missing", "duplicate", "offset", "outside"] as const)
      it(`refuses ${mutation} in either replay direction after a positive, inverse=${inverse}`, () => {
        const { current, prior } = positive();
        const source = inverse ? current : prior;
        const from = span[inverse ? "after" : "before"];
        const changed =
          mutation === "missing"
            ? source.replace(from, "")
            : mutation === "duplicate"
              ? source.replace(from, from + from)
              : mutation === "offset"
                ? "\n" + source
                : source + "\n";
        expect(changed).not.toBe(source);
        expect(() => applyClosureStatePreservation(closureStatePath, changed, inverse)).toThrow(
          mutation === "outside"
            ? "retained source"
            : mutation === "offset"
              ? "span offset"
              : "span missing or duplicated",
        );
      });
    it(`refuses the already opposite source after a positive, inverse=${inverse}`, () => {
      const { current, prior } = positive();
      expect(() => applyClosureStatePreservation(closureStatePath, inverse ? prior : current, inverse)).toThrow(
        "span missing or duplicated",
      );
    });
  }

  it("refuses a second normalization and reauthenticates every returned receipt", () => {
    const { prior } = positive();
    expect(() => beforeClosureStatePreservation(closureStatePath, prior)).toThrow("span missing or duplicated");
    const changed = authenticateClosureStatePreservation();
    changed.records[0]!.after.sha256 = "0".repeat(64);
    expect(authenticateClosureStatePreservation().records[0]!.after.sha256).toBe(row.after.sha256);
    positive();
  });

  for (const invalid of [undefined, null, 0, 1, "true", "inverse", {}, []])
    it("refuses a nonboolean direction after a genuine positive: " + JSON.stringify(invalid), () => {
      const { current } = positive();
      expect(() => applyClosureStatePreservation(closureStatePath, current, invalid as boolean)).toThrow(
        "direction must be boolean",
      );
    });
  it("rejects a nontext source without coercing caller objects", () => {
    const { current } = positive();
    let hits = 0;
    const source = {
      toString() {
        hits++;
        return current;
      },
    };
    expect(() => applyClosureStatePreservation(closureStatePath, source as unknown as string, true)).toThrow(
      "source must be text",
    );
    expect(hits).toBe(0);
  });

  const receiptChanges: readonly [string, (value: ReturnType<typeof authenticateClosureStatePreservation>) => void][] =
    [
      [
        "schema",
        (r) => {
          r.schemaVersion = 2;
        },
      ],
      [
        "scope",
        (r) => {
          r.scope = "runtime source substitution";
        },
      ],
      [
        "base",
        (r) => {
          r.baseCommit = "0".repeat(40);
        },
      ],
      [
        "published after claim",
        (r) => {
          r.afterProvenance.kind = "published-commit";
        },
      ],
      [
        "branch",
        (r) => {
          r.afterProvenance.branch = "unrecorded";
        },
      ],
      [
        "date",
        (r) => {
          r.afterProvenance.recordedOn = "2026-10-01";
        },
      ],
      [
        "frozen input",
        (r) => {
          r.afterProvenance.frozenInputReceipt = "unrecorded";
        },
      ],
      [
        "record removed",
        (r) => {
          r.records = [];
        },
      ],
      [
        "record duplicated",
        (r) => {
          r.records.push(r.records[0]!);
        },
      ],
      [
        "path",
        (r) => {
          r.records[0]!.path = "src/unrecorded.ts";
        },
      ],
      [
        "before hash",
        (r) => {
          r.records[0]!.before.sha256 = "0".repeat(64);
        },
      ],
      [
        "after hash",
        (r) => {
          r.records[0]!.after.sha256 = "0".repeat(64);
        },
      ],
      [
        "before blob",
        (r) => {
          r.records[0]!.before.gitBlob = "0".repeat(40);
        },
      ],
      [
        "after blob",
        (r) => {
          r.records[0]!.after.gitBlob = "0".repeat(40);
        },
      ],
      [
        "bytes",
        (r) => {
          r.records[0]!.after.bytes++;
        },
      ],
      [
        "UTF16 units",
        (r) => {
          r.records[0]!.before.utf16Units++;
        },
      ],
      [
        "span removed",
        (r) => {
          r.records[0]!.spans = [];
        },
      ],
      [
        "span duplicated",
        (r) => {
          r.records[0]!.spans.push(r.records[0]!.spans[0]!);
        },
      ],
      [
        "ordinal",
        (r) => {
          r.records[0]!.spans[0]!.ordinal++;
        },
      ],
      [
        "before offset",
        (r) => {
          r.records[0]!.spans[0]!.beforeOffset++;
        },
      ],
      [
        "after offset",
        (r) => {
          r.records[0]!.spans[0]!.afterOffset++;
        },
      ],
      [
        "before span",
        (r) => {
          r.records[0]!.spans[0]!.before += "\n";
        },
      ],
      [
        "after span",
        (r) => {
          r.records[0]!.spans[0]!.after += "\n";
        },
      ],
      [
        "before span hash",
        (r) => {
          r.records[0]!.spans[0]!.beforeSha256 = "0".repeat(64);
        },
      ],
      [
        "after span hash",
        (r) => {
          r.records[0]!.spans[0]!.afterSha256 = "0".repeat(64);
        },
      ],
      [
        "reversed pins",
        (r) => {
          [r.records[0]!.before, r.records[0]!.after] = [r.records[0]!.after, r.records[0]!.before];
        },
      ],
    ];
  for (const [name, mutate] of receiptChanges)
    it("rejects altered fixed receipt authority after a positive: " + name, () => {
      const { current } = positive();
      const text = raw(closureStateFixture);
      const changed = JSON.parse(text) as ReturnType<typeof authenticateClosureStatePreservation>;
      mutate(changed);
      const altered = JSON.stringify(changed, null, 2) + "\n";
      expect(altered).not.toBe(text);
      expect(() => authenticateClosureStatePreservation(altered)).toThrow("receipt digest mismatch");
      expect(() => applyClosureStatePreservation(closureStatePath, current, true, altered)).toThrow(
        "receipt digest mismatch",
      );
    });
  it("refuses whitespace-only receipt edits and malformed JSON after a positive", () => {
    positive();
    for (const changed of [raw(closureStateFixture) + "\n", "{"])
      expect(() => authenticateClosureStatePreservation(changed)).toThrow("receipt digest mismatch");
  });
});
