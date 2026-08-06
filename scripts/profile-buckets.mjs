// Bucket a V8 .cpuprofile of a compiled standalone module by self-time (#4157).
//
// Usage:
//   node scripts/profile-buckets.mjs <file.cpuprofile> [closure-map.log] [topN] [--detail] [--callers=NAME]
//
// The .cpuprofile comes from the npm-compat report generator's profiling mode,
// e.g. for the acorn standalone runtime-dynamic lane:
//
//   npx tsx scripts/generate-npm-compat-report.mjs --only acorn --no-write \
//     --perf-only --lane standalone-dynamic --preserve-debug-names \
//     --profile-runtime wasm --profile-output .tmp/acorn.cpuprofile \
//     --profile-iterations 300 2> .tmp/closure-map.log
//
// The optional closure-map.log is the stderr of a compile run with
// `JS2WASM_CLOSURE_NAME_MAP=1` (see src/codegen/closures.ts): it maps the
// opaque emitted `__closure_N` names (and their `__typed_this` twins) back to
// the source functions they were lifted from, so hot compiled-package frames
// are readable. Passing the SAME lane invocation's stderr (as above) guarantees
// the ids match the profiled binary.
//
// Buckets:
//   gc-engine       V8 GC / engine frames
//   dynamic-lookup  __extern_get + per-key __get_member_*/__set_member_* +
//                   open-object hash helpers (the #3926 territory)
//   call-dispatch   generic call dispatchers + direct-call trampolines
//   dynamic-eq      __extern_strict_eq / __is_truthy / nullish tests
//   cast-convert    boxing, unboxing, ToPrimitive, any<->extern conversions
//   regexp          regex engine + .test dispatch
//   string-runtime  __str_* rope/compare/slice helpers
//   alloc-helpers   fnctor constructors + vector helpers
//   scanner         compiled package code matching the tokenizer-name heuristic
//   compiled        remaining compiled package code
//   other-runtime   remaining __-prefixed runtime helpers
//   js-host         JS frames (host driver, node internals)
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const positional = args.filter((a) => !a.startsWith("--"));
const [profilePath, mapPath] = positional[1]?.endsWith(".cpuprofile")
  ? [positional[0], undefined]
  : [positional[0], positional[1] && Number.isNaN(Number(positional[1])) ? positional[1] : undefined];
const topN = Number(positional.find((a, i) => i > 0 && !Number.isNaN(Number(a))) ?? 25);
if (!profilePath) {
  console.error(
    "usage: node scripts/profile-buckets.mjs <file.cpuprofile> [closure-map.log] [topN] [--detail] [--callers=NAME]",
  );
  process.exit(2);
}
const profile = JSON.parse(readFileSync(profilePath, "utf-8"));

const closureMap = new Map();
if (mapPath) {
  for (const line of readFileSync(mapPath, "utf-8").split("\n")) {
    const m = line.match(/\[js2:closure-map\] (__closure_\d+) <- (\S+) @(\d+)/);
    if (m) closureMap.set(m[1], m[2]);
  }
}

function displayName(raw) {
  const m = raw.match(/^(__closure_\d+)(__typed_this)?$/);
  if (!m) return raw;
  const mapped = closureMap.get(m[1]);
  return mapped ? `${mapped}${m[2] ?? ""} [${m[1]}]` : raw;
}

// Tokenizer/scanner method names (tuned for acorn's dist bundle; harmless
// elsewhere — unmatched compiled code just lands in "compiled").
const SCANNER_RE =
  /\.(next|getToken\w*|nextToken|read\w+|skip\w+|finishToken|finishOp|fullCharCodeAt|curContext|updateContext|initialContext|inGeneratorContext|overrideContext|codePointToString|currentPos|curPosition)(__typed_this)? \[/;

function classify(raw, name) {
  if (/^\((garbage collector|program|idle|root)\)/.test(raw)) return "gc-engine";
  if (
    /^(__extern_(get|set|in|has|delete|keys)|__get_member|__set_member|__obj_(find|hash)|__method_cache_lookup)/.test(
      raw,
    )
  )
    return "dynamic-lookup";
  if (
    /^(__extern_method_call|__call_fn_method|__call_m_(?!test)|__dc_|__named_this_call|__apply_closure|__builtinfn_get_meta|__call_function)/.test(
      raw,
    )
  )
    return "call-dispatch";
  if (/^(__extern_(strict_)?eq|__host_(eq|compare)|__is_truthy|__typeof|__extern_is_nullish)/.test(raw))
    return "dynamic-eq";
  if (
    /^(__box_|__unbox_|__to_primitive|__to_number|__to_int32|__to_uint32|__any_(from|to|unbox)_|__coerce|__number_to)/.test(
      raw,
    )
  )
    return "cast-convert";
  if (/^(__regex|__call_m_test|__regexp)/.test(raw)) return "regexp";
  if (/^(__str_|__string|__char|__code_point)/.test(raw)) return "string-runtime";
  if (/^(__fnctor_\w+_new|__alloc|__argvec|__vec_|__objvec)/.test(raw)) return "alloc-helpers";
  if (/^__closure_/.test(raw)) return SCANNER_RE.test(name) ? "scanner" : "compiled";
  if (/^__/.test(raw)) return "other-runtime";
  if (raw.startsWith("[js] ") || raw === "(anonymous)") return "js-host";
  // Named wasm functions from the package source (finishNodeAt, getOptions, ...)
  return "compiled";
}

const totalSamples = profile.nodes.reduce((sum, node) => sum + (node.hitCount ?? 0), 0);
const totalMicros = profile.endTime - profile.startTime;

const byName = new Map();
for (const node of profile.nodes) {
  const hits = node.hitCount ?? 0;
  if (!hits) continue;
  const cf = node.callFrame;
  const isWasm = (cf.url ?? "").startsWith("wasm:");
  let raw = cf.functionName || "(anonymous)";
  if (!isWasm && !raw.startsWith("(")) raw = `[js] ${raw}`;
  const entry = byName.get(raw) ?? { raw, hits: 0 };
  entry.hits += hits;
  byName.set(raw, entry);
}

const frames = [...byName.values()].sort((a, b) => b.hits - a.hits);
const buckets = new Map();
for (const frame of frames) {
  frame.name = displayName(frame.raw);
  frame.bucket = classify(frame.raw, frame.name);
  buckets.set(frame.bucket, (buckets.get(frame.bucket) ?? 0) + frame.hits);
}

const pct = (hits) => ((hits / totalSamples) * 100).toFixed(2).padStart(6);
console.log(`profile: ${profilePath}`);
console.log(`total: ${(totalMicros / 1000).toFixed(0)} ms wall, ${totalSamples} samples\n`);

console.log(`top ${topN} frames by self time:`);
console.log("self%   cum%    bucket           name");
let cum = 0;
for (const frame of frames.slice(0, topN)) {
  cum += frame.hits;
  console.log(`${pct(frame.hits)}  ${pct(cum)}  ${frame.bucket.padEnd(15)}  ${frame.name}`);
}

console.log("\nbucket totals (self time):");
for (const [bucket, hits] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${pct(hits)}%  ${bucket}`);
}

if (flags.includes("--detail")) {
  for (const [bucket] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`\n== ${bucket}`);
    for (const frame of frames.filter((f) => f.bucket === bucket).slice(0, 25)) {
      console.log(`${pct(frame.hits)}  ${frame.name}`);
    }
  }
}

// --callers=__extern_get: attribute a frame's self hits to its nearest
// distinct ancestor, answering "who pays for this helper".
const callersFlag = flags.find((f) => f.startsWith("--callers="));
if (callersFlag) {
  const target = callersFlag.slice("--callers=".length);
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parentOf = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);
  const callers = new Map();
  let targetHits = 0;
  for (const n of profile.nodes) {
    if (n.callFrame.functionName !== target) continue;
    const hits = n.hitCount ?? 0;
    if (!hits) continue;
    targetHits += hits;
    let pid = parentOf.get(n.id);
    let parentName = "(root)";
    while (pid) {
      const pn = byId.get(pid);
      if (pn.callFrame.functionName !== target) {
        parentName = pn.callFrame.functionName;
        break;
      }
      pid = parentOf.get(pid);
    }
    callers.set(parentName, (callers.get(parentName) ?? 0) + hits);
  }
  console.log(`\ncallers of ${target} (self ${pct(targetHits)}%):`);
  for (const [name, hits] of [...callers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`${pct(hits)}  ${displayName(name)}`);
  }
}
