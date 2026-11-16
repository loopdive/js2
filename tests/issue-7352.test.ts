// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7352 O1 — on standalone a script `var` initialised with a data-only object
// literal is the open `$Object` for legacy and the IR alike
// (`open-object-literal-home.ts`); the IR builds it with the `{}` carrier, and
// the selector judges every value read off it as the carrier
// (`open-object-field-reads.ts`). The JS environment keeps main's routing.
import { afterAll, describe, expect, it, vi } from "vitest";

import { compile, type CompileResult } from "../src/index.js";

const previousEnv = vi.hoisted(() => {
  const names = ["JS2WASM_IR_SHAPE_DIAG", "JS2WASM_IR_MODULE_INIT_ALL_REJECTS"] as const;
  const previous = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) process.env[name] = "1";
  return previous;
});
afterAll(() => {
  for (const [name, value] of previousEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
});

type Verdict = "ok" | "threw" | "trap";

async function build(source: string, target: "standalone" | "gc", experimentalIR = true): Promise<CompileResult> {
  const result = await compile(source, {
    fileName: "issue-7352.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    scriptGoal: true,
    deferTopLevelInit: true,
    trackIrOutcomes: true,
    experimentalIR,
    ...(target === "standalone" ? { target: "standalone" } : {}),
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

async function run(result: CompileResult): Promise<Verdict> {
  try {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    (instance.exports.__module_init as () => void)();
    return "ok";
  } catch (error) {
    return error instanceof WebAssembly.RuntimeError ? "trap" : "threw";
  }
}

const outcome = (result: CompileResult, name: string) =>
  (result.irOutcomes ?? []).find((row) => row.displayName === name);

/** Every unit is IR, and the script passes exactly when the object behaves as JS says. */
const CLAIMED: Record<string, string> = {
  "an own property": `var o = { a: 1, b: "x" }; if (!o.hasOwnProperty("b")) { throw "h"; }`,
  "a read compared": `var o = { a: 3 }; if (o.a !== 3) { throw "r"; }`,
  "a read in arithmetic": `var o = { a: 3 }; if (o.a * 2 !== 6) { throw "m"; }`,
  "a read concatenated": `var o = { a: 3 }; if (o.a + 1 !== 4) { throw "p"; }`,
  "typeof a read": `var o = { a: 3 }; if (typeof o.a !== "number") { throw "t"; }`,
  "a string-keyed property": `var o = { "a b": 1 }; if (o["a b"] !== 1) { throw "k"; }`,
  "an expando after the literal": `var o = { a: 1 }; o.b = 2; if (o.a + o.b !== 3) { throw "e"; }`,
  "a property written": `var o = { a: 1 }; o.a = 5; if (o.a !== 5) { throw "w"; }`,
};

/** Refused at select (never withdrawn), and legacy answers as JS does. */
const REFUSED: Record<string, { readonly source: string; readonly unit: string; readonly detail: string }> = {
  // A value read off the open object is the carrier, not the checker's primitive.
  "a read as a string search argument": {
    source: `var o = { a: "x" }; if ("axa".indexOf(o.a) !== 1) { throw "i"; }`,
    unit: "<module-init>",
    detail: "expr-string-method-argument",
  },
  "a read as a string index": {
    source: `var o = { a: 1 }; if ("axa".charAt(o.a) !== "x") { throw "c"; }`,
    unit: "<module-init>",
    detail: "expr-string-method-argument",
  },
  "a read as a Math argument": {
    source: `var o = { a: 3 }; if (Math.max(o.a, 1) !== 3) { throw "m"; }`,
    unit: "<module-init>",
    detail: "body-if-cond",
  },
  "a read stored in a number var": {
    source: `var o = { a: 1 }; var r = o.a; if (r !== 1) { throw "r"; }`,
    unit: "<module-init>",
    detail: "vardecl-module-value-flow",
  },
  "a read assigned to a number var": {
    source: `var o = { a: 1 }; var r = 0; r = o.a; if (r !== 1) { throw "r"; }`,
    unit: "<module-init>",
    detail: "body-module-assign-incompatible",
  },
  "an array method called on it, stored": {
    source: `var o = { length: 0 }; var r = Array.prototype.indexOf.call(o, 7); if (r !== -1) { throw "r"; }`,
    unit: "<module-init>",
    detail: "vardecl-module-value-flow",
  },
  "a read returned from a typed function": {
    source: `var o = { a: 1 }; function f() { return o.a; } if (f() !== 1) { throw "f"; }`,
    unit: "f",
    detail: "return-open-object-value",
  },
};

describe("#7352 O1 — a script var's data-only object literal is an open object on standalone", () => {
  for (const [name, source] of Object.entries(CLAIMED)) {
    it(`claims every unit and runs as JS: ${name}`, async () => {
      const ir = await build(source, "standalone");
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      for (const row of ir.irOutcomes ?? []) {
        if (row.kind !== "non-executable") expect(row.irBodyEmitted, JSON.stringify(row)).toBe(true);
      }
      expect(await run(ir)).toBe("ok");
    });
  }

  for (const [name, { source, unit, detail }] of Object.entries(REFUSED)) {
    it(`refuses at select and runs as JS: ${name}`, async () => {
      const ir = await build(source, "standalone");
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      const row = outcome(ir, unit);
      expect(row).toMatchObject({ stage: "select", irBodyEmitted: false });
      expect(row?.detail).toContain(detail);
      expect(await run(ir)).toBe("ok");
    });
  }

  it("enumerates Object.values of the open object through the array methods (legacy)", async () => {
    const source = `var o = { a: 1, b: 2 }; var r = Object.values(o).reverse(); if (r[0] !== 2) { throw "v"; }`;
    expect(await run(await build(source, "standalone"))).toBe("ok");
  });

  it("keeps a literal that names toString / valueOf closed: conversions are O4's", async () => {
    const source = `var o = { a: 1, toString: "no" }; var t = false; try { String(o); } catch (e) { t = true; } t;`;
    expect(outcome(await build(source, "standalone"), "<module-init>")).toMatchObject({ irBodyEmitted: false });
  });

  it("keeps the JS environment's routing: the literal is not an IR value there", async () => {
    const ir = await build(CLAIMED["a read compared"]!, "gc");
    expect(outcome(ir, "<module-init>")).toMatchObject({ stage: "select", irBodyEmitted: false });
  });
});
