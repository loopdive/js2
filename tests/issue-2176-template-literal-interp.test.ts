// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2176 — a top-level `const`/`let`/`var` whose name collides with an ambient
// lib.dom global (e.g. `name`, `length`, `status`, `origin`) used as a *value
// operand* (template interpolation, `+` concat, or a copy-init) produced
// `undefined`/`NaN`/`0` instead of the real value.
//
// Root cause: js2wasm analyzes a top-level program as a SCRIPT (no
// import/export ⇒ not a module). In script mode `const name = "world"` does
// NOT shadow the writable global `var name: string` from lib.dom.d.ts, so a
// bare reference to `name` binds to the ambient symbol (`void`). The codegen's
// stringification / declared-type logic read that ambient type and either
// dropped the value (template span hit the undefined/void branch and pushed the
// literal "undefined") or registered the copy as an i32 global (read back as
// 0). `console.log(name)` happened to work because the value flows straight to
// the host import without a type-driven coercion.
//
// Fix (`resolveIdentifierType` in src/codegen/index.ts, routed through the
// module-global declared-type computation and the string-op operand-type
// lookups): when a bare identifier binds purely to an ambient lib declaration
// but a same-name user binding shadows it, re-derive the type from the user
// binding. Genuine ambient reads (no user binding) are unchanged.
//
// The bug only manifests at MODULE TOP LEVEL (where the var becomes a wasm
// global and the script-mode ambient shadowing applies), so these tests
// compile top-level statements and capture `console.log` — exercising the same
// path the differential `string/13-template-literal.js` fixture hits.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

/** Compile top-level source and return the captured console.log lines. */
async function runTopLevel(source: string): Promise<string[]> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error("compile failed: " + (r.errors[0]?.message ?? "unknown"));
  }
  const lines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const fmt = (a: unknown) => (typeof a === "object" ? JSON.stringify(a) : String(a));
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => {
    lines.push(args.map(fmt).join(" "));
  };
  // eslint-disable-next-line no-console
  console.error = () => {};
  try {
    const built = buildImports(r.imports, {}, r.stringPool);
    const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
    built.setExports?.(instance.exports as Record<string, (...args: unknown[]) => unknown>);
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return lines;
}

describe("#2176 ambient-shadowed identifier interpolation", () => {
  it("the differential fixture: `${name}` interpolates the value, not 'undefined'", async () => {
    const out = await runTopLevel(
      ['const name = "world";', "const n = 42;", "console.log(`hello ${name}, n=${n}`);"].join("\n"),
    );
    expect(out).toEqual(["hello world, n=42"]);
  });

  it("`${name}` alone (no surrounding text)", async () => {
    const out = await runTopLevel(['const name = "world";', "console.log(`${name}`);"].join("\n"));
    expect(out).toEqual(["world"]);
  });

  it("`length` (collides with lib.dom number global) interpolates numerically", async () => {
    const out = await runTopLevel(["const length = 5;", "console.log(`len=${length}`);"].join("\n"));
    expect(out).toEqual(["len=5"]);
  });

  it("string `+` concat with an ambient-shadowed name", async () => {
    const out = await runTopLevel(['const name = "world";', 'console.log("hi " + name);'].join("\n"));
    expect(out).toEqual(["hi world"]);
  });

  it("ambient-shadowed name on the LEFT of `+`", async () => {
    const out = await runTopLevel(['const name = "world";', 'console.log(name + "!");'].join("\n"));
    expect(out).toEqual(["world!"]);
  });

  it("copy-init `const y = name` keeps the string type (was registered as i32 → 0)", async () => {
    const out = await runTopLevel(['const name = "world";', "const y = name;", "console.log(y);"].join("\n"));
    expect(out).toEqual(["world"]);
  });

  it("`let` ambient-shadowed name after reassignment", async () => {
    const out = await runTopLevel(['let name = "a";', 'name = "b";', "console.log(`x ${name}`);"].join("\n"));
    expect(out).toEqual(["x b"]);
  });

  it("another lib.dom global name (`status`) interpolates", async () => {
    const out = await runTopLevel(['const status = "ok";', "console.log(`s=${status}`);"].join("\n"));
    expect(out).toEqual(["s=ok"]);
  });

  // --- Neighbors that must remain unchanged (regression guards). ---

  it("a real `undefined` span still stringifies to 'undefined'", async () => {
    const out = await runTopLevel(["let u;", "console.log(`v=${u}`);"].join("\n"));
    expect(out).toEqual(["v=undefined"]);
  });

  it("a real `null` span still stringifies to 'null'", async () => {
    const out = await runTopLevel(["const z = null;", "console.log(`v=${z}`);"].join("\n"));
    expect(out).toEqual(["v=null"]);
  });

  it("a non-colliding identifier name is unaffected", async () => {
    const out = await runTopLevel(['const greeting = "world";', "console.log(`hi ${greeting}`);"].join("\n"));
    expect(out).toEqual(["hi world"]);
  });

  it("number / boolean spans still stringify correctly", async () => {
    const out = await runTopLevel(["const n = 7;", "const b = true;", "console.log(`n=${n} b=${b}`);"].join("\n"));
    expect(out).toEqual(["n=7 b=true"]);
  });

  it("a function-local name (never ambient-shadowed) is unaffected", async () => {
    const out = await runTopLevel(
      ['function f(){ const name = "z"; return `q ${name}`; }', "console.log(f());"].join("\n"),
    );
    expect(out).toEqual(["q z"]);
  });
});
