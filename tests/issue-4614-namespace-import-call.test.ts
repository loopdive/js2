// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4614 — `import * as ns` + `ns.f(...)` from a compiled sibling module. The
// namespace binding has no runtime value, so the call previously lowered to
// `__extern_method_call(null, "f", …)` and threw `Cannot read properties of
// null` — every test of cookie's vitest-harness upstream suite (65/63740).
// Namespace member calls are statically resolvable per ESM semantics and now
// re-enter the named-call lowering.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

async function compileAndRunMulti(files: Record<string, string>, entryFile: string) {
  const result = await compileMulti(files, entryFile);
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
  (result.importObject as { __setExports?: (e: WebAssembly.Exports) => void }).__setExports?.(instance.exports);
  return instance.exports as Record<string, Function>;
}

describe("#4614 namespace-import member calls", () => {
  it("calls a sibling module's export through import * as", async () => {
    const files = {
      "./lib.ts": `
        export function parse(s: string): string {
          return "p:" + s;
        }
        export function double(n: number): number {
          return n * 2;
        }
      `,
      "./main.ts": `
        import * as lib from "./lib";
        export function run(s: string, n: number): string {
          return lib.parse(s) + ":" + lib.double(n);
        }
      `,
    };
    const e = await compileAndRunMulti(files, "./main.ts");
    expect(e.run("x", 21)).toBe("p:x:42");
  });

  it("a ternary's null arm bound to a vec slot stays null (cookie it.each shape)", async () => {
    const files = {
      "./lib.ts": `
        function makeRows() {
          const rows: Array<{ k: string }> = [];
          rows.push({ k: "x" });
          return rows;
        }
        export function pick(flag) {
          const tableRows = flag ? makeRows() : null;
          const fallback = ["a", "b"];
          const source = tableRows || fallback;
          return (tableRows === null) + ":" + source.length;
        }
      `,
      "./main.ts": `
        import * as lib from "./lib";
        export function run(flag: any): string {
          return lib.pick(flag);
        }
      `,
    };
    const e = await compileAndRunMulti(files, "./main.ts");
    expect(e.run(false)).toBe("true:2");
    expect(e.run(true)).toBe("false:1");
  });

  it("named imports through the same module keep working", async () => {
    const files = {
      "./lib.ts": `
        export function parse(s: string): string {
          return "p:" + s;
        }
      `,
      "./main.ts": `
        import * as lib from "./lib";
        import { parse } from "./lib";
        export function run(s: string): string {
          return parse(s) + "|" + lib.parse(s);
        }
      `,
    };
    const e = await compileAndRunMulti(files, "./main.ts");
    expect(e.run("y")).toBe("p:y|p:y");
  });
});
