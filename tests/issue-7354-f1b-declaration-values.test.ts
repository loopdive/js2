// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 F1b — a top-level function declaration read as a value (one closure per declaration, made by the module-init
// before the first statement, in an immutable home) and direct calls inside closures (R7). Each accepted program runs
// twice: with node's answer (returns) and with a wrong one (throws); a refusal is asserted by its exact text.
import { describe, expect, it } from "vitest";
import { compile } from "../src/test262/test262-prepared-entry.js";
import { preparedOptions, refusal, runPrepared } from "./helpers/prepared-node-agreement.js";

const SLOW = 240_000;

/** `source` and `wrong` (the same program asserting a wrong answer): node returns on the first and throws on both. */
async function agrees(source: string, wrong: string): Promise<void> {
  expect(() => new Function(source)()).not.toThrow();
  expect(() => new Function(wrong)()).toThrow();
  expect(await runPrepared(source)).toBe("returned");
  expect(await runPrepared(wrong)).toBe("threw");
}

describe("#7354 F1b — function declarations as values", () => {
  const IDENTITY =
    "function f() { return 1; } function k() { return 1; } function h() { return f; }\n" +
    "function me() { return me; } var x = early; function early() {}\n" +
    "var g = f; var n = 0; for (var i = 0; i < 3; i++) { if (h() === f) n++; }\n" +
    "var cnt = 0; function bump() { cnt = cnt + 1; } var b = bump; bump();\n";
  it(
    "is one value per declaration: identity, a read in a function, a self-read, before the declaration, in a loop; a statement call stays direct",
    () =>
      agrees(
        `${IDENTITY}if (g !== f || g === k || h() !== f || me() !== me || x !== early || n !== 3 || !f || cnt !== 1 || b !== bump) throw 1;`,
        `${IDENTITY}if (g === f) throw 1;`,
      ),
    SLOW,
  );

  const KIND =
    "function f(a, b) { return b; } function t(v) { return typeof v; }\n" +
    "function isPrimitive(v) { return typeof v !== 'object' && typeof v !== 'function'; }\n" +
    "function tag(v) { return Object.prototype.toString.call(v); }\n";
  it(
    "is a function: typeof, the harness's isPrimitive, its tag, its length and name; a direct call stays a call",
    () =>
      agrees(
        `${KIND}if (typeof f !== "function" || t(f) !== "function" || isPrimitive(f) || tag(f) !== "[object Function]" || f.length !== 2 || f.name !== "f" || f(1, 2) !== 2) throw 1;`,
        `${KIND}if (f.length !== 1) throw 1;`,
      ),
    SLOW,
  );

  const CLOSURES =
    "function isP(v) { return !v; } var c = function (x) { return isP(x); };\n" +
    "function g() { var d = function (x) { return isP(x); }; return d(0); }\n" +
    "function a() { return 1; } var k = function () { return a(); }; var j = a;\n";
  it(
    "calls a declaration directly from a module-init closure and a closure in a function (R7), also one read as a value",
    () =>
      agrees(
        `${CLOSURES}if (c(0) !== true || g() !== true || k() !== 1 || j !== a) throw 1;`,
        `${CLOSURES}if (c(0) !== false) throw 1;`,
      ),
    SLOW,
  );

  it.each([
    ["written", "function f() {} var g = f; f = 1;", "function declaration 'f' read as a value is written"],
    [
      "written through `this`",
      "function f() {} var g = f; function w() { this.f = 0; }",
      "function declaration 'f' read as a value is written",
    ],
    [
      "in a script that runs no top-level code",
      "function k() { return k2; } function k2() { return 1; }",
      "function declaration 'k2' read as a value is in a script that runs no top-level code",
    ],
  ])("refuses a declaration %s by name", async (_label, source, message) => {
    expect(await refusal(source)).toContain(message);
  });

  it("refuses a declaration with a typed parameter read as a value by name", async () => {
    const result = await compile("function f(x: number): number { return x; }\nvar g: any = f;\nf(1);", {
      ...preparedOptions(),
      fileName: "test.ts",
    });
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain(
      "function declaration 'f' read as a value has a typed parameter",
    );
  });
});
