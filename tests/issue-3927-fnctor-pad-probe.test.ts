// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3927 — `JS2WASM_FNCTOR_PAD_SLOTS` GC-sensitivity probe.
//
// The probe appends N never-referenced `externref` slots to every derived
// fnctor struct so a paired A/B can measure d(wall-clock)/d(slot) on the
// standalone acorn lane — the coefficient that bounds every union-shrinking
// slice of #3927 before its dispatcher-surface risk is paid.
//
// What must hold, and what these tests pin:
//   1. Flag OFF (default) → byte-identical output. The probe must be
//      unobservable in every normal build.
//   2. Flag ON → the binary CHANGES (the pad is real, survives the pipeline)
//      while every behavioral result stays identical: reads/writes of real
//      fields, presence semantics (`in`, undefined reads), `for…in` /
//      `Object.keys` enumeration (`__pad*` is hidden by
//      `exposedClosedStructFieldName`), and instanceof.
//
// Env-var handling mirrors the other layout controls in this family
// (`JS2WASM_PACKED_PRESENCE_BITS`, `JS2WASM_STRING_FIELDS`): set before
// compile, restored after — vitest forks isolate the process, so no bleed.

import { afterEach, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const FLAG = "JS2WASM_FNCTOR_PAD_SLOTS";
const saved = process.env[FLAG];
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

async function compileStandalone(src: string): Promise<Uint8Array> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "invalid wasm").toBe(true);
  return r.binary;
}

async function runStandalone(src: string): Promise<number> {
  const binary = await compileStandalone(src);
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports as { test: () => number }).test();
}

// A fnctor exercising the surfaces the pad could plausibly disturb: a
// guaranteed field, a presence-tracked (conditional) field, a flow-grown
// builder-method field, enumeration, and `in`.
const PROBE_SRC = `
  function P(n: number) {
    this.pos = n;
    if (n > 100) { this.rare = n * 2; }
  }
  P.prototype.get = function () { return this.pos; };
  P.prototype.tag = function (v: number) { this.label = v; return this; };
  export function test(): number {
    const p: any = new P(41);
    let acc = p.get() + 1;                       // 42 — guaranteed field via method
    acc += p.rare === undefined ? 100 : 0;       // 142 — unset presence-tracked field
    acc += "rare" in p ? 0 : 1000;               // 1142 — presence via \`in\`
    p.tag(7);
    acc += p.label;                              // 1149 — flow-grown field round-trip
    let keys = 0;
    for (const k in p) { keys++; }               // pos + label (no __pad*, no rare)
    acc += keys * 10;
    acc += (p instanceof P) ? 100000 : 0;
    return acc;
  }
`;

describe("#3927 — fnctor pad probe", () => {
  it("flag OFF is the default and emits no pad (byte-identical to unset)", async () => {
    delete process.env[FLAG];
    const base = await compileStandalone(PROBE_SRC);
    process.env[FLAG] = "0";
    const zero = await compileStandalone(PROBE_SRC);
    expect(Buffer.from(zero).equals(Buffer.from(base))).toBe(true);
  });

  it("flag ON changes the layout but not one observable behavior", async () => {
    delete process.env[FLAG];
    const baseResult = await runStandalone(PROBE_SRC);
    const baseBinary = await compileStandalone(PROBE_SRC);

    process.env[FLAG] = "8";
    const padResult = await runStandalone(PROBE_SRC);
    const padBinary = await compileStandalone(PROBE_SRC);

    expect(padResult).toBe(baseResult);
    // The pad is real: layout changed, so the binaries differ.
    expect(Buffer.from(padBinary).equals(Buffer.from(baseBinary))).toBe(false);
    expect(padBinary.length).toBeGreaterThan(baseBinary.length);
  });

  it("non-numeric / negative values are ignored", async () => {
    delete process.env[FLAG];
    const base = await compileStandalone(PROBE_SRC);
    process.env[FLAG] = "banana";
    const junk = await compileStandalone(PROBE_SRC);
    process.env[FLAG] = "-4";
    const neg = await compileStandalone(PROBE_SRC);
    expect(Buffer.from(junk).equals(Buffer.from(base))).toBe(true);
    expect(Buffer.from(neg).equals(Buffer.from(base))).toBe(true);
  });
});
