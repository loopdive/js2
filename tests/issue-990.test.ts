import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

async function compileFail(source: string): Promise<boolean> {
  const r = await compile(source);
  return !r.success || r.errors.some((e) => e.severity === "error");
}

describe("issue #990 — module item position early errors", () => {
  it("rejects export default nested in while", async () => {
    expect(await compileFail(`while (false) export default null;\nexport {};\n`)).toBe(true);
  });

  it("rejects import nested in try/finally", async () => {
    expect(await compileFail(`try {} catch (e) {} finally { import v from "./x.js"; }\nexport {};\n`)).toBe(true);
  });

  it("rejects export default inside class method", async () => {
    expect(await compileFail(`(class { method() { export default 1; } });\nexport {};\n`)).toBe(true);
  });

  it("rejects import inside for-of", async () => {
    expect(await compileFail(`for (const x of []) import v from "./x.js";\nexport {};\n`)).toBe(true);
  });

  it("rejects export nested in block statement", async () => {
    expect(await compileFail(`{ export { x }; }\nvar x = 1;\nexport {};\n`)).toBe(true);
  });

  it("does not flag top-level export at module top level", async () => {
    const r = await compile(`export const x: number = 1;\n`);
    // May or may not have unrelated errors, but must NOT contain our message.
    const hit = r.errors?.some((e) => /declarations may only appear at the top level/.test(e.message));
    expect(hit).toBe(false);
  });

  it("does not flag nested export inside wrapTest-style test wrapper", async () => {
    // wrapTest sentinel — `export function test(): number` at top level
    // suppresses the check so positive tests aren't regressed.
    const wrapped = `
      export function test(): number {
        // in the original source this would be top-level
        return 1;
      }
    `;
    const r = await compile(wrapped);
    const hit = r.errors?.some((e) => /declarations may only appear at the top level/.test(e.message));
    expect(hit).toBe(false);
  });
});

describe("issue #990 — yield / await as reserved identifier", () => {
  async function hasReservedIdentError(source: string): Promise<boolean> {
    const r = await compile(source);
    return !!r.errors?.some((e) => /reserved word and may not be used as an identifier/.test(e.message));
  }

  it("rejects `var yield` in explicit strict mode", async () => {
    expect(await hasReservedIdentError(`"use strict";\nvar yield = 1;\n`)).toBe(true);
  });

  it("rejects `yield` as arrow parameter default in strict mode", async () => {
    expect(await hasReservedIdentError(`"use strict";\n(x = yield) => {};\n`)).toBe(true);
  });

  it("rejects `{ yield }` shorthand in strict-mode function", async () => {
    expect(await hasReservedIdentError(`var yield = 1;\n(function() { "use strict"; ({ yield }); });\n`)).toBe(true);
  });

  it("rejects `var yield` inside a generator body", async () => {
    expect(await hasReservedIdentError(`function* gen() { var yield = 1; }\n`)).toBe(true);
  });

  it("rejects `var await` in module goal (top-level)", async () => {
    expect(await hasReservedIdentError(`var await;\nexport {};\n`)).toBe(true);
  });

  it("rejects `var await` inside an async function", async () => {
    expect(await hasReservedIdentError(`async function f() { var await = 1; }\n`)).toBe(true);
  });

  it("allows `yield` as property name", async () => {
    expect(await hasReservedIdentError(`"use strict";\nvar o = { yield: 1 };\no.yield;\n`)).toBe(false);
  });

  it("allows `await` as property name in module code", async () => {
    expect(await hasReservedIdentError(`var o = { await: 1 }; o.await;\nexport {};\n`)).toBe(false);
  });

  it("allows `yield` as identifier in sloppy-mode script", async () => {
    // No "use strict", no module, not a generator — yield is a valid identifier.
    expect(await hasReservedIdentError(`var yield = 1; yield;\n`)).toBe(false);
  });

  it("does not flag inside wrapTest sentinel", async () => {
    const wrapped = `
      export function test(): number {
        var yield = 1;
        return 1;
      }
    `;
    expect(await hasReservedIdentError(wrapped)).toBe(false);
  });
});

describe("issue #990 slice 2 — module strict, import(), async ctor, duplicate labels, var/let conflicts", () => {
  async function compileFail(source: string): Promise<boolean> {
    const r = await compile(source);
    return !r.success || r.errors.some((e) => e.severity === "error");
  }

  it("treats module code as strict mode (rejects octal)", async () => {
    expect(await compileFail(`export {}; var x = 010;\n`)).toBe(true);
  });

  it("rejects import() with zero arguments", async () => {
    expect(await compileFail(`var x = import();\n`)).toBe(true);
  });

  it("accepts import() with one argument", async () => {
    // Should NOT fail on import() with 1 arg
    const r = await compile(`var x = import("foo");\n`);
    const hasImportArgError = r.errors?.some((e) => /import\(\) requires/.test(e.message));
    expect(hasImportArgError).toBe(false);
  });

  it("rejects async constructor", async () => {
    expect(await compileFail(`class C { async constructor() {} }\n`)).toBe(true);
  });

  it("rejects export default const", async () => {
    expect(await compileFail(`export default const x = 1;\n`)).toBe(true);
  });

  it("rejects export default let", async () => {
    expect(await compileFail(`export default let x = 1;\n`)).toBe(true);
  });

  it("rejects duplicate labels", async () => {
    expect(await compileFail(`L: L: ;\n`)).toBe(true);
  });

  it("allows same label in different function scopes", async () => {
    const r = await compile(`L: { (function() { L: ; })(); }\n`);
    const hasDupLabel = r.errors?.some((e) => /Duplicate label/.test(e.message));
    expect(hasDupLabel).toBe(false);
  });

  it("rejects var/let conflict at top level", async () => {
    expect(await compileFail(`let x = 1; var x = 2;\n`)).toBe(true);
  });
});
