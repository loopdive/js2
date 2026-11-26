// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7330 — `+=` into a string slot concatenates, and from-ast lowers it only
// with a string value (`compoundWriteAdmissible`, then string-evidence). The
// selector judged `out += name` with the number-compound rule, so a numeric
// right-hand side was claimed and then withdrawn. It now refuses it at
// selection (`compound-string-operand`); `string += string` keeps the IR route.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "wasi", options: { target: "wasi" } },
  { name: "gc", options: {} },
];

const REFUSED: Record<string, { source: string; fileName: string; unit: string }> = {
  "a numeric script var": {
    source: `var out = ""; var name = 1; out += name;`,
    fileName: "a.js",
    unit: "<module-init>",
  },
  "a reassigned numeric script var": {
    source: `var out = ""; var name = 1; function h() { name = 2; } h(); out += name;`,
    fileName: "a.js",
    unit: "<module-init>",
  },
  "a number literal": { source: `var out = ""; out += 1;`, fileName: "a.js", unit: "<module-init>" },
  "a numeric parameter into a string local": {
    source: `function f(x: number): string { let s = "a"; s += x; return s; } f(1);`,
    fileName: "a.ts",
    unit: "f",
  },
};

const CLAIMED: Record<string, { source: string; fileName: string; unit: string }> = {
  "a string script var": { source: `var out = ""; var s = "a"; out += s;`, fileName: "a.js", unit: "<module-init>" },
  "a string literal into a string local": {
    source: `function f(x: number): string { let s = "a"; s += "b"; return s; } f(1);`,
    fileName: "a.ts",
    unit: "f",
  },
  "a numeric slot": { source: `var n = 1; n += 2;`, fileName: "a.js", unit: "<module-init>" },
};

async function outcome(testCase: { source: string; fileName: string; unit: string }, options: CompileOptions) {
  const result = await compile(testCase.source, { fileName: testCase.fileName, trackIrOutcomes: true, ...options });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result.irOutcomes?.find((o) => o.displayName === testCase.unit);
}

describe("#7330 string += admission", () => {
  for (const lane of LANES) {
    for (const [name, testCase] of Object.entries(REFUSED)) {
      it(`${name}: refused at selection (${lane.name})`, async () => {
        const unit = await outcome(testCase, lane.options);
        expect(unit?.kind === "unsupported" && unit.stage).toBe("select");
      });
    }
    for (const [name, testCase] of Object.entries(CLAIMED)) {
      it(`${name}: keeps the IR route (${lane.name})`, async () => {
        expect((await outcome(testCase, lane.options))?.irBodyEmitted).toBe(true);
      });
    }
  }

  const path = join(mkdtempSync(join(tmpdir(), "issue-7330-")), "append.js");
  writeFileSync(
    path,
    `/*---\ndescription: issue 7330\n---*/\nvar out = "a"; var name = 1; out += name; out += "b"; assert.sameValue(out, "a1b");\n`,
  );
  for (const target of ["standalone", undefined] as const) {
    it(`appends the number's string (${target ?? "gc"})`, async () => {
      const result = await runTest262File(path, "issue-7330", 10000, target);
      expect(result.status, String(result.error ?? "")).toBe("pass");
    });
  }
});
