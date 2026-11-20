// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7410 — TypeScript names a symbol-keyed member `__@replace@<id>` with a process-global id. Neither the `.name` a
// program reads nor an emitted function name may carry it: the first is a wrong value, and both change with how many
// compiles the process ran before.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const NAME_ROWS: readonly (readonly [string, string])[] = [
  ["a built-in method keyed by a well-known symbol", "RegExp.prototype[Symbol.replace].name"],
  ["String's [Symbol.iterator], named by its key", "String.prototype[Symbol.iterator].name"],
  ["Array's [Symbol.iterator], an alias of values", "Array.prototype[Symbol.iterator].name"],
  ["Map's [Symbol.iterator], an alias of entries", "Map.prototype[Symbol.iterator].name"],
  ["Set's [Symbol.iterator], an alias of values", "Set.prototype[Symbol.iterator].name"],
  ["a typed array's [Symbol.iterator], an alias of values", "Uint8Array.prototype[Symbol.iterator].name"],
  [
    "an object-literal method keyed by a well-known symbol",
    "({ [Symbol.toPrimitive]() {} } as any)[Symbol.toPrimitive].name",
  ],
  ["a static class method keyed by a well-known symbol", "(C as any)[Symbol.hasInstance].name"],
  ["a method keyed by a user symbol", "(() => { const k = Symbol('k'); const o = { [k]() {} }; return o[k].name; })()"],
  ["a method keyed by a string", "({ f() {} }).f.name"],
];

const PRELUDE = "class C { static [Symbol.hasInstance](v: unknown) { return false; } }";

/** What node answers for the row's expression (the TypeScript-only `as any` stripped). */
function nodeAnswer(expression: string): string {
  const js = expression.replaceAll(" as any", "");
  return new Function(`${PRELUDE.replace("v: unknown", "v")}; return ${js};`)() as string;
}

async function runsTrue(source: string, target: "default" | "standalone"): Promise<number> {
  const result = await compile(source, target === "standalone" ? { target: "standalone" } : {});
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    (target === "standalone" ? {} : result.importObject) as WebAssembly.Imports,
  );
  return (instance.exports as { run(): number }).run();
}

describe("#7410 — a symbol-keyed function's name", () => {
  for (const target of ["default", "standalone"] as const) {
    it.each(NAME_ROWS)(`answers like node on ${target}: %s`, async (_, expression) => {
      const expected = nodeAnswer(expression);
      const source = `${PRELUDE}\nexport function run(): number { return ${expression} === ${JSON.stringify(expected)} ? 1 : 0; }`;
      expect(await runsTrue(source, target)).toBe(1);
    });
  }

  it("node gives the spec's [Symbol.replace]", () => {
    expect(nodeAnswer("RegExp.prototype[Symbol.replace].name")).toBe("[Symbol.replace]");
  });
});

describe("#7410 — emitted function names carry no TypeScript symbol id", () => {
  it.each(["default", "standalone"] as const)("on %s", async (target) => {
    const source = `export function run(): number {
      const resource = { disposed: 0, [Symbol.dispose]() { this.disposed = 1; } };
      resource[Symbol.dispose]();
      return resource.disposed;
    }`;
    const result = await compile(source, target === "standalone" ? { target: "standalone" } : {});
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const bytes = Buffer.from(result.binary).toString("latin1");
    expect(bytes).toContain("__@dispose");
    expect(bytes).not.toMatch(/__@[A-Za-z]+@\d/);
  });
});
