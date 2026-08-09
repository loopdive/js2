// Capability probe: what shapes does the linear-memory backend accept today?
// Compares `target: "linear"` vs `target: "standalone"` (WasmGC) on the same source.
// Run: npx tsx .tmp/linear-capability-probe.mjs
import { compile } from "../src/index.ts";

// NOTE: no `type i32 = number` alias here — see the i32-alias case below; the
// linear backend mis-lowers it and emits *invalid* wasm.
const CASES = [
  [
    "scalar-loop",
    `export function bench(n: number): number { let a = 0; for (let i = 0; i < n; i++) { a = (a * 31 + i) | 0; } return a; }`,
    [1000],
  ],
  [
    "i32-alias-scalar-loop",
    `type i32 = number;
export function bench(n: i32): i32 { let a: i32 = 0; for (let i: i32 = 0; i < n; i++) { a = (a * 31 + i) | 0; } return a; }`,
    [1000],
  ],
  [
    "class-typed-fields",
    `class P { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } sum(): number { return this.x + this.y; } }
export function bench(n: number): number { let a = 0; for (let i = 0; i < n; i++) { const p = new P(i, i + 1); a = a + p.sum(); } return a; }`,
    [100],
  ],
  [
    "recursion",
    `function fib(n: number): number { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }
export function bench(n: number): number { return fib(n); }`,
    [20],
  ],
  [
    "string-length-const",
    `const S = "hello world";
export function bench(n: number): number { let a = 0; for (let i = 0; i < n; i++) { a = a + S.length; } return a; }`,
    [10],
  ],
  [
    "string-charCodeAt-const",
    `const S = "hello world";
export function bench(n: number): number { let a = 0; for (let i = 0; i < n; i++) { a = a + S.charCodeAt(i % 11); } return a; }`,
    [11],
  ],
  [
    "string-charCodeAt-local",
    `export function bench(n: number): number { const s = "hello world"; let a = 0; for (let i = 0; i < n; i++) { a = a + s.charCodeAt(i % 11); } return a; }`,
    [11],
  ],
  [
    "string-field-charCodeAt",
    `class L { src: string; pos: number; constructor(s: string) { this.src = s; this.pos = 0; } cur(): number { return this.src.charCodeAt(this.pos); } }
export function bench(n: number): number { const l = new L("hello world"); let a = 0; for (let i = 0; i < n; i++) { l.pos = i % 11; a = a + l.cur(); } return a; }`,
    [11],
  ],
  [
    "string-param-scan",
    `function count(s: string): number { let a = 0; for (let i = 0; i < s.length; i++) { a = a + s.charCodeAt(i); } return a; }
export function bench(n: number): number { let a = 0; for (let i = 0; i < n; i++) { a = count("hello world"); } return a; }`,
    [3],
  ],
  [
    "array-push-objects",
    `class N { k: number; v: number; constructor(k: number, v: number) { this.k = k; this.v = v; } }
export function bench(n: number): number { const xs: N[] = []; for (let i = 0; i < n; i++) { xs.push(new N(i, i * 2)); } let a = 0; for (let j = 0; j < xs.length; j++) { a = a + xs[j].v; } return a; }`,
    [10],
  ],
  [
    "u8array-index",
    `export function bench(n: number): number { const b = new Uint8Array(64); for (let i = 0; i < 64; i++) { b[i] = (i * 7) & 255; } let a = 0; for (let j = 0; j < n; j++) { a = a + b[j & 63]; } return a; }`,
    [64],
  ],
  [
    "nullable-class-ref-list",
    `class N { v: number; next: N | null; constructor(v: number) { this.v = v; this.next = null; } }
export function bench(n: number): number { let head: N | null = null; for (let i = 0; i < n; i++) { const x = new N(i); x.next = head; head = x; } let a = 0; let c = head; while (c !== null) { a = a + c.v; c = c.next; } return a; }`,
    [10],
  ],
  [
    "class-method-on-field-object",
    `class Inner { v: number; constructor(v: number) { this.v = v; } get2(): number { return this.v * 2; } }
class Outer { inner: Inner; constructor(v: number) { this.inner = new Inner(v); } total(): number { return this.inner.get2(); } }
export function bench(n: number): number { let a = 0; for (let i = 0; i < n; i++) { const o = new Outer(i); a = a + o.total(); } return a; }`,
    [10],
  ],
];

const targets = ["standalone", "linear"];
async function run(src, target, args) {
  try {
    const t0 = performance.now();
    const r = await compile(src, { fileName: "p.ts", skipSemanticDiagnostics: true, target });
    const ct = performance.now() - t0;
    if (!r.binary?.length) {
      const e = (r.errors ?? [])[0];
      return `COMPILE-FAIL: ${(e?.messageText ?? e?.message ?? JSON.stringify(e) ?? "?").toString().slice(0, 60)}`;
    }
    let inst;
    try {
      inst = await WebAssembly.instantiate(await WebAssembly.compile(r.binary), {});
    } catch (e) {
      return `INVALID-WASM: ${String(e.message ?? e).slice(0, 60)}`;
    }
    try {
      const v = inst.exports.bench(...args);
      return `ok v=${v} ${r.binary.length}B ${ct.toFixed(0)}ms`;
    } catch (e) {
      return `TRAP: ${String(e.message ?? e).slice(0, 50)}`;
    }
  } catch (e) {
    return `THROW: ${String(e.message ?? e).slice(0, 60)}`;
  }
}

for (const [name, src, args] of CASES) {
  const out = [];
  for (const target of targets) out.push(`${target.padEnd(10)} ${(await run(src, target, args)).padEnd(46)}`);
  console.log(name.padEnd(28) + " | " + out.join(" | "));
}
