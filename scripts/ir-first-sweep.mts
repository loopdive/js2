// #2138 Slice 3 — compile-level measurement sweep (flag-on vs flag-off).
// Usage: STRIDE=20 npx tsx .tmp/slice3-sweep.mts <compilerRoot> <outJson>
//
// For a deterministic stride-N sample of test262 (+ all example files), compile
// each file twice — JS2WASM_IR_FIRST unset, then =1 — and record:
//   - status parity (flag-on-only failures = divergences to file, the loud
//     skipped-slot contract),
//   - CompileResult.irFirstSkipped (per-file skipped function names),
//   - top-level FunctionDeclaration count (denominator for the claim rate),
//   - wall-clock compile time per mode (aggregate; single-process, so only
//     the RATIO is meaningful, not absolute ms).
import { readFileSync, readdirSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const compilerRoot = process.argv[2]!;
const outFile = process.argv[3]!;
const { compile } = await import(pathToFileURL(join(compilerRoot, "src/index.ts")).href);

const INPUT_ROOT = "/workspace";
const STRIDE = Number(process.env.STRIDE ?? 20);

function walk(root: string, ext: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const p = join(dir, name);
      const s = lstatSync(p);
      if (s.isSymbolicLink()) continue;
      if (s.isDirectory()) stack.push(p);
      else if (name.endsWith(ext) && !name.endsWith(".d.ts") && !name.includes("_FIXTURE")) out.push(p);
    }
  }
  return out.sort();
}

const files = [
  ...walk(join(INPUT_ROOT, "website/playground/examples"), ".ts"),
  ...walk(join(INPUT_ROOT, "examples"), ".ts"),
  ...walk(join(INPUT_ROOT, "test262/test"), ".js").filter((_, i) => i % STRIDE === 0),
];

function topLevelFnCount(src: string): number {
  try {
    const sf = ts.createSourceFile("m.ts", src, ts.ScriptTarget.ES2022, false);
    let n = 0;
    for (const s of sf.statements) if (ts.isFunctionDeclaration(s)) n++;
    return n;
  } catch {
    return 0;
  }
}

type Row = {
  file: string;
  fns: number;
  off: { ok: boolean; ms: number };
  on: { ok: boolean; ms: number; skipped: number };
  divergence?: string; // first flag-on-only error
  skippedNames?: string[];
};

async function compileOnce(src: string, flag: boolean): Promise<{ r: any; ms: number }> {
  process.env.JS2WASM_IR_FIRST = flag ? "1" : "";
  const t0 = performance.now();
  let r: any;
  try {
    r = await compile(src, { fileName: "test.ts" });
  } catch (e) {
    r = { success: false, errors: [{ message: "throw: " + String(e instanceof Error ? e.message : e) }] };
  }
  return { r, ms: performance.now() - t0 };
}

const rows: Row[] = [];
let done = 0;
for (const f of files) {
  const src = readFileSync(f, "utf-8");
  const fns = topLevelFnCount(src);
  const off = await compileOnce(src, false);
  const on = await compileOnce(src, true);
  const row: Row = {
    file: f.replace(INPUT_ROOT, ""),
    fns,
    off: { ok: !!off.r.success, ms: Math.round(off.ms * 10) / 10 },
    on: { ok: !!on.r.success, ms: Math.round(on.ms * 10) / 10, skipped: on.r.irFirstSkipped?.length ?? 0 },
  };
  if (on.r.irFirstSkipped?.length) row.skippedNames = on.r.irFirstSkipped;
  if (off.r.success && !on.r.success) {
    row.divergence = String(on.r.errors?.[0]?.message ?? "unknown").slice(0, 300);
  }
  rows.push(row);
  if (++done % 200 === 0) process.stderr.write(`  ${done}/${files.length}\n`);
}

const agg = {
  files: rows.length,
  totalTopLevelFns: rows.reduce((a, r) => a + r.fns, 0),
  totalSkipped: rows.reduce((a, r) => a + r.on.skipped, 0),
  filesWithSkips: rows.filter((r) => r.on.skipped > 0).length,
  offOk: rows.filter((r) => r.off.ok).length,
  onOk: rows.filter((r) => r.on.ok).length,
  divergences: rows.filter((r) => r.divergence).length,
  offMsTotal: Math.round(rows.reduce((a, r) => a + r.off.ms, 0)),
  onMsTotal: Math.round(rows.reduce((a, r) => a + r.on.ms, 0)),
};
writeFileSync(outFile, JSON.stringify({ agg, divergent: rows.filter((r) => r.divergence), rows }, null, 1));
process.stderr.write(`done. agg=${JSON.stringify(agg)}\n`);
