#!/usr/bin/env node
// (#3954 phase 1) TAG-DOMAIN SEAM RATCHET — fails CI when direct `JsTag` enum
// usage under src/ GROWS.
//
// WHY THIS GATE EXISTS. Phase 1 replaced `IrType`'s `{ kind: "dynamic";
// tag?: JsTag }` leaf with an opaque `TagId` resolved against a `TagDomain`
// (src/ir/tag-domain.ts), so the IR's ECMAScript assumptions are named instead
// of ambient. That is a one-time factoring; without a ratchet it decays the
// first time somebody reaches for the enum because it is closer to hand. The
// gate does not forbid `JsTag` — a lot of the remaining uses are legitimate
// (the WasmGC lowering emits these integers as `$AnyValue.tag` constants, and
// the JavaScript producer is entitled to name JavaScript partitions). It
// forbids the count going UP, and banks it whenever it goes down.
//
// Shape deliberately mirrors `check:ir-fallbacks` / `check:oracle-ratchet`:
// a committed per-file baseline, growth fails, `--update-on-decrease` banks
// improvements from the post-merge job.
//
// COUNTED, per file under src/ (excluding *.d.ts and the exempt leaves below):
//   valueImports — import statements that bind `JsTag` as a VALUE, from ANY
//                  module. Counting by specifier NAME rather than by source
//                  path is load-bearing: `codegen/value-tags.ts` and
//                  `codegen/js-tag.ts` both RE-EXPORT the enum, so a path-based
//                  scan would miss every consumer that imports it from there.
//                  `import type { JsTag }` and `import { type JsTag }` are NOT
//                  counted — a type-only reference cannot read an enum value
//                  and is exactly what the seam permits.
//   refs         — direct enum-value reads: `JsTag.Foo` and the reverse map
//                  `JsTag[expr]`.
//
// NOT counted: `export { JsTag } from …` re-export lines (pass-throughs, not
// consumption — their consumers are counted at the import site), and anything
// in a block comment or a whole-line `//` / ` *` comment.
//
// SCOPE is src/ only. tests/ legitimately pins the enum's numeric values
// against the `__any_box_*` runtime tags (that ABI assertion is the reason the
// values may not move), so gating tests would fight a test we want.
//
// Usage:
//   node scripts/check-jstag-seam.mjs                     # gate (default)
//   node scripts/check-jstag-seam.mjs --verbose           # per-file breakdown
//   node scripts/check-jstag-seam.mjs --update            # reseed the baseline
//   node scripts/check-jstag-seam.mjs --update-on-decrease # bank improvements
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCOPE = join(ROOT, "src");
const BASELINE_PATH = join(ROOT, "scripts", "jstag-seam-baseline.json");

/**
 * The seam's own leaves. These are the files ALLOWED to speak `JsTag`
 * natively — everything else is measured against them.
 *   - `src/ir/js-tag.ts`        the enum + its Wasm-carrier table.
 *   - `src/ir/js-tag-domain.ts` the ECMAScript `TagDomain` implementation.
 *   - `src/ir/tag-domain.ts`    the neutral interface (has no `JsTag` at all;
 *                               listed so the seam's file set is one list).
 */
const EXEMPT = new Set(["src/ir/js-tag.ts", "src/ir/js-tag-domain.ts", "src/ir/tag-domain.ts"]);

const FIELDS = ["valueImports", "refs"];
const ZERO = { valueImports: 0, refs: 0 };

const args = process.argv.slice(2);
const update = args.includes("--update");
const updateOnDecrease = args.includes("--update-on-decrease");
const verbose = args.includes("--verbose");

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/**
 * Drop comments so prose about `JsTag` cannot trip the gate. Block comments and
 * whole-line comments go entirely; a TRAILING `// …` is dropped only when the
 * text before it has balanced quotes, so a `//` inside a string literal (a URL,
 * a path) never truncates a real code line.
 *
 * This matters concretely: `codegen/standalone-wrapper-instanceof.ts` emits
 * `{ op: "i32.const", value: 6 }, // JsTag.Object` — the code contains the
 * literal 6, not the enum, and counting that comment would have put a file with
 * zero real usage into the baseline.
 */
function stripComments(src) {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const balanced = (s) => {
    for (const q of ['"', "'", "`"]) {
      if ((s.split(q).length - 1) % 2 !== 0) return false;
    }
    return true;
  };
  return noBlocks
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*")) return "";
      let idx = line.indexOf("//");
      while (idx !== -1) {
        if (balanced(line.slice(0, idx))) return line.slice(0, idx);
        idx = line.indexOf("//", idx + 2);
      }
      return line;
    })
    .join("\n");
}

/**
 * True when this file's `JsTag` is the ORACLE's unrelated same-named type
 * (`src/checker/oracle.ts` exports a `JsTag` string union — `"number" |
 * "string" | …` — for static JS-type classification). It is a different symbol
 * with a colliding name; counting it would fail PRs for reasons that have
 * nothing to do with this seam.
 */
function bindsOracleJsTag(src) {
  return /\bimport\s+(?:type\s+)?\{[^}]*\bJsTag\b[^}]*\}\s*from\s*["'][^"']*checker\/(?:oracle|oracle-backend|inhouse-oracle)\.js["']/.test(
    src,
  );
}

/** Count import statements that bind `JsTag` as a VALUE. */
function countValueImports(src) {
  let n = 0;
  const re = /\bimport\s+(type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g;
  let m = re.exec(src);
  while (m !== null) {
    const typeOnlyStatement = m[1] !== undefined;
    if (!typeOnlyStatement) {
      const bound = m[2]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const spec of bound) {
        // `type JsTag` / `type JsTag as X` are type-only bindings.
        if (/^type\s/.test(spec)) continue;
        const name = spec.split(/\s+as\s+/)[0].trim();
        if (name === "JsTag") n += 1;
      }
    }
    m = re.exec(src);
  }
  return n;
}

/**
 * Count direct enum-value reads: `JsTag.Foo` (member access) and `JsTag[expr]`
 * (the reverse name map). The `[` arm deliberately requires a non-empty index
 * so the ARRAY TYPE `JsTag[]` is not mistaken for a read.
 */
function countRefs(src) {
  const m = src.match(/\bJsTag\s*(?:\.\s*[A-Za-z_$]|\[\s*[^\]\s])/g);
  return m ? m.length : 0;
}

function countFields(src) {
  if (bindsOracleJsTag(src)) return { ...ZERO };
  const code = stripComments(src);
  return { valueImports: countValueImports(code), refs: countRefs(code) };
}

const current = {};
for (const file of walk(SCOPE)) {
  const rel = relative(ROOT, file).split("\\").join("/");
  if (EXEMPT.has(rel)) continue;
  const c = countFields(readFileSync(file, "utf-8"));
  if (c.valueImports > 0 || c.refs > 0) current[rel] = c;
}

const totals = (obj) =>
  Object.values(obj).reduce((a, c) => ({ valueImports: a.valueImports + c.valueImports, refs: a.refs + c.refs }), {
    ...ZERO,
  });

if (verbose) {
  for (const [file, c] of Object.entries(current)) {
    console.error(`[jstag-seam]   ${file}: valueImports=${c.valueImports}, refs=${c.refs}`);
  }
  const t = totals(current);
  console.error(`[jstag-seam] current totals: valueImports=${t.valueImports}, refs=${t.refs}`);
}

if (update) {
  const t = totals(current);
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify({ generated: new Date().toISOString(), totals: t, files: current }, null, 2)}\n`,
  );
  console.log(
    `[jstag-seam] baseline updated: ${Object.keys(current).length} files, ` +
      `valueImports=${t.valueImports}, refs=${t.refs}`,
  );
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
} catch {
  console.error(`[jstag-seam] missing/invalid baseline at ${BASELINE_PATH} — run with --update to seed.`);
  process.exit(1);
}

const failures = [];
let decreased = false;
const merged = { ...baseline.files };
for (const [file, counts] of Object.entries(current)) {
  const base = baseline.files[file] ?? ZERO;
  for (const field of FIELDS) {
    const allowed = base[field] ?? 0;
    if (counts[field] > allowed) failures.push(`${file}: ${field} ${counts[field]} > baseline ${allowed}`);
    else if (counts[field] < allowed) decreased = true;
  }
  merged[file] = counts;
}
for (const file of Object.keys(baseline.files)) {
  if (!current[file]) {
    decreased = true;
    delete merged[file];
  }
}

if (failures.length > 0) {
  console.error(
    `[jstag-seam] FAILED — direct \`JsTag\` usage GREW under src/ (${failures.length} file(s)).\n\n` +
      `#3954 phase 1 put the IR's dynamic value model behind a TagDomain seam\n` +
      `(src/ir/tag-domain.ts, implemented by src/ir/js-tag-domain.ts). New code\n` +
      `should ask the domain, not the enum:\n\n` +
      `  - need the partition's payload shape?   domain.carrierKindOf(tagId)\n` +
      `  - need its name for a diagnostic?       domain.nameOf(tagId)\n` +
      `  - need a partition to refine an IrType? JS_TAG_IDS.String (producers only)\n` +
      `  - crossing to a JsTag-typed API?        jsTagOf(tagId) / tagIdOfJsTag(t)\n` +
      `  - only need the TYPE?                   \`import type { JsTag }\` (not counted)\n\n` +
      `If the growth is genuinely intentional (a new lowering arm that must emit\n` +
      `the runtime tag constants), say so in the PR and reseed the baseline with\n` +
      `\`node scripts/check-jstag-seam.mjs --update\`.\n\nOffending files:\n  ` +
      failures.join("\n  "),
  );
  process.exit(1);
}

if (updateOnDecrease && decreased) {
  const t = totals(merged);
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify({ generated: new Date().toISOString(), totals: t, files: merged }, null, 2)}\n`,
  );
  console.log("[jstag-seam] decreases banked into baseline.");
}

const t = totals(current);
console.log(
  `[jstag-seam] OK — direct JsTag usage outside the domain leaves: ` +
    `valueImports=${t.valueImports}, refs=${t.refs} across ${Object.keys(current).length} file(s) (no growth).`,
);
