// Full-population decomposition of the 1,810 (no sampling — this is a census).
import fs from "node:fs";
const pop = JSON.parse(fs.readFileSync(".tmp/p3-population.json", "utf8"));

const norm = (e) =>
  String(e ?? "")
    .replace(/ \| at L\d+:.*$/s, "")
    .replace(/'[^']*'/g, "'X'")
    .replace(/\bown property \S+/g, "own property X")
    .replace(/\d+/g, "#")
    .slice(0, 78);

const bySig = new Map();
for (const r of pop) {
  const k = norm(r.err);
  if (!bySig.has(k)) bySig.set(k, []);
  bySig.get(k).push(r.file);
}
console.log(`=== normalized error signature, all ${pop.length} ===`);
let cum = 0;
for (const [k, v] of [...bySig].sort((a, b) => b[1].length - a[1].length).slice(0, 18)) {
  cum += v.length;
  console.log(`${String(v.length).padStart(5)}  ${((cum / pop.length) * 100).toFixed(0).padStart(3)}%  ${k}`);
}
console.log(`(${bySig.size} distinct signatures)`);

// the "own property" family split by test area
const own = pop.filter((r) => /should have an own property/.test(String(r.err)));
console.log(
  `\n=== "obj should have an own property X" family: ${own.length} of ${pop.length} (${((own.length / pop.length) * 100).toFixed(0)}%) ===`,
);
const byArea = new Map();
for (const r of own) {
  const p = r.file.split("/");
  const area = p.slice(1, 4).join("/");
  byArea.set(area, (byArea.get(area) ?? 0) + 1);
}
for (const [k, v] of [...byArea].sort((a, b) => b[1] - a[1]).slice(0, 15))
  console.log(`${String(v).padStart(5)}  ${k}`);

// whole population by area
console.log(`\n=== whole population by test area ===`);
const byArea2 = new Map();
for (const r of pop) {
  const p = r.file.split("/");
  byArea2.set(p.slice(1, 4).join("/"), (byArea2.get(p.slice(1, 4).join("/")) ?? 0) + 1);
}
let c2 = 0;
for (const [k, v] of [...byArea2].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  c2 += v;
  console.log(`${String(v).padStart(5)}  ${((c2 / pop.length) * 100).toFixed(0).padStart(3)}%  ${k}`);
}

// how many mention the uncurryThis receiver-drop signature #3571 documents?
const drop = pop.filter((r) =>
  /Cannot convert undefined or null to object|Cannot access property on null or undefined/.test(String(r.err)),
);
console.log(`\n=== #3571's documented receiver-drop signature ===`);
console.log(`${drop.length} of ${pop.length} (${((drop.length / pop.length) * 100).toFixed(1)}%)`);
const byArea3 = new Map();
for (const r of drop)
  byArea3.set(r.file.split("/").slice(1, 4).join("/"), (byArea3.get(r.file.split("/").slice(1, 4).join("/")) ?? 0) + 1);
for (const [k, v] of [...byArea3].sort((a, b) => b[1] - a[1]).slice(0, 10))
  console.log(`${String(v).padStart(5)}  ${k}`);
fs.writeFileSync(
  ".tmp/p3-dropsig.json",
  JSON.stringify(
    drop.map((r) => r.file),
    null,
    0,
  ),
);
