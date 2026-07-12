// #3153 — IR post-claim demotion meter (the #3143 IR-first divergence census).
//
// The #3143 flip's divergence root cause: the STATIC selector
// (`planIrCompilation`) claims functions the `from-ast` builder cannot actually
// lower, so it throws post-claim. Under the overlay that throw is caught and the
// legacy body is used (a silent metered demote); under IR-first the skipped slot
// turns it into a hard `unreachable` / compile error. The set of throw-message
// CLASSES is therefore exactly the selector-precision work list for #2855/#2949
// (fix (A) in plan/issues/3143-*.md): each class is either made lowerable
// (from-ast option a) or mirrored into select.ts/capability.ts as a reject
// (option b).
//
// This script measures that set EMPIRICALLY over a broad corpus (a stride
// sample of test262 + all example/playground .ts) rather than by grep of the
// `throw` sites — the corpus tells us which classes actually FIRE and how often,
// so precision work is prioritised by real frequency.
//
// Usage:
//   STRIDE=15 npx tsx scripts/ir-postclaim-meter.mts <compilerRoot> [outJson]
//   (STRIDE default 15 → ~2900 test262 files; STRIDE=1 = full corpus, slow.)
//
// Output: a per-message-class histogram (count + example file/func) to stdout,
// and the full JSONL of raw records to `outJson` (default
// .tmp/ir-postclaim-meter.jsonl) for follow-up slicing. NON-GATING — a census.
import { readFileSync, readdirSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const compilerRoot = process.argv[2] ?? process.cwd();
const outFile = process.argv[3] ?? ".tmp/ir-postclaim-meter.jsonl";
const { compile } = await import(pathToFileURL(join(compilerRoot, "src/index.ts")).href);

const INPUT_ROOT = "/workspace";
const STRIDE = Number(process.env.STRIDE ?? 15);

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
      let s;
      try {
        s = lstatSync(p);
      } catch {
        continue;
      }
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

// Same normalizer as scripts/check-ir-fallbacks.ts (keep in lockstep) so the
// classes here map 1:1 to that gate's post-claim buckets.
function normalizeMessageClass(message: string): string {
  return (message.split("\n")[0] ?? "")
    .replace(/'[^']*'/g, "'…'")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\b\d+\b/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

interface Record_ {
  file: string;
  func: string;
  kind: string;
  cls: string;
  raw: string;
}

const records: Record_[] = [];
let compiled = 0;
let failedCompile = 0;

for (const file of files) {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  try {
    const r = await compile(src, { fileName: file, experimentalIR: true });
    compiled++;
    for (const e of r.irPostClaimErrors ?? []) {
      records.push({
        file: file.replace(INPUT_ROOT + "/", ""),
        func: e.func,
        kind: e.kind,
        cls: normalizeMessageClass(e.message),
        raw: e.message,
      });
    }
  } catch {
    failedCompile++;
  }
}

writeFileSync(outFile, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

// Aggregate by (kind, message class).
const hist = new Map<string, { count: number; example: Record_ }>();
for (const r of records) {
  const key = `${r.kind}\t${r.cls}`;
  const h = hist.get(key);
  if (h) h.count++;
  else hist.set(key, { count: 1, example: r });
}
const sorted = [...hist.entries()].sort((a, b) => b[1].count - a[1].count);

console.log(`\n=== IR post-claim demotion census (#3153) ===`);
console.log(`corpus: ${files.length} files (STRIDE=${STRIDE}), compiled ${compiled}, hard-failed ${failedCompile}`);
console.log(`total post-claim demotions: ${records.length}, distinct classes: ${hist.size}\n`);
console.log(`  count  kind      message class  (example file :: func)`);
console.log(`  -----  --------  ----------------------------------------------------------------`);
for (const [key, { count, example }] of sorted) {
  const [kind, cls] = key.split("\t");
  console.log(`  ${String(count).padStart(5)}  ${kind.padEnd(8)}  ${cls}`);
  console.log(`         └─ ${example.file} :: ${example.func}`);
}
console.log(`\nraw JSONL: ${outFile}`);
