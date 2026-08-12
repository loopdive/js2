// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { compile, compileMulti, createIncrementalCompiler, type CompileResult } from "../src/index.ts";

async function instantiate(result: CompileResult, imports: WebAssembly.Imports = {}): Promise<WebAssembly.Exports> {
  expect(result.success, result.errors.map((error) => error.message).join(" | ")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports;
}

describe("#4377 — compileMulti file-URL module identity", () => {
  it("keeps the same-module shorthand callable control", async () => {
    const result = await compile(
      `function cwd(): number { return 42; }
       const Deno = { cwd };
       export function probe(): number { return Deno.cwd(); }`,
      { target: "standalone", emitWat: false },
    );
    const exports = await instantiate(result);
    expect((exports.probe as () => number)()).toBe(42);
  });

  it("keeps a shorthand callable through a named cross-module object import", async () => {
    const result = await compileMulti(
      {
        "./deno.ts": `function cwd(): number { return 42; }
                      export const Deno = { cwd };`,
        "./main.ts": `import { Deno } from "./deno.ts";
                      export function probe(): number { return Deno.cwd(); }`,
      },
      "./main.ts",
      { target: "standalone", emitWat: false },
    );
    const exports = await instantiate(result);
    expect((exports.probe as () => number)()).toBe(42);
  });

  it("keeps a native-string-returning shorthand callable through a named import", async () => {
    const result = await compileMulti(
      {
        "./deno.ts": `function cwd(): string { return "abc"; }
                      export const Deno = { cwd };`,
        "./main.ts": `import { Deno } from "./deno.ts";
                      export function probe(): number { return Deno.cwd().length; }`,
      },
      "./main.ts",
      { target: "standalone", emitWat: false },
    );
    const exports = await instantiate(result);
    expect((exports.probe as () => number)()).toBe(3);
  });

  it("invokes the typed host import through the cross-module object field", async () => {
    let calls = 0;
    const result = await compileMulti(
      {
        "./deno.ts": `declare function op_cwd_length(): number;
                      function cwd(): number { return op_cwd_length(); }
                      export const Deno = { cwd };`,
        "./main.ts": `import { Deno } from "./deno.ts";
                      export function probe(): number { return Deno.cwd(); }`,
      },
      "./main.ts",
      {
        target: "standalone",
        emitWat: false,
        externImportModule: "v8x:deno",
      },
    );
    const exports = await instantiate(result, {
      "v8x:deno": {
        op_cwd_length: () => {
          calls++;
          return 42;
        },
      },
    });
    expect((exports.probe as () => number)()).toBe(42);
    expect(calls).toBe(1);
  });

  it("invokes primitive host imports from a string-building object field", async () => {
    let calls = 0;
    const result = await compileMulti(
      {
        "./deno.ts": `declare function op_len(): number;
                      declare function op_unit(index: number): number;
                      function cwd(): string {
                        const length = op_len();
                        let value = "";
                        for (let index = 0; index < length; index++) {
                          value += String.fromCharCode(op_unit(index));
                        }
                        return value;
                      }
                      export const Deno = { cwd };`,
        "./main.ts": `import { Deno } from "./deno.ts";
                      export function probe(): number { return Deno.cwd().length; }`,
      },
      "./main.ts",
      {
        target: "standalone",
        emitWat: false,
        externImportModule: "v8x:deno",
      },
    );
    const exports = await instantiate(result, {
      "v8x:deno": {
        op_len: () => {
          calls++;
          return 3;
        },
        op_unit: (index: number) => {
          calls++;
          return "abc".charCodeAt(index);
        },
      },
    });
    expect((exports.probe as () => number)()).toBe(3);
    expect(calls).toBe(4);
  });

  it("keeps both Deno.cwd probes live beside another imported module", async () => {
    let calls = 0;
    const result = await compileMulti(
      {
        "./main.ts": `import { add } from "./math.ts";
                      import { Deno } from "./deno.ts";
                      const answer: number = add(20, 22);
                      if (answer !== 42) throw new Error("wrong result");
                      export function __v8x_probe_cwd_utf16_length(): number {
                        return Deno.cwd().length;
                      }
                      export function __v8x_probe_cwd_utf16_checksum(): number {
                        const value = Deno.cwd();
                        let checksum = 0;
                        for (let index = 0; index < value.length; index++) {
                          checksum += (index + 1) * value.charCodeAt(index);
                        }
                        return checksum;
                      }`,
        "./math.ts": `export function add(left: number, right: number): number { return left + right; }`,
        "./deno.ts": `declare function __v8x_op_cwd_utf16_length(): number;
                      declare function __v8x_op_cwd_utf16_code_unit(index: number): number;
                      function cwd(): string {
                        const length = __v8x_op_cwd_utf16_length();
                        let value = "";
                        for (let index = 0; index < length; index++) {
                          value += String.fromCharCode(__v8x_op_cwd_utf16_code_unit(index));
                        }
                        return value;
                      }
                      export const Deno = { cwd };`,
      },
      "./main.ts",
      {
        target: "standalone",
        emitWat: false,
        externImportModule: "v8x:deno",
      },
    );
    const exports = await instantiate(result, {
      "v8x:deno": {
        __v8x_op_cwd_utf16_length: () => {
          calls++;
          return 3;
        },
        __v8x_op_cwd_utf16_code_unit: (index: number) => {
          calls++;
          return "abc".charCodeAt(index);
        },
      },
    });
    expect((exports.__v8x_probe_cwd_utf16_length as () => number)()).toBe(3);
    expect((exports.__v8x_probe_cwd_utf16_checksum as () => number)()).toBe(590);
    expect(calls).toBe(8);
  });

  it("resolves a v8-style absolute file URL to the canonical graph path", async () => {
    const result = await compileMulti(
      {
        "/tmp/v8x-deno.ts": `function cwd(): string { return "abc"; }
                              export const Deno = { cwd };`,
        "/tmp/v8x-main.ts": `import { Deno } from "file:///tmp/v8x-deno.ts";
                              export function probe(): number { return Deno.cwd().length; }`,
      },
      "/tmp/v8x-main.ts",
      { target: "standalone", emitWat: false },
    );
    const exports = await instantiate(result);
    expect((exports.probe as () => number)()).toBe(3);
  });

  it("uses the same file-URL resolution in the incremental project service", async () => {
    const compiler = createIncrementalCompiler({ target: "standalone", emitWat: false });
    try {
      const result = await compiler.compileMulti(
        {
          "/tmp/v8x fixture/dep.ts": `export const api = { answer: 42 };`,
          "/tmp/v8x fixture/main.ts": `import { api } from "file:///tmp/v8x%20fixture/dep.ts";
                                         export function probe(): number { return api.answer; }`,
        },
        "file:///tmp/v8x%20fixture/main.ts",
      );
      const exports = await instantiate(result);
      expect((exports.probe as () => number)()).toBe(42);
    } finally {
      compiler.dispose();
    }
  });
});
