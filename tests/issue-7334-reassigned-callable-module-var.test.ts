// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7334 — legacy records a module `var`'s closure signature from its function
// write (`getter = function () {}`) and calls it by casting to that closure.
// When another write stores a non-function (`getter = 3`) the cast fails, the
// guard throws only for a nullish value, and the call trapped (uncatchable).
// Such a var now takes the dynamic call route, which tests IsCallable: the
// call throws a catchable TypeError, and a function stored last is still called.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const dir = mkdtempSync(join(tmpdir(), "issue-7334-"));

const CASES: Record<string, string> = {
  "the issue repro": `var getter;
getter = function () {};
getter = 3;
assert.throws(TypeError, function () { getter(); });`,
  "caught inside an immediately called function": `var getter; getter = function () {}; getter = 3; var r = 0;
(function () { try { getter(); } catch (e) { r = e instanceof TypeError ? 1 : 2; } })();
assert.sameValue(r, 1);`,
  "a function stored after a number": `var getter; getter = 3; getter = function (a) { return a + 7; }; var r = 0;
(function () { r = getter(1); })();
assert.sameValue(r, 8);`,
  "a var holding only functions keeps working": `var getter; getter = function (a) { return a + 7; }; var r = 0;
(function () { r = getter(1); })();
assert.sameValue(r, 8);`,
};

describe("#7334 a module var reassigned from a function to a number", () => {
  for (const [name, body] of Object.entries(CASES)) {
    const path = join(dir, `${name.replace(/\W+/g, "-")}.js`);
    writeFileSync(path, `/*---\ndescription: issue 7334 ${name}\n---*/\n${body}\n`);
    for (const target of ["standalone", undefined] as const) {
      it(`${name}: passes (${target ?? "gc"})`, async () => {
        const result = await runTest262File(path, "issue-7334", 10000, target);
        expect(result.status, String(result.error ?? "")).toBe("pass");
      });
    }
  }
  it("the issue repro compiles on wasi", async () => {
    const result = await compile(
      `function assert(v) {}
assert.throws = function (C, f) { try { f(); } catch (e) { return; } throw "no throw"; };
${CASES["the issue repro"]}`,
      { fileName: "issue-7334.js", target: "wasi" },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  });
});
