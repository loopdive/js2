// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2800 — a top-level `new X(objLiteral)` / init-time call read of an
// object-literal argument's field returned null/undefined at MODULE-INIT in
// gc/host mode, while the identical read at RUNTIME worked.
//
// Root cause: gc/host runs `__module_init` via the Wasm `start` section, which
// executes INSIDE `WebAssembly.instantiate` — BEFORE the host wires the struct
// getters via `__setExports`. In a module that uses `delete` (so
// `ctx.moduleUsesDelete` is set), an `any`-receiver field read routes through
// the tombstone-aware host `__extern_get`, whose WasmGC struct-field fallback
// needs `getExports()?.__sget_<field>` — undefined at init → the read yields
// `undefined`. In compiled acorn this stored null for every TokenType's
// precedence field (built in the init-time `types$1` table), so every binary
// expression threw "Unexpected token".
//
// Fix: an `__in_module_init` flag global (1 only while `__module_init` runs)
// steers the delete-aware read to the HOST-FREE `__get_member_<name>` slot
// dispatcher during init (no exports needed; nothing has been deleted yet, so
// the tombstone is moot) and back to the tombstone-aware host `__extern_get` at
// runtime. The delete-tombstone (#2179) read must still return `undefined`.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runHost(source: string): Promise<Record<string, (...a: unknown[]) => unknown>> {
  const result = await compile(source, { skipSemanticDiagnostics: true });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const built = buildImports(result.imports, undefined, result.stringPool) as unknown as {
    // (#7014) setInstance: raw setExports(instance.exports) lost data-struct authority in 708ebbd56d (#5337).
    setInstance?: (e: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, built as unknown as WebAssembly.Imports);
  // Mirror the production wiring: exports are wired AFTER instantiate (the start
  // section / module-init has already run by this point).
  built.setInstance?.(instance);
  return instance.exports as unknown as Record<string, (...a: unknown[]) => unknown>;
}

describe("#2800 top-level new objliteral arg read at module-init", () => {
  it("init-time `any`-receiver field read of an object-literal arg returns the value (delete-using module)", async () => {
    // `delete` forces ctx.moduleUsesDelete → conf.prec routes through the
    // delete-aware dynamic read. The read happens at module-init (top-level
    // const), where the host struct getters are not yet wired. Pre-fix this
    // read `undefined` → `plusPrec === 0`.
    const e = await runHost(`
      function readField(conf: any): number { return conf.prec || 0; }
      function useDelete(o: any): void { delete o.x; }
      const plusPrec = readField({ prec: 9 });
      export function getPlusPrec(): number { return plusPrec; }
      export function du(o: any): void { useDelete(o); }
    `);
    expect(e.getPlusPrec()).toBe(9);
  });

  it("preserves the delete-tombstone read (#2179): delete o.a; o.a === undefined", async () => {
    const e = await runHost(`
      export function test(): boolean {
        const o: any = { a: 5 };
        delete o.a;
        return o.a === undefined;
      }
    `);
    expect(e.test()).toBe(1); // boolean true marshals to 1 across the host boundary
  });
});
