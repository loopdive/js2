// Validate the compile-friendly tokenizer's stream against acorn.tokenizer per corpus file.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setupAcorn } from "../../tests/dogfood/setup-acorn.mjs";
const { entryModulePath } = setupAcorn();
const acorn = await import(pathToFileURL(entryModulePath));
const { tokenize } = await import("./fast-tokenizer.ts");

const CORPUS = "tests/dogfood/corpus";
const files = readdirSync(CORPUS)
  .filter((f) => f.endsWith(".js") && !f.endsWith(".module.js"))
  .sort();
const types = new Int32Array(200000),
  starts = new Int32Array(200000),
  ends = new Int32Array(200000);
const matched = [],
  mismatched = [];
for (const f of files) {
  const src = readFileSync(join(CORPUS, f), "utf-8");
  let ref;
  try {
    ref = [...acorn.tokenizer(src, { ecmaVersion: 2023 })]
      .filter((t) => t.type.label !== "eof")
      .map((t) => `${t.start}:${t.end}`);
  } catch {
    mismatched.push([f, "acorn itself threw"]);
    continue;
  }
  const n = tokenize(src, types, starts, ends);
  const mine = Array.from({ length: n }, (_, i) => `${starts[i]}:${ends[i]}`);
  if (mine.length === ref.length && mine.every((v, i) => v === ref[i])) matched.push([f, n]);
  else {
    let firstDiff = -1;
    for (let i = 0; i < Math.max(mine.length, ref.length); i++)
      if (mine[i] !== ref[i]) {
        firstDiff = i;
        break;
      }
    mismatched.push([
      f,
      `mine ${mine.length} vs acorn ${ref.length}; first diff @${firstDiff}: ${mine[firstDiff]} vs ${ref[firstDiff]}`,
    ]);
  }
}
console.log(`MATCHED ${matched.length}/${files.length}:`, matched.map(([f, n]) => `${f}(${n})`).join(" "));
for (const [f, why] of mismatched) console.log("  MISMATCH", f, "—", why);
