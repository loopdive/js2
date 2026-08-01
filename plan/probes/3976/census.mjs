// P3 census + instrument calibration.
// 1. Reproduce the standalone baseline totals (43,106 / 25,460) or STOP.
// 2. Enumerate files that INCLUDE harness/propertyHelper.js (routing bound).
// 3. Cross-index with the host baseline to get the standalone-only subset.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const CACHE = "/workspace/.test262-cache";
const T262 = "/workspace/test262";

async function loadJsonl(p) {
  const rows = new Map();
  const rl = readline.createInterface({
    input: fs.createReadStream(p),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    rows.set(r.file, r); // later row wins
  }
  return rows;
}

const sa = await loadJsonl(path.join(CACHE, "test262-standalone-current.jsonl"));
const host = await loadJsonl(path.join(CACHE, "test262-current.jsonl"));

const saOfficial = [...sa.values()].filter((r) => r.scope_official);
const saPass = saOfficial.filter((r) => r.status === "pass").length;
console.log(
  `CALIBRATION standalone: official rows=${saOfficial.length} pass=${saPass} (${((saPass / saOfficial.length) * 100).toFixed(1)}%)`,
);
console.log(`  expected: 43106 / 25460 (59.1%)`);
const calOk = saOfficial.length === 43106 && saPass === 25460;
console.log(`  MATCH=${calOk}`);

const hostOfficial = [...host.values()].filter((r) => r.scope_official);
const hostPass = hostOfficial.filter((r) => r.status === "pass").length;
console.log(
  `CALIBRATION host: official rows=${hostOfficial.length} pass=${hostPass} (${((hostPass / hostOfficial.length) * 100).toFixed(1)}%)`,
);

// --- static census: which test files include propertyHelper.js ---
const includeRe = /includes:\s*\[([^\]]*)\]|includes:\s*\n((?:\s*-\s*\S+\n)+)/;
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}
const all = walk(path.join(T262, "test"), []);
console.log(`static: ${all.length} .js files under test/`);

const includesPH = [];
for (const abs of all) {
  const src = fs.readFileSync(abs, "utf8");
  const meta = src.indexOf("/*---");
  if (meta === -1) continue;
  const end = src.indexOf("---*/", meta);
  if (end === -1) continue;
  const front = src.slice(meta, end);
  if (front.includes("propertyHelper.js")) {
    includesPH.push("test/" + path.relative(path.join(T262, "test"), abs));
  }
}
console.log(`static: ${includesPH.length} files include propertyHelper.js`);

let phSa = 0,
  phSaPass = 0,
  phSaFail = 0,
  phSaFailHostPass = 0,
  noRow = 0;
const population = [];
for (const f of includesPH) {
  const s = sa.get(f);
  if (!s || !s.scope_official) {
    noRow++;
    continue;
  }
  phSa++;
  if (s.status === "pass") phSaPass++;
  else {
    phSaFail++;
    const h = host.get(f);
    if (h && h.status === "pass") {
      phSaFailHostPass++;
      population.push({ file: f, err: s.error, cat: s.error_category, sig: s.error_signature });
    }
  }
}
console.log(`\npropertyHelper population (standalone, official rows):`);
console.log(`  rows present  : ${phSa}   (no official standalone row: ${noRow})`);
console.log(`  pass          : ${phSaPass}`);
console.log(`  fail          : ${phSaFail}`);
console.log(`  fail & HOST-PASS (standalone-only defects): ${phSaFailHostPass}`);
console.log(`  expected from prior analysis: 4898 include / 1494 pass / 3404 fail / 1810 host-pass`);

// error_category breakdown of the 1810
const byCat = new Map();
for (const p of population) byCat.set(p.cat, (byCat.get(p.cat) ?? 0) + 1);
console.log(`\nerror_category of the host-pass population:`);
for (const [k, v] of [...byCat].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);

fs.writeFileSync(".tmp/p3-population.json", JSON.stringify(population, null, 0));
console.log(`\nwrote .tmp/p3-population.json (${population.length} rows)`);
