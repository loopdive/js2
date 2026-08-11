#!/usr/bin/env npx tsx
/**
 * Generate website/public/benchmarks/results/test262-editions.json from actual test262 runner results.
 *
 * Reads benchmarks/results/test262-results.jsonl (one JSON record per test) and classifies
 * each test into an ES edition by reading its YAML frontmatter.
 *
 * Edition detection priority:
 *   1. `es5id:` in frontmatter → ES5
 *   2. `es6id:` in frontmatter → ES2015
 *   3. `features: [...]` in frontmatter → look up edition by feature tag (highest wins)
 *   4. Directory path heuristics (annexB → ES5, built-ins/es6/ → ES2015, etc.)
 *   5. Fall-through → "Other"
 *
 * Usage:
 *   npx tsx scripts/generate-editions.ts [--results path/to/results.jsonl] [--output path/to/out.json]
 *
 * Issue: #959
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// test262 may live in the main workspace when running from a git worktree.
// Walk up to find it: ROOT/test262 or ROOT/../../../test262 (worktree depth).
function findTest262Root(base: string): string {
  const direct = join(base, "test262");
  if (existsSync(join(direct, "test"))) return direct;
  // Worktrees are at .claude/worktrees/<name> — main workspace is 3 levels up
  const mainWs = join(base, "..", "..", "..");
  const fromMain = join(mainWs, "test262");
  if (existsSync(join(fromMain, "test"))) return fromMain;
  return direct; // fall back; script will error with a clear path
}

const TEST262_ROOT = findTest262Root(ROOT);
// #1528 — the JSONL is no longer committed to the main repo. Prefer the
// on-demand fetched cache, then fall back to the legacy in-repo paths
// (which workflows still populate locally as build inputs).
const BASELINE_CACHE_JSONL = join(ROOT, ".test262-cache", "test262-current.jsonl");
const CURRENT_RESULTS_JSONL = join(ROOT, "benchmarks", "results", "test262-current.jsonl");
const RESULTS_JSONL = join(ROOT, "benchmarks", "results", "test262-results.jsonl");
const OUTPUT_PATH = join(ROOT, "website", "public", "benchmarks", "results", "test262-editions.json");
// (#2910) Landing-page feature catalog + its reconciled row counts.
const FEATURE_EXAMPLES_PATH = join(ROOT, "website", "public", "feature-examples.json");
const FEATURE_T262_MAP_PATH = join(ROOT, "scripts", "feature-t262-features.json");
// The edition that is still a DRAFT — i.e. one year past the newest edition the
// ECMA General Assembly has ratified. ES2026 (17th edition) was published in
// June 2026, so the draft is now ES2027. Bumping this in lockstep with
// `T262_CURRENT_DRAFT_EDITION_YEAR` in website/components/t262-charts.js is the
// single intentional switch that promotes a draft year to a published notch on
// the landing-page timeline (see #1777).
const CURRENT_DRAFT_EDITION = 2027;

// ---------------------------------------------------------------------------
// Feature → Edition mapping (from issue #959 spec)
// ---------------------------------------------------------------------------

const FEATURE_EDITION: Record<string, number> = {
  // ES2015 (6)
  Symbol: 2015,
  generator: 2015,
  generators: 2015, // plural alias
  "arrow-function": 2015,
  class: 2015,
  "destructuring-binding": 2015,
  "destructuring-assignment": 2015,
  "for-of": 2015,
  let: 2015,
  const: 2015,
  "default-parameters": 2015,
  "rest-parameters": 2015,
  spread: 2015,
  "template-literal-revision": 2015,
  "computed-property-names": 2015,
  "shorthand-property": 2015,
  "tail-call-optimization": 2015,
  "cross-realm": 2015, // test helper for cross-realm object semantics (ES2015 era)
  Reflect: 2015,
  Proxy: 2015,
  Map: 2015,
  Set: 2015,
  WeakMap: 2015,
  WeakSet: 2015,
  Promise: 2015,
  TypedArray: 2015,
  "Symbol.iterator": 2015,
  "Symbol.toPrimitive": 2015,
  "Symbol.toStringTag": 2015,
  "Symbol.species": 2015,
  "Symbol.hasInstance": 2015,
  "Symbol.isConcatSpreadable": 2015,
  "Symbol.unscopables": 2015,
  "Reflect.construct": 2015,
  "Reflect.setPrototypeOf": 2015,
  "String.prototype.normalize": 2015,
  "String.fromCodePoint": 2015,
  "String.raw": 2015,
  "Number.EPSILON": 2015,
  "Number.isFinite": 2015,
  "Number.isInteger": 2015,
  "Number.isNaN": 2015,
  "Number.isSafeInteger": 2015,
  "Number.parseFloat": 2015,
  "Number.parseInt": 2015,
  "Math.imul": 2015,
  "Math.clz32": 2015,
  "Math.fround": 2015,
  "Math.log2": 2015,
  "Math.log10": 2015,
  "Math.sign": 2015,
  "Math.trunc": 2015,
  "Math.cbrt": 2015,
  "Math.expm1": 2015,
  "Math.log1p": 2015,
  "Math.sinh": 2015,
  "Math.cosh": 2015,
  "Math.tanh": 2015,
  "Math.acosh": 2015,
  "Math.asinh": 2015,
  "Math.atanh": 2015,
  "Math.hypot": 2015,
  "Array.from": 2015,
  "Array.of": 2015,
  "Array.prototype.fill": 2015,
  "Array.prototype.find": 2015,
  "Array.prototype.findIndex": 2015,
  "Array.prototype.copyWithin": 2015,
  "Array.prototype.entries": 2015,
  "Array.prototype.keys": 2015,
  "Array.prototype.values": 2015,
  DataView: 2015,
  ArrayBuffer: 2015,
  "Object.assign": 2015,
  "Object.is": 2015,
  "Object.setPrototypeOf": 2015,
  "Object.getOwnPropertySymbols": 2015,
  "DataView.prototype.setUint8": 2015,
  "DataView.prototype.getUint32": 2015,
  "DataView.prototype.getInt32": 2015,
  "DataView.prototype.getUint16": 2015,
  "DataView.prototype.getFloat32": 2015,
  "DataView.prototype.getInt16": 2015,
  "DataView.prototype.getInt8": 2015,
  "DataView.prototype.getFloat64": 2015,
  Int8Array: 2015,
  Uint8Array: 2015,
  "String.prototype.endsWith": 2015,
  "String.prototype.includes": 2015,
  "Symbol.match": 2015,
  "Symbol.replace": 2015,
  "Symbol.search": 2015,
  "Symbol.split": 2015,
  "new.target": 2015,
  super: 2015,
  template: 2015,

  // ES2016
  "Array.prototype.includes": 2016,
  exponentiation: 2016,
  u180e: 2016,

  // ES2017
  "async-functions": 2017,
  "Object.entries": 2017,
  "Object.values": 2017,
  "Object.getOwnPropertyDescriptors": 2017,
  SharedArrayBuffer: 2017,
  Atomics: 2017,
  "String.prototype.padStart": 2017,
  "String.prototype.padEnd": 2017,

  // ES2018
  "async-iteration": 2018,
  "regexp-dotall": 2018,
  "regexp-lookbehind": 2018,
  "regexp-named-groups": 2018,
  "regexp-unicode-property-escapes": 2018,
  "object-rest": 2018,
  "object-spread": 2018,
  "Promise.prototype.finally": 2018,
  "Symbol.asyncIterator": 2018,

  // ES2019
  "Array.prototype.flat": 2019,
  "Array.prototype.flatMap": 2019,
  "Object.fromEntries": 2019,
  "optional-catch-binding": 2019,
  "Symbol.prototype.description": 2019,
  "String.prototype.trimStart": 2019,
  "String.prototype.trimEnd": 2019,
  "well-formed-json-stringify": 2019,
  "stable-array-sort": 2019,
  "json-superset": 2019,
  "string-trimming": 2019,

  // ES2020
  BigInt: 2020,
  "Promise.allSettled": 2020,
  globalThis: 2020,
  "optional-chaining": 2020,
  "nullish-coalescing": 2020,
  "String.prototype.matchAll": 2020,
  "import.meta": 2020,
  "Promise.all": 2020,
  "for-in-order": 2020,
  "dynamic-import": 2020,
  "coalesce-expression": 2020,
  "export-star-as-namespace-from-module": 2020,
  "arbitrary-module-namespace-names": 2020,
  "Symbol.matchAll": 2020,

  // ES2021
  "Promise.any": 2021,
  "String.prototype.replaceAll": 2021,
  "logical-assignment-operators": 2021,
  "numeric-separator-literal": 2021,
  WeakRef: 2021,
  FinalizationRegistry: 2021,
  AggregateError: 2021,

  // ES2022
  "class-fields-public": 2022,
  "class-fields-private": 2022,
  "class-static-block": 2022,
  "top-level-await": 2022,
  "Array.prototype.at": 2022,
  "Object.hasOwn": 2022,
  "error-cause": 2022,
  "String.prototype.at": 2022,
  "TypedArray.prototype.at": 2022,
  "class-methods-private": 2022,
  "class-static-fields-public": 2022,
  "class-static-fields-private": 2022,
  "class-static-methods-private": 2022,
  "private-fields-in": 2022,
  "regexp-match-indices": 2022,
  "resizable-arraybuffer": 2022,

  // ES2023
  "array-find-from-last": 2023,
  "change-array-by-copy": 2023,
  hashbang: 2023,
  "Array.prototype.findLast": 2023,
  "Array.prototype.findLastIndex": 2023,
  "Array.prototype.toReversed": 2023,
  "Array.prototype.toSorted": 2023,
  "Array.prototype.toSpliced": 2023,
  "Array.prototype.with": 2023,
  ShadowRealm: 2023,

  // ES2024
  "ArrayBuffer.prototype.transfer": 2024,
  "regexp-v-flag": 2024,
  "Promise.withResolvers": 2024,
  "Object.groupBy": 2024,
  "Map.groupBy": 2024,
  "Atomics.waitAsync": 2024,
  "String.prototype.isWellFormed": 2024,
  "String.prototype.toWellFormed": 2024,
  "array-grouping": 2024,
  "arraybuffer-transfer": 2024,
  "promise-with-resolvers": 2024,
  "align-detached-buffer-semantics-with-web-reality": 2024,

  // ES2025 — the 10 proposals published in the 16th edition (June 2025).
  "set-methods": 2025,
  "iterator-helpers": 2025,
  "regexp-duplicate-named-groups": 2025,
  Float16Array: 2025,
  "Math.f16round": 2025,
  "import-defer": 2025,
  "source-phase-imports": 2025,
  "import-attributes": 2025,
  "json-modules": 2025,
  "regexp-modifiers": 2025,
  "Promise.try": 2025,
  "promise-try": 2025,
  "RegExp.escape": 2025,

  // ES2026 — the 7 proposals published in the 17th edition (June 2026).
  // Source of truth for the year is the "Expected Publication Year" column of
  // tc39/proposals `finished-proposals.md`, NOT the date test262 moved the tag
  // from its "Proposed" to its "Standard language features" section: that move
  // is a periodic housekeeping batch and lags ratification by a full edition
  // (e.g. `Array.fromAsync` is ES2026 but only moved on 2026-03-10, while the
  // 2026-07-02 batch was the ES2027 cohort).
  "Array.fromAsync": 2026,
  "Error.isError": 2026,
  "iterator-sequencing": 2026,
  "json-parse-with-source": 2026,
  "Math.sumPrecise": 2026,
  "uint8array-base64": 2026,
  upsert: 2026,

  // ES2027 — stage 4, ratified after the ES2026 cut-off, so still the DRAFT
  // edition (see CURRENT_DRAFT_EDITION). Not a published-edition claim.
  "Atomics.pause": 2027,
  "explicit-resource-management": 2027,
  "joint-iteration": 2027,
  Temporal: 2027,

  // Still stage-3 proposals. Records whose runner scope is `proposal` are
  // bucketed to -1 before edition classification ever runs; these entries only
  // catch a tagged test that arrives without that scope, and park it in the
  // draft tail rather than inflating a published edition.
  "immutable-arraybuffer": 2027,
  "await-dictionary": 2027,

  // Annex B. NOT draft-edition features — these are legacy web-compat surface
  // that has been in the spec for years. They are parked in the draft bucket
  // only to preserve the pre-#3639 behaviour of keeping them out of a published
  // edition's numerator; the `/annexB/` path heuristic below cannot reach them
  // because a `features:` tag wins at priority 3. Giving Annex B its own bucket
  // is follow-up work.
  caller: 2027,
  "legacy-regexp": 2027,
  IsHTMLDDA: 2027,
  __proto__: 2027,
  __getter__: 2027,
  __setter__: 2027,
};

// (#3639) Sentinels for buckets that are NOT editions. A test lands in one of
// these because its frontmatter carries no edition evidence — not because it
// was measured against that edition. They are deliberately named so no reader
// (or chart) mistakes them for a conformance figure, and they are excluded
// from the landing page's edition timeline the same way `Proposals` (-1) is.
const UNCLASSIFIED_LEGACY = -2; // frontmatter present, no edition marker at all
const UNCLASSIFIED_UNTAGGED = -3; // modern `esid:`, no edition-specific feature tag

const EDITION_NAMES: Record<number, string> = {
  5: "ES5",
  2015: "ES2015",
  2016: "ES2016",
  2017: "ES2017",
  2018: "ES2018",
  2019: "ES2019",
  2020: "ES2020",
  2021: "ES2021",
  2022: "ES2022",
  2023: "ES2023",
  2024: "ES2024",
  2025: "ES2025",
  2026: "ES2026",
  2027: "ES2027",
  [-1]: "Proposals",
  [UNCLASSIFIED_LEGACY]: "Unclassified (legacy)",
  [UNCLASSIFIED_UNTAGGED]: "Unclassified (untagged)",
};

const EDITION_ORDER = [
  5,
  2015,
  2016,
  2017,
  2018,
  2019,
  2020,
  2021,
  2022,
  2023,
  2024,
  2025,
  2026,
  2027,
  -1,
  UNCLASSIFIED_LEGACY,
  UNCLASSIFIED_UNTAGGED,
];

/**
 * (#2910) Map a landing-page edition label (as used in feature-examples.json's
 * `edition` field / the landing section headers) to its edition year, so a
 * feature row's population can be scoped to exactly the edition section it is
 * displayed under. Returns `undefined` for labels with no `features:` axis
 * (Legacy/Deprecated, npm libraries) — those rows stay headline-only.
 */
export function editionStringToYear(label: string): number | undefined {
  const s = label.trim();
  // (#3639) Legacy labels kept so feature-examples rows written before the
  // rename still resolve; they now map to the unclassified-legacy sentinel
  // rather than to a phantom "edition 0".
  if (s === "≤ ES3" || s === "ES3 / Core" || s === "ES3") return UNCLASSIFIED_LEGACY;
  if (s === "Unclassified (legacy)") return UNCLASSIFIED_LEGACY;
  if (s === "Unclassified (untagged)") return UNCLASSIFIED_UNTAGGED;
  if (s === "ES5") return 5;
  if (s === "Proposals") return -1;
  const m = /^ES(\d{4})$/.exec(s);
  if (m) return Number(m[1]);
  return undefined;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

interface Frontmatter {
  es5id?: string;
  es6id?: string;
  esid?: string;
  features?: string[];
  /** true when the file was readable but had no YAML frontmatter (legacy ES3/ES5 test) */
  noFrontmatter?: boolean;
}

/**
 * Read the head of a test file and parse YAML frontmatter.
 * Frontmatter is wrapped in slash-star --- ... --- star-slash markers.
 *
 * (#3626) The window used to be 2 KB. That silently mis-classified **4,220 of
 * 53,273** test262 files: when the frontmatter block ends past the window, the
 * closing-marker lookup returns -1, the file is recorded as `noFrontmatter` and
 * `classifyEdition` takes its "legacy pre-YAML test" branch → **ES5**. The
 * affected files are the procedurally generated ones with long `info:` blocks
 * (class/private-method `dstr`, dynamic-import, await-using, top-level-await),
 * so ES2015+ tests were being counted in the ES5 column — 4,144 of them.
 * Measured largest frontmatter end offset in the whole checkout: **6,180
 * bytes**; 64 KB is ~10x that with room for future growth. No pass/fail result
 * changes, only which edition column a test lands in.
 */
const FRONTMATTER_WINDOW_BYTES = 65536;

export function parseFrontmatter(filePath: string): Frontmatter {
  let content: string;
  try {
    const fd = readFileSync(filePath);
    content = fd.subarray(0, FRONTMATTER_WINDOW_BYTES).toString("utf-8");
  } catch {
    return {};
  }

  const start = content.indexOf("/*---");
  const end = content.indexOf("---*/");
  if (start === -1 || end === -1 || end <= start) return { noFrontmatter: true };

  const yaml = content.slice(start + 5, end);
  const result: Frontmatter = {};

  // es5id: 10.6-10-c-ii-2
  const es5 = yaml.match(/^\s*es5id:\s*(.+)$/m);
  if (es5) result.es5id = es5[1]!.trim();

  // es6id: 12.3.3.1.1
  const es6 = yaml.match(/^\s*es6id:\s*(.+)$/m);
  if (es6) result.es6id = es6[1]!.trim();

  // esid: sec-...
  const esid = yaml.match(/^\s*esid:\s*(.+)$/m);
  if (esid) result.esid = esid[1]!.trim();

  // features: [feat1, feat2] or multi-line list
  const featLine = yaml.match(/^\s*features:\s*(.+)$/m);
  if (featLine) {
    const raw = featLine[1]!.trim();
    if (raw.startsWith("[")) {
      // Inline: features: [Array.prototype.includes, exponentiation]
      const inner = raw.replace(/^\[|\]$/g, "");
      result.features = inner
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
    } else {
      // Multi-line YAML list: find following lines starting with "  - "
      const featIdx = yaml.indexOf("features:");
      const afterFeatures = yaml.slice(featIdx + "features:".length);
      const items: string[] = [];
      for (const line of afterFeatures.split("\n")) {
        const m = line.match(/^\s*-\s*(.+)$/);
        if (m) {
          items.push(m[1]!.trim());
        } else if (items.length > 0 && line.trim() !== "" && !line.match(/^\s*-/)) {
          break; // end of list
        }
      }
      if (items.length > 0) result.features = items;
    }
  }

  return result;
}

/**
 * Determine the ES edition year for a test file based on frontmatter.
 * Returns 5 for ES5, 2015..2025 for ES2015+, 0 for unknown.
 */
export function classifyEdition(fm: Frontmatter, filePath: string): number {
  // Priority 1: explicit es5id → ES5
  if (fm.es5id) return 5;

  // Priority 2: explicit es6id → ES2015
  if (fm.es6id) return 2015;

  // Priority 3: features → find highest edition year
  if (fm.features && fm.features.length > 0) {
    let max = 0;
    for (const feat of fm.features) {
      const yr = FEATURE_EDITION[feat];
      if (yr !== undefined && yr > max) max = yr;
    }
    if (max > 0) return max;
    // Default any remaining tagged feature to the current draft edition.
    // Proposal-only records are bucketed separately before standard-edition classification.
    return CURRENT_DRAFT_EDITION;
  }

  // Priority 4: path heuristics
  const norm = filePath.replace(/\\/g, "/");

  // Annex B tests are mostly ES5/ES3 material
  if (norm.includes("/annexB/")) return 5;
  if (norm.includes("/harness/")) return 5;

  // Tests in built-ins paths with known ES2015+ names
  if (norm.includes("/built-ins/Promise/")) return 2015;
  if (norm.includes("/built-ins/Proxy/")) return 2015;
  if (norm.includes("/built-ins/Reflect/")) return 2015;
  if (norm.includes("/built-ins/Symbol/")) return 2015;
  if (norm.includes("/built-ins/Map/")) return 2015;
  if (norm.includes("/built-ins/Set/")) return 2015;
  if (norm.includes("/built-ins/WeakMap/")) return 2015;
  if (norm.includes("/built-ins/WeakSet/")) return 2015;
  if (norm.includes("/built-ins/TypedArray")) return 2015;
  if (norm.includes("/built-ins/DataView/")) return 2015;
  if (norm.includes("/built-ins/ArrayBuffer/")) return 2015;
  if (norm.includes("/built-ins/SharedArrayBuffer/")) return 2017;
  if (norm.includes("/built-ins/Atomics/")) return 2017;
  if (norm.includes("/built-ins/BigInt/")) return 2020;
  if (norm.includes("/built-ins/WeakRef/")) return 2021;
  if (norm.includes("/built-ins/FinalizationRegistry/")) return 2021;

  // (#3639) `esid` is the MODERN frontmatter field — every new test262 file
  // carries one regardless of which edition specified the feature. Reading it
  // as "ES2015+" turned ES2015 into a catch-all: measured 2026-07-25, 5,436
  // tests arrived here by this fall-through versus only 2,990 via the real
  // `es6id` signal, i.e. ~60% of "ES2015" was sorted there by ACCIDENT. It
  // swept in all 347 `eval` tests, among much else.
  //
  // A bucket assigned by absence-of-evidence is not an edition measurement, so
  // it now reports as UNCLASSIFIED rather than borrowing ES2015's name. The
  // landing page treats any label it does not recognise as an edition scope
  // (see `t262IsEditionScope`) the way it already treats `Proposals` — shown,
  // but kept off the edition timeline.
  if (fm.esid) return UNCLASSIFIED_UNTAGGED;

  // Tests with no YAML frontmatter at all are old-style legacy tests (ES3/ES5 era).
  // They pre-date the YAML metadata format and live in language/ or built-ins/.
  if (fm.noFrontmatter) return 5;

  // Default: frontmatter present but carrying NO edition marker at all
  // (no es5id/es6id/features/esid) and no path heuristic matched.
  //
  // (#3639) This was labelled "≤ ES3", which invited reading it as an ES3
  // conformance measurement. It is not: it is a 273-test RESIDUE, and the ES3
  // language's own features are scored elsewhere by their frontmatter vintage
  // — `eval` (347 tests) sorts to the esid fall-through above, `with` (181)
  // and the `Function` constructor (509) carry `es5id` and sort to ES5. Those
  // are ES3 §15.1.2.1 / §12.10 / §15.3 and sit at ~37% combined, so "≤ ES3
  // 84%" was never a claim about ES3 support.
  return UNCLASSIFIED_LEGACY;
}

// ---------------------------------------------------------------------------
// Status normalisation
// ---------------------------------------------------------------------------

type StatusKey = "pass" | "fail" | "ce" | "skip";

function normalizeStatus(s: string): StatusKey {
  if (s === "pass") return "pass";
  if (s === "skip") return "skip";
  if (s === "compile_error" || s === "compile_timeout" || s === "ce") return "ce";
  return "fail";
}

// ---------------------------------------------------------------------------
// (#2910) Landing-page feature-row reconciliation
// ---------------------------------------------------------------------------

/**
 * (#2871 follow-up) Normalize a result record's `file` ("test/language/…/x.js") to the
 * path form the report page keys on. The page strips the leading "test/" when
 * it displays a file, so the per-file edition map uses the same stripped form.
 */
function stripTestPrefix(file: string): string {
  return file.replace(/^test\//, "");
}

/**
 * (#2871 follow-up) The runner's proposal-scope rules, for files the walk below
 * adds. A record carries the runner's own verdict (`scope_official === false`);
 * a file the lane never reported does not, so without this a Temporal or
 * staging test would be indexed as the draft edition and appear inside the
 * published range. Mirrors `classifyTestScope` / `PROPOSAL_FEATURES` in
 * tests/test262-runner.ts — that module is not importable here (it pulls in the
 * compiler), so keep the two in sync if the runner's list changes.
 */
const PROPOSAL_FEATURE_TAGS = new Set(["Temporal", "import-defer", "source-phase-imports"]);

function isProposalScopeByPath(relPath: string, features: string[] | undefined): boolean {
  if (relPath.startsWith("staging/")) return true;
  if (relPath.includes("built-ins/Temporal/")) return true;
  return (features ?? []).some((feature) => PROPOSAL_FEATURE_TAGS.has(feature));
}

/**
 * Every test file in the checkout, as "language/…/x.js"
 * paths. The per-file edition index is completed from this walk so it covers
 * tests that the lane being processed never reported — the standalone lane's
 * results are scored against the same index, and a file only IT reports would
 * otherwise have no edition and silently drop out of an edition-scoped count
 * (measured before this: 241 of one bucket's 4,547 failures).
 */
function walkTestFiles(testDir: string, prefix = ""): string[] {
  const out: string[] = [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(testDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkTestFiles(join(testDir, entry.name), rel));
    } else if (entry.name.endsWith(".js") && !entry.name.endsWith("_FIXTURE.js")) {
      out.push(rel);
    }
  }
  return out;
}

/** A test after edition classification, used to compute reconciled row counts. */
export interface ClassifiedTest {
  edition: number;
  features: string[];
  status: StatusKey;
}

export interface FeatureRowCount {
  pass: number;
  fail: number;
  ce: number;
  skip: number;
  total: number;
  pct: number;
}

/**
 * (#2910) Compute the landing-page feature-row pass/total counts from the SAME
 * per-test edition classification the section headline uses — the reconciled
 * replacement for the path-glob population of #2774.
 *
 * For each landing feature `F` (keyed by its feature-examples.json `name`):
 *   count(F) = | { tests classified into F's edition that carry ANY of F's
 *                  `features:` tags } |
 *
 * Because the population is scoped to F's own edition and selected by tag, it is
 * a strict SUBSET of that edition's headline population:
 *   - a test is counted at most once per feature (union across tags, not sum),
 *     so `total(F) ≤ edition total` — never the phantom path-glob count;
 *   - if the edition is 100% pass, every subset (row) is also 100%.
 *
 * @param tests               classified tests (only edition > 0 with tags matter)
 * @param featureTags         landing feature name → canonical test262 tag(s);
 *                            an empty array = intentional headline-only row
 * @param featureEditionYear  landing feature name → the edition YEAR it is shown
 *                            under (scopes the population to that section)
 */
export function computeFeatureRowCounts(
  tests: Iterable<ClassifiedTest>,
  featureTags: Record<string, string[]>,
  featureEditionYear: Record<string, number | undefined>,
): Record<string, FeatureRowCount> {
  // Index features by their edition year for O(candidates) matching per test.
  const byYear = new Map<number, Array<{ name: string; tags: Set<string> }>>();
  const acc: Record<string, { pass: number; fail: number; ce: number; skip: number }> = {};
  for (const [name, tags] of Object.entries(featureTags)) {
    acc[name] = { pass: 0, fail: 0, ce: 0, skip: 0 };
    const yr = featureEditionYear[name];
    if (yr === undefined || yr <= 0 || tags.length === 0) continue; // headline-only
    const arr = byYear.get(yr) ?? [];
    arr.push({ name, tags: new Set(tags) });
    byYear.set(yr, arr);
  }

  for (const t of tests) {
    const candidates = byYear.get(t.edition);
    if (!candidates || t.features.length === 0) continue;
    const testTags = new Set(t.features);
    for (const f of candidates) {
      let hit = false;
      for (const tag of f.tags) {
        if (testTags.has(tag)) {
          hit = true;
          break;
        }
      }
      if (hit) acc[f.name]![t.status]++;
    }
  }

  const out: Record<string, FeatureRowCount> = {};
  for (const [name, c] of Object.entries(acc)) {
    const total = c.pass + c.fail + c.ce + c.skip;
    out[name] = { ...c, total, pct: total > 0 ? Math.round((c.pass / total) * 100) : 0 };
  }
  return out;
}

/**
 * (#2914) Resolve a record's edition bucket key, honouring the host-free
 * (standalone) definition of "pass".
 *
 * In `--host-free` mode a raw `status === "pass"` that still leaked a JS host
 * runtime import (`host_import_leak_class` set) is NOT a standalone pass — it
 * only "passed" by pulling an `env::__*` import. This mirrors
 * `build-test262-report.mjs:844` (`hostFreePass = status === "pass" &&
 * !record.host_import_leak_class`) and `check-standalone-highwater.mjs`
 * (`full_summary.host_free_pass`), so the per-edition slider, the donut
 * headline (#2879) and the absolute floor (#2097) all share ONE definition of a
 * standalone pass. A leaky pass is demoted to `fail` (kept in `total`, dropped
 * from `pass`) — exactly how the donut counts it: in the denominator, out of
 * `host_free_pass`. The default (host / `gc`) mode is unchanged: host imports
 * are expected there, so a raw `pass` is counted.
 */
function resolveStatusKey(record: ResultRecord, hostFree: boolean): StatusKey {
  if (hostFree && record.status === "pass" && record.host_import_leak_class) {
    return "fail";
  }
  return normalizeStatus(record.status);
}

/**
 * (#1398) Derive a category path from a test file path. Mirrors the runner's
 * categorization (top two path segments after the leading `test/`), so the
 * resulting key matches `test262-report.json`'s `categories[].name`.
 *
 * Examples:
 *   "test/language/expressions/class/elements/foo.js" → "language/expressions"
 *   "test/built-ins/Array/prototype/push/length.js"  → "built-ins/Array"
 *   "test/annexB/built-ins/escape/length.js"          → "annexB/built-ins"
 */
function deriveCategoryFromFile(file: string): string {
  const parts = file.split("/");
  if (parts[0] === "test") parts.shift();
  // Two-segment grouping mirrors the existing runner output. The compiled
  // report joins these with `/`.
  if (parts.length >= 2) return parts.slice(0, 2).join("/");
  return parts[0] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface ResultRecord {
  file: string;
  status: string;
  scope?: string;
  scope_official?: boolean;
  category?: string;
  /**
   * (#2914) Present (a non-empty leak-class string) when a `pass` still pulled a
   * JS host `env::__*` runtime import. Written by the worker via
   * `metadataFromWorkerResult` and preserved in the standalone baseline JSONL.
   * Consumed here only in `--host-free` mode to exclude leaky passes.
   */
  host_import_leak_class?: string;
}

// #2910 — per-edition feature-tag slice. Each entry is the subset of the
// edition's headline population that carries this `features:` tag, so it is a
// strict subset of the edition (row total ≤ edition total; edition 100% ⇒ row
// 100%). The `name` is the canonical test262 feature tag.
interface FeatureSlice {
  name: string;
  pass: number;
  fail: number;
  ce: number;
  skip: number;
  total: number;
  pct: number;
}

interface EditionBucket {
  edition: string;
  pass: number;
  fail: number;
  ce: number;
  skip: number;
  total: number;
  pct: number;
  /** #2910 — feature-tag slices of this edition's population (frontmatter `features:`). */
  features?: FeatureSlice[];
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

async function main() {
  // Parse CLI args
  const args = process.argv.slice(2);
  const resultsPath =
    getArg(args, "--results") ??
    (existsSync(BASELINE_CACHE_JSONL)
      ? BASELINE_CACHE_JSONL
      : existsSync(CURRENT_RESULTS_JSONL)
        ? CURRENT_RESULTS_JSONL
        : RESULTS_JSONL);
  const outputPath = getArg(args, "--output") ?? OUTPUT_PATH;
  const test262Root = getArg(args, "--test262") ?? TEST262_ROOT;
  // (#2914) In host-free (standalone) mode, count a `pass` only when it emitted
  // no JS host runtime import — mirrors build-test262-report.mjs:844 so the
  // per-edition slider agrees with the standalone donut/floor. Accept either the
  // explicit `--host-free` flag or `--target standalone`.
  const hostFree = args.includes("--host-free") || getArg(args, "--target") === "standalone";

  if (!existsSync(join(test262Root, "test"))) {
    throw new Error(
      `Missing test262 checkout at ${test262Root}. Run 'git submodule update --init --recursive' before generating edition data.`,
    );
  }

  console.log(`Reading results from: ${resultsPath}`);
  console.log(`Reading test262 from: ${test262Root}`);
  console.log(
    `Pass definition: ${hostFree ? "host-free (standalone; excludes host_import_leak_class)" : "raw pass (host)"}`,
  );

  // Read all result records
  const lines = readFileSync(resultsPath, "utf-8").split("\n").filter(Boolean);

  // (#2913) Dedup duplicate result rows by `file` BEFORE bucketing. The merged
  // JSONL can carry >1 row per test (retry path / doubled shard artifact); with
  // no dedup the editions inherit the same double-count as the report builder.
  // Keep one row per file using a deterministic WORST-status precedence
  // (compile_error > fail > timeout/crash > pass > skip) so editions are stable
  // regardless of retry timing / row order. Mirrors build-test262-report.mjs.
  const EDITION_STATUS_PRECEDENCE: Record<string, number> = {
    compile_error: 6,
    compile_timeout: 6,
    fail: 5,
    timeout: 4,
    crash: 4,
    pass: 3,
    skip: 2,
  };
  const editionStatusRank = (s: string | undefined): number => (s ? EDITION_STATUS_PRECEDENCE[s] : undefined) ?? 1;
  const dedupedByFile = new Map<string, ResultRecord>();
  let editionDupDropped = 0;
  for (const line of lines) {
    let record: ResultRecord;
    try {
      record = JSON.parse(line) as ResultRecord;
    } catch {
      continue;
    }
    const key = record.file ?? `__nofile_${dedupedByFile.size}`;
    const prior = dedupedByFile.get(key);
    if (prior === undefined) {
      dedupedByFile.set(key, record);
    } else {
      editionDupDropped++;
      if (editionStatusRank(record.status) >= editionStatusRank(prior.status)) {
        dedupedByFile.set(key, record);
      }
    }
  }
  const dedupedRecords = [...dedupedByFile.values()];
  console.log(
    `Processing ${dedupedRecords.length} test results` +
      (editionDupDropped > 0 ? ` (#2913: dropped ${editionDupDropped} duplicate row(s) from ${lines.length})` : "") +
      "...",
  );

  // Initialise buckets
  const buckets: Record<number, { pass: number; fail: number; ce: number; skip: number }> = {};
  for (const yr of EDITION_ORDER) {
    buckets[yr] = { pass: 0, fail: 0, ce: 0, skip: 0 };
  }

  // (#1398) Per-category × per-edition buckets. Keyed by category path
  // (e.g. "test/language/expressions") then by edition year (e.g. 2022).
  // Used to populate `test262-category-editions.json` so the report's
  // category table can filter to a selected edition.
  const categoryBuckets: Record<string, Record<number, { pass: number; fail: number; ce: number; skip: number }>> = {};

  // (#2910) Per-edition × per-feature-tag buckets. Keyed by edition year then by
  // the canonical test262 `features:` tag. A test contributes to each of its
  // feature tags WITHIN its single assigned edition, so every slice is a strict
  // subset of that edition's headline population (row total ≤ edition total;
  // edition 100% ⇒ every row 100%). This is the reconciled row source for the
  // landing-page edition sections (replaces the path-glob population of #2774).
  const featureBuckets: Record<number, Record<string, { pass: number; fail: number; ce: number; skip: number }>> = {};
  // (#2871 follow-up) Per-FILE edition classification for the non-passing tests, written
  // to `test262-file-editions.json`. The report page's "Error Patterns" section
  // can only filter by category otherwise, which is far too coarse: nearly
  // every category contains at least one ES5 test, so selecting ES5 on the
  // slider left the list essentially unfiltered. Restricted to non-`pass`
  // records (that is all the error/skip views consume) to keep the artifact
  // ~1 MB instead of ~3 MB.
  const fileEditions: Record<string, string> = {};
  // Diagnostic: how many tests in each edition carry at least one `features:` tag.
  const taggedCounts: Record<number, number> = {};
  // (#2910) Every classified, tagged test — the input to computeFeatureRowCounts
  // which patches the landing-page feature-row counts in feature-examples.json.
  const taggedTests: ClassifiedTest[] = [];
  // Path-indexed pass/fail per classified test, for feature rows that predate
  // `features:` tags (Operators, typeof, delete, …). These are headline-only
  // under the tag map, but they carry precise `testCategories` paths, so we can
  // still score them by path prefix (see patchFeatureExamples).
  const pathTests: Array<{ file: string; status: StatusKey }> = [];

  let classified = 0;
  let unclassified = 0;
  let processed = 0;

  for (const record of dedupedRecords) {
    const { file, status } = record;
    if (!file || !status) continue;
    processed++;

    if (record.scope_official === false || record.scope === "proposal") {
      const proposalBucket = buckets[-1] ?? (buckets[-1] = { pass: 0, fail: 0, ce: 0, skip: 0 });
      proposalBucket[resolveStatusKey(record, hostFree)]++;
      fileEditions[stripTestPrefix(file)] = EDITION_NAMES[-1];
      unclassified++;
      continue;
    }

    // Build full path: file is like "test/language/..."
    const fullPath = join(test262Root, file);
    const fm = parseFrontmatter(fullPath);

    const edition = classifyEdition(fm, file);
    const key = resolveStatusKey(record, hostFree);

    // Every non-proposal standard test, indexed by file path (all editions),
    // so headline-only feature rows can be scored by their `testCategories`.
    pathTests.push({ file, status: key });

    // (#3639) The unclassified set is now explicit: the two absence-of-evidence
    // sentinels plus Proposals. Edition 0 no longer exists — it was the old
    // "≤ ES3" default and is now UNCLASSIFIED_LEGACY.
    if (edition === UNCLASSIFIED_LEGACY || edition === UNCLASSIFIED_UNTAGGED || edition === -1) unclassified++;
    else classified++;

    const bucket = buckets[edition] ?? (buckets[edition] = { pass: 0, fail: 0, ce: 0, skip: 0 });
    bucket[key]++;

    // (#2871 follow-up) Index this file's edition so the report's error-pattern
    // / skipped-test lists can filter per test rather than per category.
    // EVERY test is indexed, not just the host lane's failures: the standalone
    // root-cause map is scored against this same file (editions are a property
    // of the test's frontmatter, not of the compile target), and a test that
    // passes with a JS host but fails standalone must still resolve.
    fileEditions[stripTestPrefix(file)] = EDITION_NAMES[edition] ?? `ES${edition}`;

    // (#2910) Slice this test into per-edition per-feature-tag buckets. Only
    // standard editions (year > 0) carry feature rows on the landing page;
    // ≤ES3/ES5-era tests predate `features:` and are handled headline-only.
    if (edition > 0 && fm.features && fm.features.length > 0) {
      taggedCounts[edition] = (taggedCounts[edition] ?? 0) + 1;
      const dedupedTags = [...new Set(fm.features)];
      const tagMap = featureBuckets[edition] ?? (featureBuckets[edition] = {});
      // Dedup tags within a single test so a test that lists the same tag twice
      // is counted once per slice.
      for (const tag of dedupedTags) {
        const fb = tagMap[tag] ?? (tagMap[tag] = { pass: 0, fail: 0, ce: 0, skip: 0 });
        fb[key]++;
      }
      taggedTests.push({ edition, features: dedupedTags, status: key });
    }

    // (#1398) Also accumulate into per-category × per-edition buckets.
    // Use the JSONL `category` field if present (the runner sets it to the
    // top-level path prefix, e.g. "language/expressions"); fall back to
    // deriving from the file path.
    const category = record.category ?? deriveCategoryFromFile(file);
    if (category && edition !== 0 && edition !== -1) {
      const catMap = categoryBuckets[category] ?? (categoryBuckets[category] = {});
      const catBucket = catMap[edition] ?? (catMap[edition] = { pass: 0, fail: 0, ce: 0, skip: 0 });
      catBucket[key]++;
    }
  }

  // Build output array in edition order
  const output: EditionBucket[] = [];
  for (const yr of EDITION_ORDER) {
    const b = buckets[yr];
    if (!b) continue;
    const total = b.pass + b.fail + b.ce + b.skip;
    if (total === 0) continue; // skip empty buckets

    const name = EDITION_NAMES[yr] ?? `ES${yr}`;

    // (#2910) Build this edition's feature-tag slices, sorted by population
    // (largest first), dropping empty tags. Every slice is ⊆ this edition.
    const tagMap = featureBuckets[yr];
    let features: FeatureSlice[] | undefined;
    if (tagMap) {
      features = Object.entries(tagMap)
        .map(([tag, c]) => {
          const t = c.pass + c.fail + c.ce + c.skip;
          return {
            name: tag,
            pass: c.pass,
            fail: c.fail,
            ce: c.ce,
            skip: c.skip,
            total: t,
            pct: t > 0 ? Math.round((c.pass / t) * 100) : 0,
          };
        })
        .filter((f) => f.total > 0)
        .sort((a, b2) => b2.total - a.total || a.name.localeCompare(b2.name));
      if (features.length === 0) features = undefined;
    }

    output.push({
      edition: name,
      pass: b.pass,
      fail: b.fail,
      ce: b.ce,
      skip: b.skip,
      total,
      pct: total > 0 ? Math.round((b.pass / total) * 100) : 0,
      ...(features ? { features } : {}),
    });
  }

  // Write output
  writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nWrote ${output.length} edition buckets to: ${outputPath}`);
  console.log(`Classified: ${classified}, Unclassified: ${unclassified}`);
  console.log("\nResults:");
  for (const b of output) {
    console.log(
      `  ${b.edition.padEnd(8)} pass=${b.pass} fail=${b.fail} ce=${b.ce} skip=${b.skip} total=${b.total} (${b.pct}%)`,
    );
  }

  const accounted = output.reduce((sum, bucket) => sum + bucket.total, 0);
  if (accounted !== processed) {
    throw new Error(`Edition totals (${accounted}) do not match processed results (${processed}).`);
  }

  // (#2910) Feature-tag slice diagnostics + reconciliation invariants. Each
  // slice must be a strict subset of its edition (total ≤ edition total, pass ≤
  // edition pass), which structurally guarantees the acceptance property:
  // "section 100% ⇒ every feature row 100%".
  console.log("\nFeature-tag slices (per edition):");
  for (const b of output) {
    const nFeatures = b.features?.length ?? 0;
    const yr = EDITION_ORDER.find((y) => (EDITION_NAMES[y] ?? `ES${y}`) === b.edition);
    const tagged = yr !== undefined ? (taggedCounts[yr] ?? 0) : 0;
    console.log(`  ${b.edition.padEnd(8)} ${nFeatures} tag slice(s), ${tagged}/${b.total} tests carry a features: tag`);
    for (const f of b.features ?? []) {
      if (f.total > b.total) {
        throw new Error(
          `Feature slice ${b.edition}/${f.name} total ${f.total} exceeds edition total ${b.total} (not a subset).`,
        );
      }
      if (f.pass > b.pass) {
        throw new Error(
          `Feature slice ${b.edition}/${f.name} pass ${f.pass} exceeds edition pass ${b.pass} (not a subset).`,
        );
      }
      if (b.pass === b.total && f.pass !== f.total) {
        throw new Error(
          `Edition ${b.edition} is 100% but feature slice ${f.name} is ${f.pass}/${f.total} (reconciliation broken).`,
        );
      }
    }
  }

  // (#1398) Write the per-category × per-edition breakdown alongside the
  // overall per-edition output. The report's category table consumes this
  // to filter rows when an edition is selected on the timeline slider.
  //
  // Output shape:
  //   {
  //     "language/expressions": {
  //       "ES2022": { "pass": 42, "fail": 18, "ce": 3, "skip": 0 },
  //       "ES2015": { "pass": 10, "fail": 5,  "ce": 0, "skip": 0 }
  //     },
  //     ...
  //   }
  //
  // Only edition-classified buckets are emitted (year > 0); proposal-only
  // and unclassified records are dropped here since the slider only
  // operates on official edition rank.
  const categoryEditionOutput: Record<
    string,
    Record<string, { pass: number; fail: number; ce: number; skip: number }>
  > = {};
  for (const [category, byYear] of Object.entries(categoryBuckets)) {
    const yearMap: Record<string, { pass: number; fail: number; ce: number; skip: number }> = {};
    for (const [yr, counts] of Object.entries(byYear)) {
      const yearNum = Number(yr);
      if (yearNum <= 0) continue;
      const name = EDITION_NAMES[yearNum] ?? `ES${yearNum}`;
      yearMap[name] = counts;
    }
    if (Object.keys(yearMap).length > 0) {
      categoryEditionOutput[category] = yearMap;
    }
  }
  const categoriesPath = outputPath.replace(/test262-editions\.json$/, "test262-category-editions.json");
  if (categoriesPath !== outputPath) {
    writeFileSync(categoriesPath, JSON.stringify(categoryEditionOutput, null, 2) + "\n");
    console.log(`Wrote ${Object.keys(categoryEditionOutput).length} category × edition buckets to: ${categoriesPath}`);
  }

  // (#2871 follow-up) Per-file edition index. Shape:
  //   { "editions": ["ES5", "ES2015", …],
  //     "files": { "language/statements/for/x.js": 0, … } }
  // The edition label is stored as an index into `editions` purely to keep the
  // file small (~48k entries). Consumed by the report page's Error Patterns and
  // Skipped Tests sections so the edition slider filters per TEST, not per
  // category (a category-level filter is a near no-op: almost every category
  // contains at least one ES5 test), and by build-test262-report.mjs to give
  // each standalone root-cause bucket a per-edition count breakdown.
  const fileEditionsPath = outputPath.replace(/test262-editions\.json$/, "test262-file-editions.json");
  if (fileEditionsPath !== outputPath) {
    // Complete the index from the checkout so it covers every test, not only
    // the ones this lane reported. Records win where both exist — they carry
    // the proposal-scope verdict, which frontmatter alone cannot express.
    let fromWalk = 0;
    for (const file of walkTestFiles(join(test262Root, "test"))) {
      if (fileEditions[file] !== undefined) continue;
      const fm = parseFrontmatter(join(test262Root, "test", file));
      const edition = isProposalScopeByPath(file, fm.features) ? -1 : classifyEdition(fm, `test/${file}`);
      fileEditions[file] = EDITION_NAMES[edition] ?? `ES${edition}`;
      fromWalk++;
    }
    if (fromWalk > 0) console.log(`Indexed ${fromWalk} test file(s) not present in this lane's results.`);
    const editionLabels: string[] = [];
    const labelIndex = new Map<string, number>();
    const filesOut: Record<string, number> = {};
    for (const [file, label] of Object.entries(fileEditions)) {
      let idx = labelIndex.get(label);
      if (idx === undefined) {
        idx = editionLabels.push(label) - 1;
        labelIndex.set(label, idx);
      }
      filesOut[file] = idx;
    }
    writeFileSync(fileEditionsPath, JSON.stringify({ editions: editionLabels, files: filesOut }) + "\n");
    console.log(`Wrote ${Object.keys(filesOut).length} per-file edition entries to: ${fileEditionsPath}`);
  }

  // (#2910) Reconcile the landing-page feature-row counts with the edition
  // headline. Only on the DEFAULT host run (no --output / --feature-examples
  // override, i.e. the run that owns test262-editions.json + feature-examples
  // .json). The standalone run passes --output and is skipped, keeping the
  // host-lane feature counts intact.
  //
  // (#4362) …UNLESS it also passes `--feature-examples-out`, which reads the
  // host catalog and writes a SEPARATE standalone twin. Without a distinct out
  // path the standalone lane must stay skipped: patching in place would
  // overwrite the host counts with host-free ones and the landing page would
  // then show standalone numbers in BOTH toggle positions — the mirror image
  // of the bug this issue fixes.
  const featureExamplesPath = getArg(args, "--feature-examples") ?? FEATURE_EXAMPLES_PATH;
  const featureExamplesOut = getArg(args, "--feature-examples-out");
  const wantFeatureExamples =
    !args.includes("--no-feature-examples") &&
    (outputPath === OUTPUT_PATH || getArg(args, "--feature-examples") != null || featureExamplesOut != null);
  if (wantFeatureExamples) {
    patchFeatureExamples(featureExamplesPath, taggedTests, pathTests, featureExamplesOut);
  }
}

/**
 * (#2910) Rewrite `feature-examples.json`'s per-feature `passCount`/`totalCount`
 * so the landing-page edition rows are the reconciled, edition-sliced
 * `features:`-tag counts (a subset of each section's headline) instead of the
 * path-glob population of #2774. Curated example code + `testCategories`
 * (report links) are left untouched. Features not in the tag map — including
 * every ≤ES3 / ES5 / Legacy / Proposals row, which predate `features:` — are
 * set to 0/0 so the runtime treats them as headline-only (no phantom count).
 * Best-effort: a missing map or catalog leaves the file untouched.
 */
export function patchFeatureExamples(
  examplesPath: string,
  taggedTests: ClassifiedTest[],
  pathTests: Array<{ file: string; status: StatusKey }>,
  outPath?: string,
): void {
  if (!existsSync(examplesPath)) {
    console.warn(`[#2910] feature-examples not found at ${examplesPath} — skipping row reconciliation.`);
    return;
  }
  if (!existsSync(FEATURE_T262_MAP_PATH)) {
    console.warn(`[#2910] feature→tag map not found at ${FEATURE_T262_MAP_PATH} — skipping row reconciliation.`);
    return;
  }

  let examples: { features?: Array<Record<string, unknown>> };
  let rawMap: Record<string, unknown>;
  try {
    examples = JSON.parse(readFileSync(examplesPath, "utf-8"));
    rawMap = JSON.parse(readFileSync(FEATURE_T262_MAP_PATH, "utf-8"));
  } catch (e) {
    console.warn(`[#2910] could not parse feature data — skipping row reconciliation: ${(e as Error).message}`);
    return;
  }
  if (!Array.isArray(examples.features)) {
    console.warn(`[#2910] feature-examples has no features[] — skipping row reconciliation.`);
    return;
  }

  // Landing feature name → tags (drop the "_comment" and any non-array entry).
  const featureTags: Record<string, string[]> = {};
  for (const [name, tags] of Object.entries(rawMap)) {
    if (name.startsWith("_")) continue;
    if (Array.isArray(tags)) featureTags[name] = tags.map(String);
  }

  // Landing feature name → the edition YEAR it is displayed under (from the
  // catalog's `edition` label), used to scope each row's population.
  const featureEditionYear: Record<string, number | undefined> = {};
  for (const f of examples.features) {
    const nm = typeof f.name === "string" ? f.name : undefined;
    if (nm) featureEditionYear[nm] = editionStringToYear(typeof f.edition === "string" ? f.edition : "");
  }

  const rowCounts = computeFeatureRowCounts(taggedTests, featureTags, featureEditionYear);

  // Path-prefix scorer for feature rows that predate `features:` tags but carry
  // precise `testCategories` paths (Operators, typeof, delete, …). Normalize
  // each test's path once (strip leading "test/") so a row is scored by the
  // same paths its "View test results" link already points at.
  const normTests = pathTests.map((t) => ({
    f: t.file.startsWith("test/") ? t.file.slice(5) : t.file,
    s: t.status,
  }));
  const countByPaths = (prefixes: string[]): FeatureRowCount => {
    const acc: Record<StatusKey, number> = { pass: 0, fail: 0, ce: 0, skip: 0 };
    for (const t of normTests) {
      if (prefixes.some((p) => t.f === p || t.f.startsWith(p + "/"))) acc[t.s]++;
    }
    const total = acc.pass + acc.fail + acc.ce + acc.skip;
    return { ...acc, total, pct: total > 0 ? Math.round((acc.pass / total) * 100) : 0 };
  };

  let reconciled = 0;
  let pathScored = 0;
  let headlineOnly = 0;
  const unmapped: string[] = [];
  for (const f of examples.features) {
    const nm = typeof f.name === "string" ? f.name : "";
    if (nm && Object.prototype.hasOwnProperty.call(featureTags, nm)) {
      const c = rowCounts[nm]!;
      f.passCount = c.pass;
      f.totalCount = c.total;
      reconciled++;
    } else {
      // Not in the tag map. If the row carries `testCategories` paths, score it
      // by path prefix so core pre-`features:` rows still show a real number.
      // Rows with no paths stay headline-only (0/0).
      const paths = Array.isArray(f.testCategories)
        ? f.testCategories.filter((p): p is string => typeof p === "string" && p.length > 0)
        : [];
      if (paths.length > 0) {
        const c = countByPaths(paths);
        f.passCount = c.pass;
        f.totalCount = c.total;
        if (c.total > 0) pathScored++;
        else headlineOnly++;
      } else {
        f.passCount = 0;
        f.totalCount = 0;
        headlineOnly++;
      }
      const yr = editionStringToYear(typeof f.edition === "string" ? f.edition : "");
      if (yr !== undefined && yr >= 2015 && nm) unmapped.push(nm);
    }
  }

  const writePath = outPath ?? examplesPath;
  mkdirSync(dirname(writePath), { recursive: true });
  // (#4362) A twin written to a separate path is SLIM: only the fields the
  // landing page reads off the ACTIVE catalog (row identity, report links, and
  // the two counts). Everything else on a row — curated js/wat, the shiki
  // `jsHtml`/`watHtml`, and above all the per-row `tests[]` failure list — is
  // lane-independent and already present in the host catalog the page loads
  // anyway. Carrying it twice would ship a second ~4 MB file to every visitor
  // (the host catalog is ~4 MB, of which ~96% is `tests[]`) to convey ~10 KB of
  // differing numbers. In-place patching (no out path) still writes the whole
  // record, since there it IS the catalog.
  const payload = outPath
    ? {
        ...examples,
        features: examples.features.map((f) => ({
          name: f.name,
          testCategories: f.testCategories,
          passCount: f.passCount,
          totalCount: f.totalCount,
        })),
      }
    : examples;
  writeFileSync(writePath, JSON.stringify(payload, null, 2) + "\n");
  console.log(
    `\n[#2910] Reconciled feature-examples row counts: ${reconciled} tag-sliced, ${pathScored} path-scored, ${headlineOnly} headline-only → ${writePath}`,
  );
  if (unmapped.length > 0) {
    console.warn(
      `[#2910] ${unmapped.length} ES2015+ feature row(s) have no tag mapping (headline-only) — add them to scripts/feature-t262-features.json:`,
    );
    for (const n of unmapped) console.warn(`  - ${n}`);
  }
}

// Only run the generator when invoked directly (not when imported by tests).
const invokedDirectly = (() => {
  try {
    return process.argv[1] != null && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
