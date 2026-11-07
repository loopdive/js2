// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7291 — an IR-claimed `let s = ""; for (…) s += e` builder keeps `s` as
// buffer locals (legacy's #1210/#1580 shape) instead of one owned concat per
// append. Each case runs on standalone and gc against the JS evaluation of
// the same source; `builder` cases also pin the IR route and its locals.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./equivalence/helpers.js";

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "gc", options: {} },
];

/** Folds `inner()`'s string into one number so every lane compares one value. */
const HASHED_TEST = `
export function test(): number { const s = inner(); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003; return h + s.length * 1000003; }`;

interface Case {
  readonly source: string;
  /** The function that must lower its builder to buffer locals. */
  readonly builder?: string;
}

const CASES: Record<string, Case> = {
  "the #1580 string-hash shape": {
    source: `
function build(n: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz012345";
  let text = "";
  for (let i = 0; i < n; i++) { const a = (i * 13) & 31; const b = (a + 7) & 31; text += alphabet.charAt(a); text += alphabet.charAt(b); text += ";"; }
  return text;
}
function inner(): string { return build(50); }`,
    builder: "build",
  },
  "charAt out of range and at NaN appends nothing / the first unit": {
    source: `
function build(n: number): string {
  const a = "xyz";
  let s = "";
  for (let i = 0; i < n; i++) { s += a.charAt(i * 2 - 3); s += a.charAt(NaN); }
  return s;
}
function inner(): string { return build(6); }`,
    builder: "build",
  },
  "a fractional and a negative bound size the presized buffer by ceil": {
    source: `
function build(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) { s += "ab"; s += "c"; }
  return s;
}
function inner(): string { return build(2.5) + "|" + build(0.5) + "|" + build(-3) + "|" + build(0); }`,
    builder: "build",
  },
  "an exported builder also called in the file takes the IR builder (#7143 review)": {
    source: `
export function run(n: number): number {
  const alphabet = "abcdefghijklmnopqrstuvwxyz012345";
  let text = "";
  for (let i = 0; i < n; i++) { const a = (i * 13) & 31; const b = (a + 7) & 31; text += alphabet.charAt(a); text += alphabet.charAt(b); text += ";"; }
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return hash | 0;
}
function inner(): string { return "" + run(10) + "|" + run(1000); }`,
    builder: "run",
  },
  "a surrogate pair split by charAt keeps both units": {
    source: `
function build(n: number): string {
  const a = "a\\uD83D\\uDE00b";
  let s = "";
  for (let i = 0; i < n; i++) s += a.charAt(i % 4);
  return s;
}
function inner(): string { return build(9) + "|" + build(9).length; }`,
    builder: "build",
  },
  "multi-unit and computed string appends across growth": {
    source: `
function build(n: number): string {
  const a = "p\u00e9r";
  let s = "";
  for (let i = 0; i < n; i++) { s += "-"; s += "ok"; s += a; s += a.charAt(i % 3); }
  return s;
}
function inner(): string { return build(40); }`,
    builder: "build",
  },
  "break and continue": {
    source: `
function build(n: number): string {
  const a = "0123456789";
  let s = "";
  for (let i = 0; i < n; i++) { if (i % 3 === 0) continue; if (i > 20) break; s += "x"; s += a.charAt(i % 10); }
  return s;
}
function inner(): string { return build(100); }`,
    builder: "build",
  },
  "a number append (the IR refuses it; legacy keeps the value)": {
    source: `
function build(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) { s += i; s += i * 0.5; }
  return s;
}
function inner(): string { return build(40); }`,
  },
  "an append that throws leaves the builder consistent": {
    source: `
function piece(i: number): string { if (i % 4 === 2) throw new Error("p" + i); return "q" + i; }
function build(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) { try { s += piece(i); } catch (e) { s += "!"; } }
  return s;
}
function inner(): string { return build(12); }`,
  },
  "a builder read by a closure is not scalarised": {
    source: `
function build(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += "c";
  const read = () => s + "/" + s.length;
  return read();
}
function inner(): string { return build(7); }`,
  },
  "a generator body keeps its slot": {
    source: `
function* gen(n: number): Generator<string> {
  let s = "";
  for (let i = 0; i < n; i++) s += "g";
  yield s;
}
function inner(): string { return gen(5).next().value; }`,
  },
};

async function compileCase(source: string, options: CompileOptions) {
  const result = await compile(source, { fileName: "issue-7291.ts", trackIrOutcomes: true, ...options });
  const hard = result.errors.filter((e) => e.severity !== "warning");
  expect(result.success, hard.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  return result;
}

function functionWat(wat: string, name: string): string {
  const start = wat.indexOf(`(func $${name} `);
  expect(start, `func $${name} in WAT`).toBeGreaterThanOrEqual(0);
  const next = wat.indexOf("(func $", start + 1);
  return wat.slice(start, next < 0 ? undefined : next);
}

describe("#7291 IR string builder as buffer locals", () => {
  for (const [title, c] of Object.entries(CASES)) {
    for (const lane of LANES) {
      it(`${title} [${lane.name}]`, async () => {
        const source = c.source + HASHED_TEST;
        const result = await compileCase(source, lane.options);
        if (c.builder) {
          expect(result.irOutcomes?.find((o) => o.displayName === c.builder)?.kind).toBe("emitted");
          const body = functionWat(result.wat, c.builder);
          expect(body).toMatch(/\$slot_\w+\$buf/);
          expect(body).not.toMatch(/call \$__str_concat_owned/);
        }
        const instance =
          lane.options.target === "standalone"
            ? (await WebAssembly.instantiate(result.binary, {})).instance
            : await instantiateWithRuntime(result);
        const exports = instance.exports as Record<string, () => unknown>;
        exports.__module_init?.();
        expect(exports.test!()).toBe(evaluateAsJs(source).test!());
      });
    }
  }
});
