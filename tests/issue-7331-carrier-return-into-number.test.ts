// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7331 — a script var in its dynamic module home lowers to the dynamic
// carrier, and so do a member read, a method call and a `+` over it, whatever
// the checker types them. A function whose result resolves to a number cannot
// return one (`coerceReturnValue` has no carrier-to-number arm), and a
// conditional cannot join one with a number, so the selector refuses both
// instead of claiming the function and withdrawing it after the claim. A
// result legacy widens to the carrier (a binding written across domains) is
// the carrier in the IR too, and keeps the IR route.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { originalHarnessCompileOptions, parseMeta, runTest262File } from "./test262-runner.js";

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "wasi", options: { target: "wasi" } },
  { name: "gc", options: {} },
];

const FN = `var p = function (a, b) {};`;
const REFUSED: Record<string, string> = {
  "a function-valued script var": `${FN} function h() { return p.length; } h();`,
  "a lib-named script var (print)": `var print = function (a, b) {}; function h() { return print.length; } h();`,
  "a lib-named script var (isNaN)": `var isNaN = function (a, b) {}; function h() { return isNaN.length; } h();`,
  "a + over the carrier": `${FN} function h() { return p.length + 1; } h();`,
  "both arms of a conditional": `${FN} function h(c) { return c ? p.length : p.length; } h(1);`,
  "a conditional joining the carrier with a number": `${FN} function h(c) { return c ? p.length : 0; } h(1);`,
  "a carrier var written in the function": `var y; function h() { y = -null; return y; } h();`,
};

async function unitH(source: string, options: CompileOptions) {
  const result = await compile(source, { fileName: "issue-7331.js", trackIrOutcomes: true, ...options });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result.irOutcomes?.find((o) => o.displayName === "h");
}

function fixture(name: string, body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "issue-7331-")), `${name}.js`);
  writeFileSync(path, `/*---\ndescription: issue 7331\n---*/\n${body}\n`);
  return path;
}

/** `h`'s outcome in the runner's own compile of the fixture (harness included). */
async function runnerUnitH(path: string, target: "standalone" | undefined) {
  const source = readFileSync(path, "utf8");
  const meta = parseMeta(source);
  const variant = assembleOriginalHarness(source, meta).primary;
  const options = { ...originalHarnessCompileOptions(meta, target), fileName: path, trackIrOutcomes: true };
  const result = await compile(variant.source, options);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  return result.irOutcomes?.find((o) => o.displayName === "h");
}

const RUNS: Record<string, { body: string; ir: boolean }> = {
  length: { body: `${FN} function h() { return p.length; }\nassert.sameValue(h(), 2);`, ir: false },
  "conditional-length": {
    body: `${FN} function h(c) { return c ? p.length : 0; }\nassert.sameValue(h(1), 2);\nassert.sameValue(h(0), 0);`,
    ir: false,
  },
  "widened-read": {
    body: `var n = 1; function set() { n = 'x'; } function h() { return n; }\nassert.sameValue(h(), 1); set(); assert.sameValue(h(), 'x');`,
    ir: true,
  },
  "widened-add": {
    body: `var n = 1; function set() { n = 'x'; } function h() { return n + 1; }\nassert.sameValue(h(), 2); set(); assert.sameValue(h(), 'x1');`,
    ir: true,
  },
};

describe("#7331 a carrier returned into a number result", () => {
  for (const lane of LANES) {
    for (const [name, source] of Object.entries(REFUSED)) {
      it(`${name}: refused at selection (${lane.name})`, async () => {
        const h = await unitH(source, lane.options);
        expect(h?.kind === "unsupported" && h.stage).toBe("select");
      });
    }
    it(`a method call over the carrier: refused as the carrier, not by the move-only scan (${lane.name})`, async () => {
      const h = await unitH(`${FN} p.m = function () { return 1; }; function h() { return p.m(); } h();`, lane.options);
      expect(h?.kind === "unsupported" && h.code).toBe("body-shape-rejected");
    });
    it(`a numeric script var keeps the IR route (${lane.name})`, async () => {
      expect((await unitH(`var n = 5; function h() { return n + 1; } h();`, lane.options))?.irBodyEmitted).toBe(true);
    });
  }

  for (const [name, { body, ir }] of Object.entries(RUNS)) {
    const path = fixture(name, body);
    for (const target of ["standalone", undefined] as const) {
      it(`${name}: ${ir ? "IR" : "legacy"}, and passes (${target ?? "gc"})`, async () => {
        expect((await runnerUnitH(path, target))?.irBodyEmitted).toBe(ir);
        const result = await runTest262File(path, "issue-7331", 10000, target);
        expect(result.status, String(result.error ?? "")).toBe("pass");
      });
    }
  }
});
