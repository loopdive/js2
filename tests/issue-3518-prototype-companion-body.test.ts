// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { applyPrototypeCompanionExtraction } from "./helpers/prototype-companion-extraction.js";
import { createHash } from "node:crypto";
import { readBeforeResumeMain } from "./helpers/resume-main-composition.js";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildPrototypeCompanionBody } from "../src/runtime/wasmgc/values/prototype-companion-body.js";

const read = readBeforeResumeMain;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const text = read("tests/fixtures/issue-3518-prototype-companion-extraction.json");
if (sha(text) !== "edf78072c621f8dd72ed74307c33857772beb4ee82ffdba118e67c73b97be739")
  throw new Error("prototype companion donor receipt changed");
const receipt = JSON.parse(text) as {
  base: string;
  path: string;
  baseSha256: string;
  before: string;
  after: string;
  import: string;
};
const current = read(receipt.path);
function originalSource(source = current): string {
  for (const span of [receipt.after, receipt.import])
    if (source.split(span).length !== 2) throw new Error("companion extraction missing or duplicated");
  const original = applyPrototypeCompanionExtraction(source, true);
  expect(original).toBe(source.replace(receipt.after, receipt.before).replace(receipt.import, ""));
  if (sha(original) !== receipt.baseSha256) throw new Error("companion original source mismatch");
  return original;
}

interface Scenario {
  offsets: [number, string][];
  missing?: string;
  changing?: boolean;
  absent?: boolean;
}
function capture(source: string, scenario: Scenario) {
  const body = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const calls: string[] = [];
  const fn: { locals?: unknown; body?: unknown } = {};
  const counts = new Map<string, number>();
  const ctx = {
    funcMap: {
      get(name: string) {
        const count = (counts.get(name) ?? 0) + 1;
        counts.set(name, count);
        calls.push(`get:${name}:${count}`);
        if (name === scenario.missing) return undefined;
        return (name === "zero" ? 0 : 31) + (scenario.changing && count > 1 ? 17 : 0);
      },
    },
  };
  const run = new Function(
    "findFn",
    "PROTOIDX_COMPANION",
    "nativeProtoSeedersByBrandOffset",
    "BUILTIN_BRAND_COUNT",
    "buildPrototypeCompanionBody",
    `${body}\nreturn fillCompanionBody;`,
  )(
    () => {
      calls.push("find");
      return scenario.absent ? undefined : fn;
    },
    "__protoidx_companion",
    () => {
      calls.push("seeders");
      return new Map(scenario.offsets);
    },
    49,
    buildPrototypeCompanionBody,
  );
  run(ctx, { tableGlobalIdx: 7, tableArrTypeIdx: 11, newPlainObjectIdx: 19 });
  return { fn, calls };
}

describe("canonical prototype companion publication and seeding", () => {
  it("reconstructs the complete signed source and replays exact live bytes", () => {
    expect(receipt.base).toBe("65448565c7358581ca3e229fd3ce7537fae4b41f");
    const original = originalSource();
    expect(original.replace(receipt.before, receipt.after).replace("\n", "\n" + receipt.import)).toBe(current);
  });
  it.each([
    { offsets: [] },
    { offsets: [[18, "object"]] },
    {
      offsets: [
        [18, "object"],
        [3, "missing"],
        [1, "zero"],
      ],
      missing: "missing",
    },
    {
      offsets: [
        [18, "object"],
        [1, "zero"],
      ],
      changing: true,
    },
    { offsets: [[18, "object"]], absent: true },
  ] as Scenario[])("preserves every instruction/local and both late acquisitions: %j", (scenario) => {
    originalSource();
    expect(capture(receipt.after, scenario)).toStrictEqual(capture(receipt.before, scenario));
  });
  it("publishes the companion slot before calling a reentrant seeder", () => {
    const { fn } = capture(receipt.after, { offsets: [[18, "object"]] });
    const serialized = JSON.stringify(fn.body);
    expect(serialized.indexOf('"op":"global.set"')).toBeLessThan(serialized.indexOf('"op":"array.get"'));
    expect(serialized.indexOf('"op":"array.set"')).toBeLessThan(serialized.indexOf('"funcIdx":31'));
  });
  it.each(["missing", "duplicated", "outside"])("refuses %s changes after a positive reconstruction", (mutation) => {
    originalSource();
    const changed =
      mutation === "missing"
        ? current.replace(receipt.after, "")
        : mutation === "duplicated"
          ? current.replace(receipt.after, receipt.after + receipt.after)
          : current + "\n// unrelated change\n";
    expect(() => originalSource(changed)).toThrow();
  });
});

describe("prototype extraction retains its current runtime builder", () => {
  it.each([
    "src/runtime/wasmgc/values/prototype-companion-body.ts",
    "tests/fixtures/issue-3518-prototype-companion-extraction.json",
  ])("rejects changed %s after a positive replay", (path) => {
    const original = originalSource();
    expect(applyPrototypeCompanionExtraction(original, false)).toBe(current);
    const changedReader = (file: string) => read(file) + (file === path ? "\n" : "");
    expect(() => applyPrototypeCompanionExtraction(current, true, changedReader)).toThrow("mismatch");
    expect(() => applyPrototypeCompanionExtraction(original, false, changedReader)).toThrow("mismatch");
  });
});
