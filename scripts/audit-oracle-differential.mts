// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4218) Differential-oracle spike — the evidence the checker-retirement
 * plan was missing.
 *
 * `scripts/audit-ts5-checker-usage.mts` counts CHECKER CALLS. That is the
 * wrong instrument for the question "can the in-house backend replace the
 * checker?", because `InHouseOracle`'s contract is *never widen a guess into
 * a fact*: when it cannot answer it returns `unresolvable`, which every
 * consumer accepts as "use the dynamic representation". So the in-house
 * backend can reach ZERO checker calls while silently losing every type
 * specialization, and a call counter would show only success.
 *
 * This script measures the two things that actually gate retirement:
 *
 *  1. **Fact divergence** — runs the corpus under `oracleBackend:
 *     "differential"` (answers from the checker, records where the in-house
 *     backend disagrees) and reports the four-way structural verdict of
 *     #4408 — `weakened` (in-house declined: safe, lossy), `checkerWeaker`
 *     (in-house claims a fact TypeScript will not give: adjudicate, it is
 *     often correct — #4410) and `conflicting` (both claim a fact and the
 *     facts differ) — broken down per query so the output is a worklist.
 *
 *  2. **Emitted-code quality** — compiles each input under `checker` and
 *     `inhouse` and diffs the generated WAT for the signatures of lost
 *     typing: unboxed scalar locals (f64/i32) traded for `externref`, and
 *     added boxing/unboxing traffic. A backend that "agrees" on facts but
 *     emits boxed code has not replaced the checker in any useful sense.
 *
 * Usage:
 *   npx tsx scripts/audit-oracle-differential.mts [--json <out.json>] [--samples N]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");

const { compile } = await import("../src/index.js");
const { globalDivergenceLedger } = await import("../src/checker/oracle-backend.js");

interface Input {
  name: string;
  source: string;
  annotated: boolean;
}

/**
 * (#4218) Corpus selection. The first spike ran on 21 inputs, which cannot
 * support a claim about type loss; `--corpus` widens it to the real code the
 * compiler is measured on elsewhere:
 *
 *   playground  13 annotated TS examples + 8 hand-written snippets
 *   test262     stratified sample of the 53k-file conformance corpus. Raw
 *               files, no harness: we are comparing COMPILE OUTPUT between
 *               backends, so a test that cannot run (or cannot compile) is
 *               still a valid datapoint as long as both backends agree.
 *   npm         real-world package sources on disk (marked, lodash, react,
 *               prettier, eslint, hono) — the large, messy, unannotated end.
 *
 * Behavioral corpora (equivalence, unit tests, test262 conformance) are NOT
 * run here: those are answered by running their own suites under
 * `JS2WASM_ORACLE_BACKEND=inhouse`, which checks semantics rather than
 * emitted-code shape.
 */
function stratifiedTest262(limit: number): Input[] {
  const root = join(REPO_ROOT, "test262", "test");
  const out: Input[] = [];
  const areas = ["language", "built-ins", "annexB", "intl402"];
  const perArea = Math.max(1, Math.floor(limit / areas.length));
  for (const area of areas) {
    const areaRoot = join(root, area);
    let found: string[] = [];
    const walk = (dir: string) => {
      if (found.length >= perArea * 6) return; // gather a pool, then stride
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        const p2 = join(dir, e);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(p2);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(p2);
        else if (e.endsWith(".js") && !e.endsWith("_FIXTURE.js")) found.push(p2);
        if (found.length >= perArea * 6) return;
      }
    };
    walk(areaRoot);
    // Stride the pool so the sample spans the area instead of its first dir.
    const stride = Math.max(1, Math.floor(found.length / perArea));
    for (let i = 0; i < found.length && out.length < limit; i += stride) {
      const f = found[i];
      let src = "";
      try {
        src = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      // Skip the enormous outliers; they dominate wall-clock without adding signal.
      if (src.length > 40_000) continue;
      out.push({ name: relative(REPO_ROOT, f), source: src, annotated: false });
    }
  }
  return out;
}

function npmCorpus(limit: number): Input[] {
  const out: Input[] = [];
  const pkgs = ["marked", "lodash", "react", "prettier", "eslint", "hono"];
  for (const pkg of pkgs) {
    const base = join(REPO_ROOT, "node_modules", pkg);
    const files: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 3 || files.length >= 40) return;
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        if (files.length >= 40) return;
        if (e === "node_modules" || e.startsWith(".")) continue;
        const p2 = join(dir, e);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(p2);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(p2, depth + 1);
        else if ((e.endsWith(".js") || e.endsWith(".mjs") || e.endsWith(".cjs")) && st.size < 250_000) files.push(p2);
      }
    };
    walk(base, 0);
    const perPkg = Math.max(1, Math.floor(limit / pkgs.length));
    const stride = Math.max(1, Math.floor(files.length / perPkg));
    for (let i = 0; i < files.length && out.length < limit; i += stride) {
      try {
        out.push({ name: relative(REPO_ROOT, files[i]), source: readFileSync(files[i], "utf8"), annotated: false });
      } catch {
        /* unreadable */
      }
    }
  }
  return out;
}

/** Corpus: annotated TS (where the checker actually knows things — the only
 * place a weakened in-house answer can cost anything) plus plain JS. */
function collectCorpus(): Input[] {
  const corpus: Input[] = [];
  const root = join(REPO_ROOT, "website/playground/examples");
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) {
        corpus.push({ name: relative(REPO_ROOT, p), source: readFileSync(p, "utf8"), annotated: true });
      }
    }
  };
  walk(root);

  const plainJs: Record<string, string> = {
    "<js> fib": "function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); } console.log(fib(20));",
    "<js> arrays":
      "const xs = [3, 1, 4, 1, 5]; let t = 0; for (const x of xs) { t += x * 2; } console.log(t / xs.length);",
    "<js> class":
      "class P { constructor(x, y) { this.x = x; this.y = y; } d() { return Math.sqrt(this.x * this.x + this.y * this.y); } } console.log(new P(3, 4).d());",
  };
  for (const [name, source] of Object.entries(plainJs)) corpus.push({ name, source, annotated: false });

  // Annotated shapes the checker is *supposed* to pay off on: the in-house
  // backend must read these from the annotations alone.
  const annotatedTs: Record<string, string> = {
    "<ts> typed params":
      "export function area(w: number, h: number): number { return w * h; } export function go(): number { let acc = 0; for (let i = 0; i < 10; i++) acc += area(i, 2); return acc; }",
    "<ts> class fields":
      "class Vec { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } len(): number { return Math.sqrt(this.x * this.x + this.y * this.y); } } export function run(): number { return new Vec(3, 4).len(); }",
    "<ts> native i32":
      "type i32 = number; export function addI(a: i32, b: i32): i32 { return (a + b) | 0; } export function loop(): i32 { let s: i32 = 0; for (let i = 0; i < 100; i++) s = addI(s, i); return s; }",
    "<ts> arrays typed":
      "export function total(xs: number[]): number { let t = 0; for (let i = 0; i < xs.length; i++) t += xs[i]; return t; }",
    "<ts> bool + string":
      "export function pick(flag: boolean, s: string): string { return flag ? s.toUpperCase() : s; }",
  };
  for (const [name, source] of Object.entries(annotatedTs)) corpus.push({ name, source, annotated: true });
  return corpus;
}

// ── Emitted-code quality proxies ──────────────────────────────────────
//
// Read off the WAT text. These are proxies, not a full cost model, but they
// are the exact signatures of "the compiler stopped knowing the type":
// scalar locals demoted to externref, and boxing traffic added to compensate.
interface CodeShape {
  bytes: number;
  f64Locals: number;
  i32Locals: number;
  externrefLocals: number;
  boxCalls: number;
  unboxCalls: number;
  externConverts: number;
}

function shapeOfWat(wat: string, bytes: number): CodeShape {
  const count = (re: RegExp) => (wat.match(re) ?? []).length;
  return {
    bytes,
    // `(local $x f64)` and `(local f64)` forms, plus multi-type local decls.
    f64Locals: count(/\(local(?:\s+\$[^\s)]+)?\s+f64\)/g),
    i32Locals: count(/\(local(?:\s+\$[^\s)]+)?\s+i32\)/g),
    externrefLocals: count(/\(local(?:\s+\$[^\s)]+)?\s+externref\)/g),
    boxCalls: count(/call\s+\$?__box_[a-z]+/g),
    unboxCalls: count(/call\s+\$?__unbox_[a-z]+/g),
    externConverts: count(/(?:extern\.convert_any|any\.convert_extern)/g),
  };
}

async function compileShape(source: string, backend: "checker" | "inhouse"): Promise<CodeShape | string> {
  try {
    const r = (await compile(source, { oracleBackend: backend, emitWat: true })) as {
      success?: boolean;
      binary?: Uint8Array;
      wat?: string;
      errors?: { message: string }[];
    };
    if (!r.success || !r.binary) return `ERR:${r.errors?.[0]?.message?.slice(0, 90) ?? "unknown"}`;
    return shapeOfWat(r.wat ?? "", r.binary.byteLength);
  } catch (e) {
    return `THREW:${(e instanceof Error ? e.message : String(e)).slice(0, 90)}`;
  }
}

const args = process.argv.slice(2);
const sampleLimit = args.includes("--samples") ? Number(args[args.indexOf("--samples") + 1]) : 12;
const which = args.includes("--corpus") ? args[args.indexOf("--corpus") + 1] : "playground";
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : 400;
const corpus: Input[] = [];
if (which === "playground" || which === "all") corpus.push(...collectCorpus());
if (which === "test262" || which === "all") corpus.push(...stratifiedTest262(limit));
if (which === "npm" || which === "all") corpus.push(...npmCorpus(Math.min(limit, 120)));
console.log(`corpus: ${which} — ${corpus.length} inputs (${corpus.filter((c) => c.annotated).length} annotated)\n`);

// ── Phase 1: fact divergence ──────────────────────────────────────────
console.log("=".repeat(72));
console.log("PHASE 1 — fact divergence (differential backend: checker answers, inhouse recorded)");
console.log("=".repeat(72));

interface PerFile {
  file: string;
  annotated: boolean;
  agreements: number;
  weakened: number;
  checkerWeaker: number;
  conflicting: number;
}
const perFile: PerFile[] = [];
const totalsByQuery = new Map<
  string,
  { agreements: number; weakened: number; checkerWeaker: number; conflicting: number }
>();
const conflictSamples: { file: string; query: string; checker: string; inhouse: string; node: string }[] = [];

let phase1Done = 0;
for (const input of corpus) {
  if (++phase1Done % 200 === 0) console.log(`  ...divergence ${phase1Done}/${corpus.length}`);
  globalDivergenceLedger.reset();
  try {
    await compile(input.source, { oracleBackend: "differential" });
  } catch {
    /* a compile failure still leaves whatever was recorded */
  }
  const s = globalDivergenceLedger.summary();
  perFile.push({ file: input.name, annotated: input.annotated, ...s });
  for (const [q, v] of globalDivergenceLedger.byQuery) {
    const t = totalsByQuery.get(q) ?? { agreements: 0, weakened: 0, checkerWeaker: 0, conflicting: 0 };
    t.agreements += v.agreements;
    t.weakened += v.weakened;
    t.checkerWeaker += v.checkerWeaker;
    t.conflicting += v.conflicting;
    totalsByQuery.set(q, t);
  }
  // (#4408) Read the ledger's per-query-quota'd conflict list, NOT `samples`.
  // `samples` is one FIFO over every divergence and `weakened` outnumbers
  // `conflicting` ~54:1, so the shared cap fills with weakened entries before
  // a single conflict is recorded — the 2,137-input run surfaced 25 of 908,
  // none from `signatureOf`, the query with the highest conflict count.
  for (const d of globalDivergenceLedger.conflictSamples) {
    if (conflictSamples.length < sampleLimit) conflictSamples.push({ file: input.name, ...d });
  }
}

const grand = perFile.reduce(
  (a, f) => ({
    agreements: a.agreements + f.agreements,
    weakened: a.weakened + f.weakened,
    checkerWeaker: a.checkerWeaker + f.checkerWeaker,
    conflicting: a.conflicting + f.conflicting,
  }),
  { agreements: 0, weakened: 0, checkerWeaker: 0, conflicting: 0 },
);
const grandTotal = grand.agreements + grand.weakened + grand.checkerWeaker + grand.conflicting;
const pct = (n: number) => (grandTotal === 0 ? "0.0" : ((n / grandTotal) * 100).toFixed(1));
console.log(`\nqueries compared: ${grandTotal}`);
console.log(`  agree        ${String(grand.agreements).padStart(7)}  (${pct(grand.agreements)}%)`);
console.log(
  `  weakened     ${String(grand.weakened).padStart(7)}  (${pct(grand.weakened)}%)   inhouse declined — safe, lossy`,
);
console.log(
  `  ckr-weaker   ${String(grand.checkerWeaker).padStart(7)}  (${pct(grand.checkerWeaker)}%)   inhouse claims MORE than TS — adjudicate (#4410)`,
);
console.log(
  `  CONFLICTING  ${String(grand.conflicting).padStart(7)}  (${pct(grand.conflicting)}%)   both claim a fact and the facts differ`,
);
// A conflict is still not automatically an in-house bug. TypeScript is unsound
// for `with`, direct `eval` and annexB hoisting, and its `ts.Program` does not
// contain re-entrant eval'd sources — so the checker is evidence, not ground
// truth (#4410). Adjudicate each row against ECMAScript.

console.log("\n--- by query (the worklist) ---");
const qw = Math.max(...[...totalsByQuery.keys()].map((k) => k.length), 12);
console.log(
  `${"query".padEnd(qw)}  ${"agree".padStart(8)}  ${"weakened".padStart(8)}  ${"ckr-weak".padStart(8)}  ${"conflict".padStart(8)}`,
);
for (const [q, v] of [...totalsByQuery].sort(
  (a, b) => b[1].conflicting - a[1].conflicting || b[1].checkerWeaker - a[1].checkerWeaker,
)) {
  console.log(
    `${q.padEnd(qw)}  ${String(v.agreements).padStart(8)}  ${String(v.weakened).padStart(8)}  ${String(v.checkerWeaker).padStart(8)}  ${String(v.conflicting).padStart(8)}`,
  );
}

if (conflictSamples.length > 0) {
  console.log("\n--- samples needing a verdict (see #4408 / #4410) ---");
  for (const c of conflictSamples) {
    console.log(`  ${c.file}  ${c.query}  [${c.verdict}]`);
    console.log(`      checker=${c.checker}  inhouse=${c.inhouse}  node=${c.node}`);
  }
}

// ── Phase 2: emitted-code quality ─────────────────────────────────────
console.log(`\n${"=".repeat(72)}`);
console.log("PHASE 2 — emitted code: does the inhouse backend lose type specialization?");
console.log("=".repeat(72));

interface Row {
  file: string;
  annotated: boolean;
  checker: CodeShape | string;
  inhouse: CodeShape | string;
}
const rows: Row[] = [];
let phase2Done = 0;
for (const input of corpus) {
  if (++phase2Done % 200 === 0) console.log(`  ...codeshape ${phase2Done}/${corpus.length}`);
  rows.push({
    file: input.name,
    annotated: input.annotated,
    checker: await compileShape(input.source, "checker"),
    inhouse: await compileShape(input.source, "inhouse"),
  });
}

const num = (v: CodeShape | string, k: keyof CodeShape) => (typeof v === "string" ? 0 : v[k]);
const ok = (r: Row) => typeof r.checker !== "string" && typeof r.inhouse !== "string";
const usable = rows.filter(ok);

const fields: (keyof CodeShape)[] = [
  "bytes",
  "f64Locals",
  "i32Locals",
  "externrefLocals",
  "boxCalls",
  "unboxCalls",
  "externConverts",
];
console.log(`\n--- totals over ${usable.length} compilable inputs ---`);
console.log(`${"metric".padEnd(17)}  ${"checker".padStart(10)}  ${"inhouse".padStart(10)}  ${"delta".padStart(10)}`);
for (const f of fields) {
  const c = usable.reduce((a, r) => a + num(r.checker, f), 0);
  const i = usable.reduce((a, r) => a + num(r.inhouse, f), 0);
  const d = i - c;
  const flag =
    d === 0
      ? ""
      : f === "bytes" ||
          f.startsWith("box") ||
          f.startsWith("unbox") ||
          f === "externrefLocals" ||
          f === "externConverts"
        ? d > 0
          ? "  ← WORSE"
          : "  ← better"
        : d < 0
          ? "  ← WORSE"
          : "  ← better";
  console.log(
    `${f.padEnd(17)}  ${String(c).padStart(10)}  ${String(i).padStart(10)}  ${(d > 0 ? `+${d}` : String(d)).padStart(10)}${flag}`,
  );
}

const differing = usable.filter((r) => fields.some((f) => num(r.checker, f) !== num(r.inhouse, f)));
console.log(`\ninputs with ANY emitted-shape difference: ${differing.length} / ${usable.length}`);
for (const r of differing) {
  const parts = fields
    .filter((f) => num(r.checker, f) !== num(r.inhouse, f))
    .map((f) => `${f} ${num(r.checker, f)}→${num(r.inhouse, f)}`);
  console.log(`  ${r.file}: ${parts.join(", ")}`);
}
const failed = rows.filter((r) => !ok(r));
if (failed.length > 0) {
  console.log(`\ncompile failures (excluded from totals): ${failed.length}`);
  for (const r of failed) {
    console.log(
      `  ${r.file}: checker=${typeof r.checker === "string" ? r.checker : "ok"} inhouse=${typeof r.inhouse === "string" ? r.inhouse : "ok"}`,
    );
  }
}

const jsonIdx = args.indexOf("--json");
if (jsonIdx >= 0) {
  writeFileSync(
    args[jsonIdx + 1],
    JSON.stringify(
      { divergence: { grand, byQuery: [...totalsByQuery], perFile, conflictSamples }, codeShape: rows },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${args[jsonIdx + 1]}`);
}
