import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

// #2088 — per-builtin representation scaffold.
//
// `Array.prototype.join`, `String.fromCharCode` and `String.fromCodePoint`
// each used to re-implement the element-load + ToString + concat/null-handling
// matrix once per representation (host JS-string vs native string vs
// standalone). That duplication bred one bug per variant: join → #1968 /
// #1998 / #2074 / #2075, fromCharCode → #2122 / #1955 (the single-argument
// drop copied independently into all four arms).
//
// The fold + separator + empty-string structure now lives once in
// `src/codegen/builtin-scaffold.ts` (`emitStringJoinFold` /
// `emitVariadicStringConcat`), parameterized by a `StringRepr`. These tests
// pin every lane that routes through the shared primitive so a future bug in
// the shared lowering fails at least one test per representation — the
// structural guarantee #2088 asks for.

async function host(expr: string): Promise<unknown> {
  const exports = await compileToWasm(`export function test(): string { return ${expr}; }`);
  return (exports as { test: () => unknown }).test();
}

function envImports(imports: ReadonlyArray<{ module: string; name: string }>): string[] {
  return imports.filter((i) => i.module === "env").map((i) => i.name);
}

async function standaloneLen(body: string): Promise<number> {
  const r = await compile(`export function run(): number { ${body} }`, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const leaked = envImports(r.imports);
  expect(leaked, `--target standalone leaked env imports: ${leaked.join(", ")}`).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#2088 join — shared fold across representations", () => {
  // ── host JS-string lane ──
  it("host: string[] join", async () => {
    expect(await host(`["a","b","c"].join("-")`)).toBe("a-b-c");
  });
  it("host: number[] join coerces each element (#1998)", async () => {
    expect(await host(`[1,2,3].join(",")`)).toBe("1,2,3");
  });
  it("host: empty array joins to '' not 'null' (#1968)", async () => {
    expect(await host(`([] as number[]).join(",")`)).toBe("");
  });
  it("host: default separator is ','", async () => {
    expect(await host(`[1,2,3].join()`)).toBe("1,2,3");
  });

  // ── standalone / native-string lane (zero host imports) ──
  it("standalone: string[] join length (#2074)", async () => {
    expect(await standaloneLen(`const a: string[] = ["x","y","z"]; return a.join(";").length;`)).toBe(5);
  });
  it("standalone: number[] join length", async () => {
    expect(await standaloneLen(`const a: number[] = [10,20]; return a.join(",").length;`)).toBe(5);
  });
  it("standalone: default separator ','", async () => {
    expect(await standaloneLen(`const a: string[] = ["a","b","c"]; return a.join().length;`)).toBe(5);
  });
});

describe("#2088 fromCharCode / fromCodePoint — shared variadic concat", () => {
  // ── host lane ──
  it("host: fromCharCode single arg", async () => {
    expect(await host(`String.fromCharCode(65)`)).toBe("A");
  });
  it("host: fromCharCode keeps ALL args (#2122 / #1955)", async () => {
    expect(await host(`String.fromCharCode(104,105,33)`)).toBe("hi!");
  });
  it("host: fromCodePoint keeps ALL args (surrogate pairs)", async () => {
    expect(await host(`String.fromCodePoint(97, 0x1F600)`)).toBe("a\u{1F600}");
  });

  // ── native lane (standalone): assert correct length, zero host imports ──
  it("standalone: fromCharCode single arg length", async () => {
    expect(await standaloneLen(`return String.fromCharCode(65).length;`)).toBe(1);
  });
  it("standalone: fromCharCode keeps all args (#2122)", async () => {
    expect(await standaloneLen(`return String.fromCharCode(104,105,33).length;`)).toBe(3);
  });
  it("standalone: fromCodePoint keeps all args incl. surrogate pair", async () => {
    // "a" (1 unit) + U+1F600 (2 units, a surrogate pair) = 3 UTF-16 units.
    expect(await standaloneLen(`return String.fromCodePoint(97, 0x1F600).length;`)).toBe(3);
  });
});
