// Head-to-head: linear memory (`target: "linear"`) vs WasmGC (`target: "standalone"`)
// vs node, on identical source, on parser-shaped work.  (#3673)
//
// Discipline (see #3673 round 32 — node's own baseline moved 0.0343 -> 0.0569 ms
// between separate runs, so single-lane runs are untrustworthy):
//   * all three lanes live in ONE process
//   * lanes are interleaved and their order ROTATES each round
//   * deep warm, then min-of-batches per lane, and we report the full spread
//   * checksums asserted identical across lanes before any timing
//
// Workload sizing is constrained by the linear backend, not by taste:
//   * string literals must stay under ~960 bytes or the linear lane silently
//     corrupts them (see .tmp/linear-dataseg-overflow.mjs)
//   * tokenize and parse must live in SEPARATE modules — a module that both
//     scans a string and runs a recursive-descent parser demotes out of the
//     linear-IR overlay and then hits a hard `charCodeAt` CE
//     (see .tmp/linear-w3-diag.mjs)
//
// Run: npx tsx .tmp/linear-vs-gc-bench.mjs
import { performance } from "node:perf_hooks";
import { writeFileSync, mkdirSync } from "node:fs";
import { compile } from "../src/index.ts";

const OPT = Number(process.env.OPT ?? "0"); // 0 = no wasm-opt, 3 = -O3
const ROUNDS = Number(process.env.ROUNDS ?? "15");
const WARM = Number(process.env.WARM ?? "10");
const NEXPR = Number(process.env.NEXPR ?? "16"); // 16 -> 909 chars, under the 960-byte cliff

function makeInput(nExpr) {
  const p = [];
  for (let i = 0; i < nExpr; i++) p.push(`a${i} + b${i} * (c${i} - d${i} / 2) + fn${i}(x${i}, y${i} * 3, (z${i} + 1))`);
  return p.join(" + ");
}
const INPUT = makeInput(NEXPR);
const LIT = JSON.stringify(INPUT);

// ───────────────────── W1: scalar floor (no memory at all) ─────────────────
const W1_BODY = `
  let a = 0;
  for (let i = 0; i < n; i++) {
    let x = i;
    for (let k = 0; k < 200; k++) { x = (x * 1103515245 + 12345) | 0; x = x ^ (x >> 7); }
    a = (a + x) | 0;
  }
  return a;`;

// ───────────────────── W2: tokenizer (string scan, no alloc) ────────────────
const W2_BODY = `
  const s = ${LIT};
  let acc = 0;
  for (let rep = 0; rep < n; rep++) {
    let pos = 0;
    let count = 0;
    while (pos < s.length) {
      const c = s.charCodeAt(pos);
      if (c === 32) { pos = pos + 1; continue; }
      if (c >= 48 && c <= 57) {
        let v = 0;
        while (pos < s.length) { const d = s.charCodeAt(pos); if (d >= 48 && d <= 57) { v = v * 10 + (d - 48); pos = pos + 1; } else break; }
        count = count + 1 + v;
      } else if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95) {
        while (pos < s.length) { const d = s.charCodeAt(pos); if ((d >= 97 && d <= 122) || (d >= 65 && d <= 90) || (d >= 48 && d <= 57) || d === 95) pos = pos + 1; else break; }
        count = count + 2;
      } else { pos = pos + 1; count = count + c; }
    }
    acc = (acc + count + rep) | 0;
  }
  return acc;`;

// ───────────── W3: recursive-descent parse + heap AST (no strings) ──────────
// Tokens arrive as parallel number[] arrays so the module contains no string op
// at all — this is the pure allocation/pointer-chasing half of a parser, and it
// is the shape where "GC struct.new vs bump-arena malloc" is actually decided.
const TOKENS = (() => {
  const tk = [];
  const tv = [];
  let pos = 0;
  const s = INPUT;
  while (pos < s.length) {
    const c = s.charCodeAt(pos);
    if (c === 32) {
      pos++;
      continue;
    }
    if (c >= 48 && c <= 57) {
      let v = 0;
      while (pos < s.length && s.charCodeAt(pos) >= 48 && s.charCodeAt(pos) <= 57) {
        v = v * 10 + (s.charCodeAt(pos) - 48);
        pos++;
      }
      tk.push(1);
      tv.push(v);
    } else if (/[A-Za-z_]/.test(s[pos])) {
      let h = 0;
      while (pos < s.length && /[A-Za-z0-9_]/.test(s[pos])) {
        h = (h * 31 + s.charCodeAt(pos)) | 0;
        pos++;
      }
      tk.push(2);
      tv.push(h & 1023);
    } else {
      tk.push(c);
      tv.push(0);
      pos++;
    }
  }
  return { tk, tv };
})();

const W3_DECLS_TS = `class Node { kind: number; val: number; left: Node | null; right: Node | null;
  constructor(k: number, v: number, l: Node | null, r: Node | null) { this.kind = k; this.val = v; this.left = l; this.right = r; } }
class St { i: number; constructor() { this.i = 0; } }
function parsePrimary(tk: number[], tv: number[], st: St): Node {
  if (st.i < tk.length && tk[st.i] === 40) { st.i = st.i + 1; const inner = parseAdd(tk, tv, st); if (st.i < tk.length && tk[st.i] === 41) st.i = st.i + 1; return inner; }
  const node = new Node(tk[st.i], tv[st.i], null, null);
  st.i = st.i + 1;
  return node;
}
function parseMul(tk: number[], tv: number[], st: St): Node {
  let left = parsePrimary(tk, tv, st);
  while (st.i < tk.length && (tk[st.i] === 42 || tk[st.i] === 47)) { const op = tk[st.i]; st.i = st.i + 1; const right = parsePrimary(tk, tv, st); left = new Node(op, 0, left, right); }
  return left;
}
function parseAdd(tk: number[], tv: number[], st: St): Node {
  let left = parseMul(tk, tv, st);
  while (st.i < tk.length && (tk[st.i] === 43 || tk[st.i] === 45)) { const op = tk[st.i]; st.i = st.i + 1; const right = parseMul(tk, tv, st); left = new Node(op, 0, left, right); }
  return left;
}
function checksum(x: Node | null): number { if (x === null) return 0; return x.kind + x.val + checksum(x.left) + checksum(x.right); }`;

const W3_DECLS_JS = `class Node { constructor(k, v, l, r) { this.kind = k; this.val = v; this.left = l; this.right = r; } }
class St { constructor() { this.i = 0; } }
function parsePrimary(tk, tv, st) {
  if (st.i < tk.length && tk[st.i] === 40) { st.i = st.i + 1; const inner = parseAdd(tk, tv, st); if (st.i < tk.length && tk[st.i] === 41) st.i = st.i + 1; return inner; }
  const node = new Node(tk[st.i], tv[st.i], null, null);
  st.i = st.i + 1;
  return node;
}
function parseMul(tk, tv, st) {
  let left = parsePrimary(tk, tv, st);
  while (st.i < tk.length && (tk[st.i] === 42 || tk[st.i] === 47)) { const op = tk[st.i]; st.i = st.i + 1; const right = parsePrimary(tk, tv, st); left = new Node(op, 0, left, right); }
  return left;
}
function parseAdd(tk, tv, st) {
  let left = parseMul(tk, tv, st);
  while (st.i < tk.length && (tk[st.i] === 43 || tk[st.i] === 45)) { const op = tk[st.i]; st.i = st.i + 1; const right = parseMul(tk, tv, st); left = new Node(op, 0, left, right); }
  return left;
}
function checksum(x) { if (x === null) return 0; return x.kind + x.val + checksum(x.left) + checksum(x.right); }`;

const KLIT = JSON.stringify(TOKENS.tk);
const VLIT = JSON.stringify(TOKENS.tv);
// The token arrays are built ONCE, outside the rep loop: otherwise the two
// lanes are also being compared on array-literal construction (the linear lane
// emits 862 per-element push calls where the GC lane emits 3 `array.new`s),
// which would swamp the allocation signal we actually want.
const W3_BODY = `
  const tk = ${KLIT};
  const tv = ${VLIT};
  let acc = 0;
  for (let rep = 0; rep < n; rep++) {
    tv[0] = rep;
    const st = new St();
    acc = (acc + checksum(parseAdd(tk, tv, st))) | 0;
  }
  return acc;`;

const WORKLOADS = [
  { id: "W1-scalar", tsDecls: "", jsDecls: "", body: W1_BODY, reps: 200 },
  { id: "W2-tokenize", tsDecls: "", jsDecls: "", body: W2_BODY, reps: 30 },
  { id: "W3-parse+ast", tsDecls: W3_DECLS_TS, jsDecls: W3_DECLS_JS, body: W3_BODY, reps: 30 },
];

// ───────────────────────── compile all lanes ─────────────────────────
mkdirSync(".tmp/lvg", { recursive: true });
const lanes = [];
const compileMeta = [];

for (const w of WORKLOADS) {
  const ts = `${w.tsDecls}\nexport function bench(n: number): number {${w.body}\n}`;
  const js = `${w.jsDecls}\nfunction bench(n) {${w.body}\n}; return bench;`;
  const entry = { id: w.id, reps: w.reps, fns: { node: new Function(js)() } };
  for (const target of ["standalone", "linear"]) {
    const t0 = performance.now();
    const r = await compile(ts, {
      fileName: `${w.id}.ts`,
      skipSemanticDiagnostics: true,
      target,
      ...(OPT ? { optimize: OPT } : {}),
    });
    const compileMs = performance.now() - t0;
    const lane = target === "standalone" ? "gc" : "linear";
    if (!r.binary?.length) {
      console.log(`!! ${w.id}/${lane} COMPILE FAIL:`, (r.errors ?? []).slice(0, 2).map((e) => e.message ?? String(e)));
      continue;
    }
    writeFileSync(`.tmp/lvg/${w.id}.${lane}.wasm`, r.binary);
    entry.fns[lane] = (await WebAssembly.instantiate(await WebAssembly.compile(r.binary), {})).exports.bench;
    compileMeta.push({ workload: w.id, lane, bytes: r.binary.length, compileMs });
  }
  lanes.push(entry);
}

console.log(`\ninput: ${INPUT.length} chars, ${TOKENS.tk.length} tokens   OPT=${OPT}  ROUNDS=${ROUNDS}\n`);
console.log("── checksums (must be identical per workload) ──");
let bad = false;
for (const e of lanes) {
  const vals = Object.fromEntries(Object.entries(e.fns).map(([k, f]) => [k, f(3)]));
  const ok = new Set(Object.values(vals)).size === 1;
  if (!ok) bad = true;
  console.log(`${e.id.padEnd(14)} ${JSON.stringify(vals)}  ${ok ? "OK" : "*** MISMATCH ***"}`);
}
if (bad) console.log("\n!! checksum mismatch — timings below are NOT comparable");

console.log("\n── binary size & compile time ──");
for (const m of compileMeta) {
  console.log(`${m.workload.padEnd(14)} ${m.lane.padEnd(7)} ${String(m.bytes).padStart(7)} B   compile ${m.compileMs.toFixed(0)} ms`);
}

console.log("\n── timing (ms per iteration; interleaved, rotating lane order) ──");
for (const e of lanes) {
  const names = Object.keys(e.fns);
  const samples = Object.fromEntries(names.map((n) => [n, []]));
  for (const n of names) {
    e.fns[n](5);
    for (let i = 0; i < WARM; i++) e.fns[n](e.reps);
  }
  for (let r = 0; r < ROUNDS; r++) {
    for (const n of names.map((_, i) => names[(i + r) % names.length])) {
      const t = performance.now();
      const v = e.fns[n](e.reps);
      const dt = (performance.now() - t) / e.reps;
      if (v === undefined) throw new Error("no value");
      samples[n].push(dt);
    }
  }
  const stat = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return { min: s[0], med: s[(s.length / 2) | 0], max: s[s.length - 1] };
  };
  const st = Object.fromEntries(names.map((n) => [n, stat(samples[n])]));
  const base = st.node.min;
  console.log(`\n  ${e.id}  (reps/batch=${e.reps})`);
  for (const n of names) {
    const s = st[n];
    console.log(
      `    ${n.padEnd(7)} min ${s.min.toFixed(4)}  med ${s.med.toFixed(4)}  max ${s.max.toFixed(4)}` +
        `   spread ${(s.max / s.min).toFixed(2)}x   vs node ${(s.min / base).toFixed(2)}x`,
    );
  }
  if (st.gc && st.linear) {
    const r = st.linear.min / st.gc.min;
    console.log(`    => linear/gc = ${r.toFixed(2)}x  (${r < 1 ? "LINEAR faster" : "GC faster"})`);
  }
}
