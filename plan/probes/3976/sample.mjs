// Build a seeded sample from the P3 population + embedded controls.
// usage: node .tmp/sample.mjs <N> <seed> <out.json>
import fs from "node:fs";
import readline from "node:readline";

const N = Number(process.argv[2] ?? 30);
const SEED = Number(process.argv[3] ?? 20260801);
const OUT = process.argv[4] ?? ".tmp/p3-sample.json";

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pop = JSON.parse(fs.readFileSync(".tmp/p3-population.json", "utf8"));
const rnd = mulberry32(SEED);
const shuffled = [...pop];
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
const sample = shuffled.slice(0, N).map((r) => r.file);

// ── embedded POSITIVE CONTROLS: propertyHelper files that PASS standalone.
// They must pass in EVERY arm; if a B arm breaks them the rewrite is wrong.
const sa = new Map();
const rl = readline.createInterface({
  input: fs.createReadStream("/workspace/.test262-cache/test262-standalone-current.jsonl"),
  crlfDelay: Infinity,
});
for await (const line of rl) {
  if (!line.trim()) continue;
  try {
    const r = JSON.parse(line);
    sa.set(r.file, r);
  } catch {}
}
const phFiles = new Set(pop.map((r) => r.file));
const passers = [];
for (const [f, r] of sa) {
  if (r.status !== "pass" || !r.scope_official) continue;
  if (phFiles.has(f)) continue;
  const abs = "/workspace/test262/" + f;
  if (!fs.existsSync(abs)) continue;
  const src = fs.readFileSync(abs, "utf8");
  const m = src.indexOf("/*---");
  if (m === -1) continue;
  const e = src.indexOf("---*/", m);
  if (e === -1) continue;
  if (!src.slice(m, e).includes("propertyHelper.js")) continue;
  // must actually exercise the uncurried path
  if (!/verifyProperty|verifyNotWritable|verifyNotEnumerable|verifyNotConfigurable/.test(src)) continue;
  passers.push(f);
  if (passers.length >= 200) break;
}
const controls = [];
const rnd2 = mulberry32(SEED ^ 0x5eed);
const ps = [...passers];
for (let i = ps.length - 1; i > 0; i--) {
  const j = Math.floor(rnd2() * (i + 1));
  [ps[i], ps[j]] = [ps[j], ps[i]];
}
controls.push(...ps.slice(0, 6));

const list = [...controls, ...sample];
fs.writeFileSync(OUT, JSON.stringify(list, null, 0));
fs.writeFileSync(
  OUT.replace(/\.json$/, "-meta.json"),
  JSON.stringify({ seed: SEED, N, controls, sample, popSize: pop.length }, null, 2),
);
console.log(`sample: ${sample.length} from population of ${pop.length}, seed ${SEED}`);
console.log(`positive controls (standalone-PASS + propertyHelper + verify*): ${controls.length}`);
for (const c of controls) console.log(`  CTRL ${c}`);
console.log(`wrote ${OUT} (${list.length} files total)`);
