// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7331 — a script var in its dynamic module home lowers to the dynamic
// carrier, and so do a member read, a method call and a `+` over it, whatever
// the checker types them. A function whose result resolves to a number cannot
// return one (`coerceReturnValue` has no carrier-to-number arm), so the
// selector refuses it (`return-carrier-into-number`) instead of claiming it and
// withdrawing it after the claim. A numeric script var's read stays IR.
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

const REFUSED: Record<string, string> = {
  "a function-valued script var": `var p = function (a, b) {}; function h() { return p.length; } h();`,
  "a lib-named script var (print)": `var print = function (a, b) {}; function h() { return print.length; } h();`,
  "a lib-named script var (isNaN)": `var isNaN = function (a, b) {}; function h() { return isNaN.length; } h();`,
  "a + over the carrier": `var p = function (a, b) {}; function h() { return p.length + 1; } h();`,
};

async function unitH(source: string, options: CompileOptions) {
  const result = await compile(source, { fileName: "issue-7331.js", trackIrOutcomes: true, ...options });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result.irOutcomes?.find((o) => o.displayName === "h");
}

describe("#7331 a carrier returned into a number result", () => {
  for (const lane of LANES) {
    for (const [name, source] of Object.entries(REFUSED)) {
      it(`${name}: refused at selection (${lane.name})`, async () => {
        const h = await unitH(source, lane.options);
        expect(h?.kind === "unsupported" && h.stage).toBe("select");
      });
    }
    it(`a numeric script var keeps the IR route (${lane.name})`, async () => {
      expect((await unitH(`var n = 5; function h() { return n + 1; } h();`, lane.options))?.irBodyEmitted).toBe(true);
    });
  }

  const path = join(mkdtempSync(join(tmpdir(), "issue-7331-")), "length.js");
  writeFileSync(
    path,
    `/*---\ndescription: issue 7331\n---*/\nvar p = function (a, b) {}; function h() { return p.length; }\nassert.sameValue(h(), 2);\n`,
  );
  for (const target of ["standalone", undefined] as const) {
    it(`returns the length (${target ?? "gc"})`, async () => {
      const result = await runTest262File(path, "issue-7331", 10000, target);
      expect(result.status, String(result.error ?? "")).toBe("pass");
    });
  }
});
