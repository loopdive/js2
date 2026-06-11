// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { emitBinary } from "../src/emit/binary.js";
import { emitWat } from "../src/emit/wat.js";
import type { FuncRef, WasmModule } from "../src/ir/types.js";
import { createEmptyModule } from "../src/ir/types.js";
import { buildFuncIndexLayout, resolveFuncRefsInModule } from "../src/ir/resolve-func-refs.js";

/** Build a minimal valid module: one import, one defined fn calling it symbolically. */
function refModule(refName: string): WasmModule {
  const mod = createEmptyModule();
  // type 0: () -> f64
  mod.types.push({ kind: "func", params: [], results: [{ kind: "f64" }] });
  mod.imports.push({ module: "env", name: "host_val", desc: { kind: "func", typeIdx: 0 } });
  const ref: FuncRef = { kind: "funcref", name: refName };
  mod.functions.push({
    name: "test",
    typeIdx: 0,
    locals: [],
    body: [{ op: "call", funcIdx: ref }],
    exported: true,
  });
  mod.exports.push({ name: "test", desc: { kind: "func", index: 1 } });
  return mod;
}

describe("#1916 resolveFuncRefsInModule (unit)", () => {
  it("resolves a symbolic call to the import's concrete index", () => {
    const mod = refModule("host_val");
    resolveFuncRefsInModule(mod);
    expect(mod.functions[0]!.body[0]).toEqual({ op: "call", funcIdx: 0 });
  });

  it("is idempotent", () => {
    const mod = refModule("host_val");
    resolveFuncRefsInModule(mod);
    resolveFuncRefsInModule(mod);
    expect(mod.functions[0]!.body[0]).toEqual({ op: "call", funcIdx: 0 });
  });

  it("throws a named error on an unresolved name", () => {
    const mod = refModule("no_such_function");
    expect(() => resolveFuncRefsInModule(mod)).toThrow(/unresolved function reference 'no_such_function'/);
  });

  it("buildFuncIndexLayout throws on duplicate names", () => {
    const mod = refModule("host_val");
    // A defined function with the same name as the import is ambiguous.
    mod.functions.push({ name: "host_val", typeIdx: 0, locals: [], body: [], exported: false });
    expect(() => buildFuncIndexLayout(mod)).toThrow(/duplicate function name 'host_val'/);
  });

  it("emitBinary on a ref-bearing module validates", () => {
    const mod = refModule("host_val");
    const binary = emitBinary(mod);
    expect(WebAssembly.validate(binary)).toBe(true);
  });

  it("emitWat resolves refs before formatting", () => {
    const mod = refModule("host_val");
    const wat = emitWat(mod);
    expect(wat).toContain("call 0");
  });
});

describe("#1916 symbolic refs survive late-import index shifts (integration)", () => {
  // The acceptance-criterion scenario: a late import (__get_undefined via
  // emitUndefined — the first migrated producer) is registered AFTER several
  // function bodies already exist. Every numeric funcIdx in those bodies is
  // rewritten by shiftLateImportIndices; the symbolic `call __get_undefined`
  // needs no rewriting and must resolve correctly at emit.
  it("late __get_undefined after N compiled bodies: module validates and runs", async () => {
    const r = await compile(`
      function a(x: number): number { return x + 1; }
      function b(x: number): number { return a(x) * 2; }
      function c(x: number): number { return b(x) + a(x); }
      export function probe(flag: number): any {
        // The undefined arm forces ensureLateImport("__get_undefined") after
        // a/b/c (and their call instructions) are fully compiled.
        if (flag > 0) {
          return c(flag);
        }
        return undefined;
      }
    `);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, r.importObject!);
    const probe = instance.exports.probe as (flag: number) => unknown;
    expect(probe(3)).toBe(12); // a(3)=4, b(3)=8, c(3)=8+4
    expect(probe(0)).toBeUndefined();
  });
});
