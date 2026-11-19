// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7334 — legacy calls a `var` that holds a function by casting it to one
// closure signature: the one recorded from its function write
// (`getter = function () {}`), or the checker's declared type
// (`var getter = function () {}`). When another write stores a non-callable
// (`getter = 3`) the cast fails, the guard throws only for a nullish value,
// and the call trapped (uncatchable). Such a var now takes the dynamic call
// route, which tests IsCallable: the call throws a catchable TypeError, and a
// function stored last is still called. A var whose writes are all functions
// or nullish keeps the direct closure call.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { originalHarnessCompileOptions, parseMeta, runTest262File } from "./test262-runner.js";

const dir = mkdtempSync(join(tmpdir(), "issue-7334-"));

const CAUGHT = `var r = 0; try { g(); } catch (e) { r = e instanceof TypeError ? 1 : 2; } assert.sameValue(r, 1);`;

const CASES: Record<string, string> = {
  "the issue repro": `var getter;
getter = function () {};
getter = 3;
assert.throws(TypeError, function () { getter(); });`,
  "caught inside an immediately called function": `var getter; getter = function () {}; getter = 3; var r = 0;
(function () { try { getter(); } catch (e) { r = e instanceof TypeError ? 1 : 2; } })();
assert.sameValue(r, 1);`,
  "a var initialised with a function": `var g = function () {}; g = 3; ${CAUGHT}`,
  "a var initialised with an arrow": `var g = () => 1; g = 3; ${CAUGHT}`,
  "a var initialised with a function, called from a closure": `var g = function () {}; g = 3; var r = 0;
(function () { try { g(); } catch (e) { r = e instanceof TypeError ? 1 : 2; } })();
assert.sameValue(r, 1);`,
  "an alias that copies the number": `var g; g = function () { return 4; }; var h = g; g = 3; h = g; var r = 0;
try { h(); } catch (e) { r = e instanceof TypeError ? 1 : 2; }
assert.sameValue(r, 1);`,
  "a function-local var initialised with a function": `function f() { var g = function () {}; g = 3;
  try { g(); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; } }
assert.sameValue(f(), 1);`,
  "a function stored after a number": `var getter; getter = 3; getter = function (a) { return a + 7; }; var r = 0;
(function () { r = getter(1); })();
assert.sameValue(r, 8);`,
  "a function stored after a number over a function initializer": `var g = function (a) { return a + 1; }; g = 3;
g = function (a) { return a + 2; };
assert.sameValue(g(1), 3);`,
  "a function-local var given a function again": `function f() { var g = function (a) { return a + 1; }; g = 3;
  g = function (a) { return a + 2; }; return g(1); }
assert.sameValue(f(), 3);`,
  "a var holding only functions keeps working": `var getter; getter = function (a) { return a + 7; }; var r = 0;
(function () { r = getter(1); })();
assert.sameValue(r, 8);`,
};

describe("#7334 a var reassigned from a function to a number", () => {
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

// The route a call takes, read from the locals of the function that holds it:
// the direct closure call casts into `__closure_cast_N`, the dynamic route
// classifies the value through `__dyn_*` locals.
async function callRoute(source: string, funcName: string): Promise<"closure" | "other"> {
  const options = originalHarnessCompileOptions(parseMeta("/*---\ndescription: route\n---*/\n"), "standalone");
  const result = await compile(source, { ...options, fileName: "issue-7334-route.js", emitWat: true });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const wat = result.wat ?? "";
  const start = wat.indexOf(`(func $${funcName} `);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = wat.slice(start, wat.indexOf("\n  (func ", start + 1));
  return body.includes("$__closure_cast_") ? "closure" : "other";
}

describe("#7334 vars that cannot hold a non-callable keep the direct closure call", () => {
  const ROUTES: [string, string, string, "closure" | "other"][] = [
    ["only function writes", `var g; g = function (a) { return a + 7; }; var r = g(1);`, "__module_init", "closure"],
    ["a function initializer", `var g = function (a) { return a + 7; }; var r = g(1);`, "__module_init", "closure"],
    ["a null write", `var g; g = function (a) { return a + 7; }; g = null; var r = g(1);`, "__module_init", "closure"],
    [
      "an undefined write",
      `var g; g = function (a) { return a + 7; }; g = undefined; var r = g(1);`,
      "__module_init",
      "closure",
    ],
    ["a number write", `var g; g = function (a) { return a + 7; }; g = 3; var r = g(1);`, "__module_init", "other"],
    [
      "a local var shadowing a module var that holds a number",
      `var g = 3; function f() { var g; g = function (a) { return a + 7; }; return g(1); } f();`,
      "f",
      "closure",
    ],
    [
      "a function-local number write",
      `function f() { var g; g = function (a) { return a + 7; }; g = 3; return g(1); } f();`,
      "f",
      "other",
    ],
  ];
  for (const [name, source, funcName, route] of ROUTES) {
    it(`${name}: ${route}`, async () => {
      expect(await callRoute(source, funcName)).toBe(route);
    });
  }
});
