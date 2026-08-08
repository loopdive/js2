// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4194 — standalone instance expando substrate: permanent repro (#2093 gate).
//
// In `--target standalone`, an object produced by `new C(...)` (class or
// function constructor) used to support NO reflective own-property surface:
// dynamic writes were silently dropped (`__extern_set` had no closed-struct
// arm), and for-in / `in` / Object.keys saw nothing. Compiled acorn's
// `copyNode` (`for (var prop in node) newNode[prop] = node[prop]`) therefore
// produced blank nodes and the parser spuriously raised on destructuring
// shorthand — the `SyntaxError: Binding rvalue` family blocking the 24
// `test262/test/annexB/language/eval-code/**/*-skip-early-err-try.js` files.
//
// These assertions are the micro-probe table from the issue's implementation
// plan (§e1), frozen as vitest: bitmask 1 = declared `type`, 10 = expando
// `name`, 100 = declared `start`. Every surface must read 111 (and keysLen 3)
// on both receiver kinds, for literal AND computed writes, including the
// copyNode-shaped generic copy loop.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

const SURFACES = `
function get(): any { return make(); }
export function forinMask(): number {
  const n: any = get();
  n.name = "f";
  let m = 0;
  for (const p in n) { if (p === "type") m = m + 1; if (p === "name") m = m + 10; if (p === "start") m = m + 100; }
  return m;
}
export function keysLen(): number {
  const n: any = get();
  n.name = "f";
  return Object.keys(n).length;
}
export function inMask(): number {
  const n: any = get();
  n.name = "f";
  let m = 0;
  if ("type" in n) m = m + 1;
  if ("name" in n) m = m + 10;
  return m;
}
export function readsBack(): number {
  const n: any = get();
  n.name = "f";
  let m = 0;
  if (n.type === "T") m = m + 1;
  if (n.name === "f") m = m + 10;
  if (n.start === 5) m = m + 100;
  return m;
}
export function computedWrites(): number {
  const n: any = get();
  const keys: any = ["type", "name", "start"];
  const vals: any = ["T2", "f", 7];
  for (let i = 0; i < 3; i = i + 1) { n[keys[i]] = vals[i]; }
  let m = 0;
  if (n.type === "T2") m = m + 1;
  if (n.name === "f") m = m + 10;
  if (n.start === 7) m = m + 100;
  return m;
}
export function copyLoop(): number {
  const a: any = get();
  a.name = "f";
  const b: any = get();
  for (const p in a) { b[p] = a[p]; }
  let m = 0;
  if (b.type === "T") m = m + 1;
  if (b.name === "f") m = m + 10;
  if (b.start === 5) m = m + 100;
  return m;
}
`;

const RECEIVERS: Record<string, string> = {
  "class instance": `class C { type: string; start: number; constructor() { this.type = "T"; this.start = 5; } }
function make(): any { return new C(); }`,
  "function-constructor instance": `function N(this: any) { this.type = "T"; this.start = 5; }
function make(): any { return new (N as any)(); }`,
};

interface Exports {
  forinMask(): number;
  keysLen(): number;
  inMask(): number;
  readsBack(): number;
  computedWrites(): number;
  copyLoop(): number;
}

async function instantiate(receiver: string): Promise<Exports> {
  const r = await compile(receiver + SURFACES, {
    fileName: "issue-4194.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as unknown as Exports;
}

for (const [kind, receiver] of Object.entries(RECEIVERS)) {
  describe(`#4194 instance expando substrate — ${kind} (standalone)`, () => {
    it("retains a dynamic write and reads back declared + expando fields (111)", async () => {
      const x = await instantiate(receiver);
      expect(x.readsBack()).toBe(111);
    });
    it("for-in enumerates declared fields AND the expando (111)", async () => {
      const x = await instantiate(receiver);
      expect(x.forinMask()).toBe(111);
    });
    it("`in` answers true for declared and expando keys (11)", async () => {
      const x = await instantiate(receiver);
      expect(x.inMask()).toBe(11);
    });
    it("Object.keys sees all three own keys", async () => {
      const x = await instantiate(receiver);
      expect(x.keysLen()).toBe(3);
    });
    it("computed-key writes land on declared fields and expandos alike (111)", async () => {
      const x = await instantiate(receiver);
      expect(x.computedWrites()).toBe(111);
    });
    it("the acorn copyNode shape — generic for-in copy loop — round-trips (111)", async () => {
      const x = await instantiate(receiver);
      expect(x.copyLoop()).toBe(111);
    });
  });
}
