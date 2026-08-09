// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3684) Cross-engine axis benchmark — node + Porffor legs.
// Generates one driver from `axes-core.js` and runs it under both engines so
// they execute byte-identical source. See README.md.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "../../.tmp/cross-engine");
const PORFFOR = process.env.PORFFOR_DIR ?? "/home/user/porffor";

const core = readFileSync(join(HERE, "axes-core.js"), "utf-8");

// ~35 KB of realistic JS source for the string/tokenizer axes.
let subject = "";
for (let i = 0; i < 800; i++) subject += `var x${i} = function(a,b){ return a+b*${i} };\n`;

const NAMES = ["numeric", "prop", "method", "string", "alloc", "tokenizer"];
const driver = `${core}
var SRC = ${JSON.stringify(subject)};
var NAMES = ${JSON.stringify(NAMES)};
function runOne(k) {
  if (k === 0) return benchNumeric();
  if (k === 1) return benchProp();
  if (k === 2) return benchMethod();
  if (k === 3) return benchString(SRC);
  if (k === 4) return benchAlloc();
  return benchTokenizer(SRC);
}
for (var k = 0; k < NAMES.length; k++) {
  runOne(k);
  var best = 1e18, chk = 0;
  for (var r = 0; r < 5; r++) {
    var t0 = performance.now();
    chk = runOne(k);
    var dt = performance.now() - t0;
    if (dt < best) best = dt;
  }
  console.log(NAMES[k] + " ms=" + best + " chk=" + chk);
}
`;

mkdirSync(OUT_DIR, { recursive: true });
const driverPath = join(OUT_DIR, "axes-driver.js");
writeFileSync(driverPath, driver);
console.log(`driver: ${driverPath} (${driver.length} bytes, subject ${subject.length})\n`);

console.log("=== node ===");
console.log(execFileSync(process.execPath, [driverPath], { encoding: "utf-8" }).trim());

const porf = join(PORFFOR, "porf");
if (!existsSync(porf)) {
  console.log(`\n=== Porffor === SKIPPED (no ${porf}; set PORFFOR_DIR)`);
} else {
  console.log("\n=== Porffor ===");
  const out = execFileSync(porf, [driverPath], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  // Porffor prints C-compiler warnings on stdout; keep only the result rows.
  console.log(
    out
      .split("\n")
      .filter((l) => NAMES.some((n) => l.startsWith(`${n} `)))
      .join("\n"),
  );
}
