// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4218) TS5 checker dependency audit — the measurement behind "given the
 * AST, what does the compiler still need from TypeScript 5?"
 *
 * Compiles the playground example corpus (the same corpus as
 * check-ir-fallbacks) plus a set of unannotated plain-JS snippets (the
 * test262-shaped mode) under BOTH oracle backends:
 *
 *   - `checker`  — today's default: `ctx.oracle` is TsCheckerOracle, so
 *     checker traffic = oracle traffic + legacy raw `ctx.checker` sites.
 *   - `inhouse`  — #4218 Phase 1: `ctx.oracle` answers without the checker,
 *     so ANY checker call that still fires is a remaining TS5 dependency
 *     (a legacy raw site or an `oracle-ratchet-allow:` grant).
 *
 * The per-method call counts and attributed call sites come from the
 * `JS2WASM_TRACE_TS5=1` proxy (src/checker/ts5-trace.ts). The report also
 * compares compile outcomes between backends (success/failure + wasm byte
 * equality) as a cheap parity signal.
 *
 * Usage:
 *   npx tsx scripts/audit-ts5-checker-usage.mts [--json <out.json>] [--sites N]
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

process.env.JS2WASM_TRACE_TS5 = "1";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");

const { compile } = await import("../src/index.js");
const { readTs5CheckerTrace, resetTs5CheckerTrace } = await import("../src/checker/ts5-trace.js");

type Backend = "checker" | "inhouse";

interface FileOutcome {
  file: string;
  ok: boolean;
  error?: string;
  wasmSha?: string;
}

interface BackendRun {
  backend: Backend;
  outcomes: FileOutcome[];
  trace: ReturnType<typeof readTs5CheckerTrace>;
}

function collectCorpus(): { name: string; source: string }[] {
  const corpus: { name: string; source: string }[] = [];
  const root = join(REPO_ROOT, "website/playground/examples");
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) {
        corpus.push({ name: relative(REPO_ROOT, p), source: readFileSync(p, "utf8") });
      }
    }
  };
  walk(root);

  // Unannotated plain-JS snippets — the test262-shaped mode where the checker
  // has no annotations to read and #4218 Phase 1 claims zero checker value.
  const plainJs: Record<string, string> = {
    "<js> fib": "function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); } console.log(fib(20));",
    "<js> closures":
      "function counter() { let c = 0; return function () { return ++c; }; } const inc = counter(); inc(); console.log(inc());",
    "<js> strings":
      'const s = "hello world"; const parts = s.split(" "); console.log(parts.map(p => p.toUpperCase()).join("-"));',
    "<js> arrays":
      "const xs = [3, 1, 4, 1, 5, 9, 2, 6]; xs.sort((a, b) => a - b); console.log(xs.filter(x => x % 2 === 0).reduce((a, b) => a + b, 0));",
    "<js> class":
      "class Point { constructor(x, y) { this.x = x; this.y = y; } dist() { return Math.sqrt(this.x * this.x + this.y * this.y); } } console.log(new Point(3, 4).dist());",
    "<js> generators":
      "function* gen() { yield 1; yield 2; yield 3; } let t = 0; for (const v of gen()) t += v; console.log(t);",
    "<js> destructuring":
      "const { a, b = 2, ...rest } = { a: 1, c: 3, d: 4 }; const [x, ...ys] = [10, 20, 30]; console.log(a + b + x + ys.length + Object.keys(rest).length);",
    "<js> trythrow":
      'try { throw new TypeError("boom"); } catch (e) { console.log(e instanceof TypeError, e.message); }',
  };
  for (const [name, source] of Object.entries(plainJs)) corpus.push({ name, source });
  return corpus;
}

async function runBackend(backend: Backend, corpus: { name: string; source: string }[]): Promise<BackendRun> {
  resetTs5CheckerTrace();
  const outcomes: FileOutcome[] = [];
  for (const { name, source } of corpus) {
    try {
      const result = await compile(source, { oracleBackend: backend });
      // (#4218) The result field is `binary`, NOT `wasm`. Reading `.wasm` gave
      // `undefined` for every input, so the parity check compared
      // `undefined === undefined` and reported a vacuous 21/21 match. Treat a
      // missing binary as a hard failure rather than silently "identical".
      const binary: Uint8Array | undefined = (result as { binary?: Uint8Array }).binary;
      if (!binary) {
        outcomes.push({ file: name, ok: false, error: "compile returned no binary" });
        continue;
      }
      outcomes.push({
        file: name,
        ok: true,
        wasmSha: createHash("sha256").update(binary).digest("hex").slice(0, 16),
      });
    } catch (err) {
      outcomes.push({ file: name, ok: false, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
  }
  return { backend, outcomes, trace: readTs5CheckerTrace() };
}

function printReport(runs: BackendRun[], siteLimit: number): void {
  const [checkerRun, inhouseRun] = runs;
  const methods = new Map<string, { checker: number; inhouse: number }>();
  for (const t of checkerRun.trace) methods.set(t.method, { checker: t.calls, inhouse: 0 });
  for (const t of inhouseRun.trace) {
    const e = methods.get(t.method) ?? { checker: 0, inhouse: 0 };
    e.inhouse = t.calls;
    methods.set(t.method, e);
  }

  console.log("\n== TS5 TypeChecker method calls per oracle backend (corpus compile) ==\n");
  const rows = [...methods.entries()].sort((a, b) => b[1].inhouse - a[1].inhouse || b[1].checker - a[1].checker);
  const w = Math.max(...rows.map(([m]) => m.length), 6);
  console.log(`${"method".padEnd(w)}  ${"checker".padStart(9)}  ${"inhouse".padStart(9)}`);
  for (const [m, c] of rows) {
    console.log(`${m.padEnd(w)}  ${String(c.checker).padStart(9)}  ${String(c.inhouse).padStart(9)}`);
  }
  const total = (run: BackendRun) => run.trace.reduce((a, t) => a + t.calls, 0);
  console.log(
    `${"TOTAL".padEnd(w)}  ${String(total(checkerRun)).padStart(9)}  ${String(total(inhouseRun)).padStart(9)}`,
  );

  console.log("\n== Remaining checker call sites under the inhouse backend (the TS5 dependency list) ==\n");
  if (inhouseRun.trace.length === 0) {
    console.log("  (none — zero checker calls: the compile needed nothing from the TS5 checker)");
  }
  for (const t of inhouseRun.trace) {
    console.log(`  ${t.method} (${t.calls} calls)`);
    for (const s of t.sites.slice(0, siteLimit)) console.log(`      ${s.site}  (${s.calls})`);
  }

  console.log("\n== Compile parity (checker vs inhouse backend) ==\n");
  let same = 0;
  let diff = 0;
  let failures = 0;
  for (let i = 0; i < checkerRun.outcomes.length; i++) {
    const a = checkerRun.outcomes[i];
    const b = inhouseRun.outcomes[i];
    if (!a.ok || !b.ok) {
      failures++;
      console.log(`  FAIL  ${a.file}  checker:${a.ok ? "ok" : a.error}  inhouse:${b.ok ? "ok" : b.error}`);
    } else if (a.wasmSha === b.wasmSha) same++;
    else {
      diff++;
      console.log(`  DIFF  ${a.file}  ${a.wasmSha} != ${b.wasmSha}`);
    }
  }
  console.log(`  byte-identical: ${same}, divergent: ${diff}, failed: ${failures} (of ${checkerRun.outcomes.length})`);
}

const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json");
const sitesIdx = args.indexOf("--sites");
const siteLimit = sitesIdx >= 0 ? Number(args[sitesIdx + 1]) : 8;

const corpus = collectCorpus();
console.log(
  `corpus: ${corpus.length} inputs (${corpus.filter((c) => c.name.startsWith("<js>")).length} plain-JS snippets)`,
);

const checkerRun = await runBackend("checker", corpus);
const inhouseRun = await runBackend("inhouse", corpus);
printReport([checkerRun, inhouseRun], siteLimit);

if (jsonIdx >= 0) {
  const out = args[jsonIdx + 1];
  writeFileSync(out, JSON.stringify({ generatedAt: "audit", runs: [checkerRun, inhouseRun] }, null, 2));
  console.log(`\nwrote ${out}`);
}
