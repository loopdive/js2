// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7332 — `null` has no IR value outside a reference consumer. A prefix `-`,
// `+` or `!` reads ToNumber(null) (+0) or a falsy value, so from-ast lowers the
// operand as the number 0 instead of withdrawing the unit. An object literal
// field is lowered under an f64 hint, so the selector refuses a field that may
// hold `null` (`objectlit-null-field`) instead of claiming it.
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

const CLAIMED: Record<string, string> = {
  "-null": `var o; function h() { o = -null; } h();`,
  "-(null)": `var o; function h() { o = -(null); } h();`,
  "+null": `var o; function h() { o = +null; } h();`,
  "!null": `var o; function h() { o = !null; } h();`,
  "-null as a statement call's argument": `var f = function (a) {}; function h() { f(-null); } h();`,
};

const REFUSED: Record<string, string> = {
  "{ a: null }": `var o; function h() { o = { a: null }; } h();`,
  "{ a: null } as a statement call's argument": `var f = function (a) {}; function h() { f({ a: null }); } h();`,
  "a field that may yield null": `var o; function h(c) { o = { a: c ? null : 1 }; } h(1);`,
};

async function unitH(source: string, options: CompileOptions) {
  const result = await compile(source, { fileName: "issue-7332.js", trackIrOutcomes: true, ...options });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result.irOutcomes?.find((o) => o.displayName === "h");
}

describe("#7332 null into a number context", () => {
  for (const lane of LANES) {
    for (const [name, source] of Object.entries(CLAIMED)) {
      it(`${name}: IR (${lane.name})`, async () => {
        expect((await unitH(source, lane.options))?.irBodyEmitted).toBe(true);
      });
    }
    for (const [name, source] of Object.entries(REFUSED)) {
      it(`${name}: refused at selection (${lane.name})`, async () => {
        const h = await unitH(source, lane.options);
        expect(h?.kind === "unsupported" && h.stage).toBe("select");
      });
    }
  }

  const path = join(mkdtempSync(join(tmpdir(), "issue-7332-")), "values.js");
  writeFileSync(
    path,
    `/*---\ndescription: issue 7332\n---*/
var a, b, c;
function h() { a = -null; b = +null; c = !null; }
h();
assert.sameValue(a, -0);
assert.sameValue(b, 0);
assert.sameValue(c, true);
`,
  );
  for (const target of ["standalone", undefined] as const) {
    it(`values match JS (${target ?? "gc"})`, async () => {
      const result = await runTest262File(path, "issue-7332", 10000, target);
      expect(result.status, String(result.error ?? "")).toBe("pass");
    });
  }
});
