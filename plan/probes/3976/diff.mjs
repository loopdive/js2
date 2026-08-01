// Paired per-file comparison of arms. usage: node .tmp/diff.mjs <meta.json> <A.json> <label:file>...
import fs from "node:fs";
const meta = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const ctrl = new Set(meta.controls);
const arms = process.argv.slice(3).map((s) => {
  const [label, file] = s.split("=");
  return { label, rows: new Map(JSON.parse(fs.readFileSync(file, "utf8")).map((r) => [r.file, r])) };
});
const base = arms[0];
console.log(`base arm = ${base.label}\n`);
for (const a of arms) {
  const rows = [...a.rows.values()];
  const c = rows.filter((r) => ctrl.has(r.file));
  const p = rows.filter((r) => !ctrl.has(r.file));
  console.log(
    `${a.label.padEnd(4)} controls ${c.filter((r) => r.status === "pass").length}/${c.length} pass   ` +
      `population ${p.filter((r) => r.status === "pass").length}/${p.length} pass`,
  );
}
console.log();
for (const a of arms.slice(1)) {
  const gained = [],
    lost = [],
    gainedC = [],
    lostC = [];
  for (const [f, r] of a.rows) {
    const b = base.rows.get(f);
    if (!b) continue;
    const isC = ctrl.has(f);
    if (b.status !== "pass" && r.status === "pass") (isC ? gainedC : gained).push(f);
    if (b.status === "pass" && r.status !== "pass") (isC ? lostC : lost).push([f, r.error]);
  }
  console.log(`=== ${base.label} -> ${a.label} ===`);
  console.log(`  population fail->pass : ${gained.length}`);
  for (const f of gained) console.log(`      + ${f}`);
  console.log(`  population pass->fail : ${lost.length}`);
  for (const [f, e] of lost) console.log(`      - ${f}  ${String(e).slice(0, 90)}`);
  console.log(`  CONTROL fail->pass    : ${gainedC.length}`);
  console.log(`  CONTROL pass->fail    : ${lostC.length}  ${lostC.length ? "<<< INSTRUMENT INVALID" : "(ok)"}`);
  for (const [f, e] of lostC) console.log(`      - ${f}  ${String(e).slice(0, 90)}`);
  console.log();
}
// error signature census of base population failures
const popFail = [...base.rows.values()].filter((r) => !ctrl.has(r.file) && r.status !== "pass");
const sig = new Map();
for (const r of popFail) {
  const k = String(r.error).replace(/\d+/g, "#").slice(0, 70);
  sig.set(k, (sig.get(k) ?? 0) + 1);
}
console.log(`base population failure signatures (${popFail.length}):`);
for (const [k, v] of [...sig].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
