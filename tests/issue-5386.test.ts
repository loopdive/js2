// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(body: string, flag: boolean | boolean[] = false, standalone = false): Promise<unknown> {
  const result = await compile(
    `export function test(flag: boolean) { ${body} }`,
    standalone ? { target: "standalone" } : {},
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
  const test = instance.exports.test as (flag: boolean) => unknown;
  return Array.isArray(flag) ? flag.map((value) => test(value)) : test(flag);
}

describe("#5386 — conditional object aliases preserve property writes", () => {
  it("uses the live property value for addition through the original object", async () => {
    expect(await run(`const a = { x: 1 }; const b = true ? a : { x: "" }; b.x = "x"; return a.x + 1;`)).toBe("x1");
  });

  it("selects both branches in the same compiled module", async () => {
    expect(
      await run(`const a = { x: 1 }; const b = flag ? a : { x: "" }; b.x = "x"; return a.x + 1;`, [true, false]),
    ).toEqual(["x1", 2]);
  });

  for (const flag of [true, false]) {
    it(`preserves runtime selection (${flag}) and unrelated same-named properties`, async () => {
      expect(
        await run(
          `
        const a = { x: 1 }; const other = { x: "" }; const unrelated = { x: 4 };
        const b = flag ? a : other;
        b.x = "x";
        return (a.x + 1 === ${flag ? '"x1"' : "2"}) &&
          (other.x === ${flag ? '""' : '"x"'}) && unrelated.x + 1 === 5 && b === ${flag ? "a" : "other"};
      `,
          flag,
        ),
      ).toBe(1);
    });
  }

  it("preserves widened addition under standalone runtime equality", async () => {
    expect(
      await run(`const a = { x: 1 }; const b = flag ? a : { x: "" }; b.x = "x"; return a.x + 1 === "x1";`, true, true),
    ).toBe(1);
  });

  it("keeps numeric-only conditional aliases numeric", async () => {
    expect(await run(`const a = { x: 1 }; const b = flag ? a : { x: 3 }; b.x = 7; return a.x + 1;`, true)).toBe(8);
  });

  it("preserves an inferred intermediate local", async () => {
    expect(
      await run(
        `const a = { x: 1 }; const b = true ? a : { x: "" }; b.x = "x"; const result = a.x + 1; return result;`,
      ),
    ).toBe("x1");
  });

  it("preserves a numeric write and reversed addition through a chained alias", async () => {
    expect(
      await run(`
      const a = { x: "initial" }; const b = true ? a : { x: 1 }; const c = b;
      c.x = 2; return 1 + a.x;
    `),
    ).toBe(3);
  });
});
