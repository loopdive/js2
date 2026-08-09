/**
 * A/B vacuity measurement, LOCAL-vs-LOCAL (same runner, same sample, same
 * process kind; only the harness differs).
 *
 * Arm A = stock upstream `test262/harness/propertyHelper.js`.
 * Arm B = same file with the vacuity detector spliced in (see
 *         `.tmp/vp/detector.patch.js` for the semantics).
 *
 * The instrumented harness is written to a SCRATCH copy of the harness dir and
 * selected via the `JS2WASM_VP_HARNESS` env var, which `.tmp/vp/ab.mts` reads
 * itself — nothing in committed compiler/runner code is touched.
 *
 * Usage:
 *   npx tsx .tmp/vp/ab.mts calibrate            # positive/negative controls
 *   npx tsx .tmp/vp/ab.mts armA <n> <seed>      # stock run over the sample
 *   npx tsx .tmp/vp/ab.mts armB                 # detector run over armA passes
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dirname!;
const WT = join(HERE, "..", "..", ".."); // repo/worktree root (plan/probes/3603/..)
// The worktree's test262/ is a symlink FARM into the shared /workspace/test262.
// Swap only THIS worktree's `harness` link for a private real copy so the
// instrumented harness is invisible to every other agent's runs. Restored by
// restoreHarnessLink() on every exit path.
const WT_HARNESS_DIR = join(WT, "test262", "harness");
const SHARED_HARNESS = process.env.VP_SHARED_HARNESS ?? "/workspace/test262/harness";
const HARNESS = join(WT_HARNESS_DIR, "propertyHelper.js");
const BACKUP = join(HERE, "propertyHelper.stock.js");
const T262 = join(WT, "test262", "test");

function privatiseHarness(): void {
  if (lstatSync(WT_HARNESS_DIR).isSymbolicLink()) {
    if (!existsSync(BACKUP)) cpSync(join(SHARED_HARNESS, "propertyHelper.js"), BACKUP);
    rmSync(WT_HARNESS_DIR);
    cpSync(SHARED_HARNESS, WT_HARNESS_DIR, { recursive: true });
  }
}

function restoreHarnessLink(): void {
  if (!existsSync(WT_HARNESS_DIR)) {
    symlinkSync(SHARED_HARNESS, WT_HARNESS_DIR);
    return;
  }
  if (!lstatSync(WT_HARNESS_DIR).isSymbolicLink()) {
    rmSync(WT_HARNESS_DIR, { recursive: true, force: true });
    symlinkSync(SHARED_HARNESS, WT_HARNESS_DIR);
  }
}
process.on("exit", restoreHarnessLink);

// ── 1. build the instrumented harness text ──────────────────────────────────
function instrument(src: string, withThrows = true): string {
  let out = src;
  const before = out;
  // Two independent detectors, because the two lanes fail DIFFERENTLY:
  //   __vpChecks === 0   -> standalone mode: not one descriptor-field check ran
  //   __vpFailMsg !== "" -> host mode: a check ran and FOUND a mismatch, but the
  //                         accumulate-and-report path (__push/__join) swallowed
  //                         it. Recorded in a plain module var, bypassing both.
  out = out.replace(
    "var failures = [];",
    "var failures = [];\n  var __vpChecks = 0;\n  __vpFailMsg = \"\";",
  );
  if (out === before) throw new Error("splice point 'var failures = []' not found");
  out = 'var __vpFailMsg = "";\nfunction __vpPush(f, m) { __vpFailMsg = "MISMATCH"; }\n' + out;
  const pushes = out.split("__push(failures,").length - 1;
  if (pushes !== 5) throw new Error(`expected 5 __push(failures, …) sites, found ${pushes}`);
  out = out.split("__push(failures,").join("__vpPush(failures,");

  // Four guarded blocks: add the counter bump as the first statement of each.
  const guards = [
    "if (__hasOwnProperty(desc, 'value')) {",
    "if (__hasOwnProperty(desc, 'enumerable') && desc.enumerable !== undefined) {",
    "if (__hasOwnProperty(desc, 'writable') && desc.writable !== undefined) {",
    "if (__hasOwnProperty(desc, 'configurable') && desc.configurable !== undefined) {",
  ];
  for (const g of guards) {
    if (!out.includes(g)) throw new Error(`guard not found: ${g}`);
    out = out.replace(g, `${g}\n    __vpChecks += 1;`);
  }

  const tail = "  if (failures.length) {";
  if (!out.includes(tail)) throw new Error("tail splice point not found");
  // Arm A2 = the ATTRIBUTION CONTROL: every structural edit above (counter,
  // __vpPush replacing __push, the module var) but NO detector throw. If A2
  // reproduces arm A's verdicts, the arm-B flips are attributable to the
  // detector firing and not to the instrumentation perturbing compilation.
  if (!withThrows) return out;
  out = out.replace(
    tail,
    "  if (__vpChecks === 0) {\n" +
      "    throw new Test262Error('VACUOUS_VERIFYPROPERTY_NO_CHECKS ' + nameStr);\n" +
      "  }\n" +
      '  if (__vpFailMsg !== "") {\n' +
      "    throw new Test262Error('VACUOUS_VERIFYPROPERTY_SWALLOWED ' + nameStr);\n" +
      "  }\n" +
      tail,
  );
  return out;
}

function useArm(arm: "A" | "A2" | "B"): void {
  privatiseHarness();
  const stock = readFileSync(BACKUP, "utf8");
  writeFileSync(HARNESS, arm === "A" ? stock : instrument(stock, arm === "B"));
}

// ── 2. sample ────────────────────────────────────────────────────────────────
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(n: number, seed: number): string[] {
  const all = readFileSync(join(HERE, "vp-files.txt"), "utf8").trim().split("\n");
  const rnd = mulberry32(seed);
  const idx = all.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx.slice(0, n).map((i) => all[i]!);
}

// ── 3. run ───────────────────────────────────────────────────────────────────
const mode = process.argv[2] ?? "calibrate";

if (mode === "calibrate") {
  // Positive control: a verifyProperty that PASSES stock on standalone must
  // FAIL under the detector. Negative control: the host lane must not fire.
  mkdirSync(join(HERE, "cal"), { recursive: true });
  const file = join(HERE, "cal", "positive-control.js");
  writeFileSync(
    file,
    `/*---
description: positive control for the vacuity detector
includes: [propertyHelper.js]
flags: [noStrict]
---*/
verifyProperty(Math.abs, "name", { value: "abs", writable: false, enumerable: false, configurable: true });
`,
  );
  const neg = join(HERE, "cal", "negative-control.js");
  writeFileSync(
    neg,
    `/*---
description: negative control - a real check must still run
includes: [propertyHelper.js]
flags: [noStrict]
---*/
var o = {};
Object.defineProperty(o, "a", { value: 1, writable: true, enumerable: true, configurable: true });
verifyProperty(o, "a", { value: 1, writable: true, enumerable: true, configurable: true });
`,
  );
  // One arm per PROCESS: test262-original-harness.ts caches harness sources in
  // a module-level Map, so swapping the file mid-process would silently reuse
  // the first arm's text.
  const arm = (process.argv[3] === "B" ? "B" : "A") as "A" | "B";
  useArm(arm);
  const { runTest262File } = await import("../../../tests/test262-runner.ts");
  // Host-lane positive control: a WRONG value expectation. Stock = pass
  // (vacuous, __push swallows the failure); detector must fail.
  const posHost = join(HERE, "cal", "positive-control-host.js");
  writeFileSync(
    posHost,
    `/*---
description: host-lane positive control - wrong value expectation
includes: [propertyHelper.js]
flags: [noStrict]
---*/
var o = { a: 1 };
verifyProperty(o, "a", { value: 42, writable: true, enumerable: true, configurable: true });
`,
  );
  for (const [label, f] of [
    ["positive", file],
    ["posthost", posHost],
    ["negative", neg],
  ] as const) {
    for (const lane of [undefined, "standalone"] as const) {
      const r = await runTest262File(f, "probe", 30000, lane);
      console.log(
        `arm${arm} ${label.padEnd(8)} lane=${(lane ?? "host").padEnd(10)} ${r.status.padEnd(13)} ${String((r as any).error ?? "").slice(0, 110)}`,
      );
    }
  }
  restoreHarnessLink();
  process.exit(0);
}

if (mode === "armA" || mode === "armB" || mode === "armA2") {
  const arm = mode === "armA" ? "A" : mode === "armA2" ? "A2" : "B";
  useArm(arm as "A" | "A2" | "B");
  const { runTest262File } = await import("../../../tests/test262-runner.ts");
  const lane = (process.env.VP_LANE === "host" ? undefined : "standalone") as "standalone" | undefined;
  let files: string[];
  if (arm === "A") {
    files = sample(Number(process.argv[3] ?? 600), Number(process.argv[4] ?? 20260725));
  } else {
    files = readFileSync(join(HERE, `armA-${lane ?? "host"}-pass.txt`), "utf8").trim().split("\n").filter(Boolean);
  }
  const out: string[] = [];
  const passes: string[] = [];
  let i = 0;
  for (const rel of files) {
    i++;
    let status = "ERROR";
    let err = "";
    try {
      const r = await runTest262File(join(T262, rel), rel.split("/")[0]!, 30000, lane);
      status = r.status;
      err = String((r as any).error ?? "");
    } catch (e) {
      err = String(e).slice(0, 200);
    }
    if (status === "pass") passes.push(rel);
    out.push(`${status}\t${rel}\t${err.replace(/\s+/g, " ").slice(0, 200)}`);
    if (i % 25 === 0) process.stderr.write(`  ${i}/${files.length}\n`);
  }
  writeFileSync(join(HERE, `${mode}-${lane ?? "host"}.tsv`), out.join("\n") + "\n");
  if (arm === "A") writeFileSync(join(HERE, `armA-${lane ?? "host"}-pass.txt`), passes.join("\n") + "\n");
  restoreHarnessLink();
  const tally: Record<string, number> = {};
  for (const line of out) tally[line.split("\t")[0]!] = (tally[line.split("\t")[0]!] ?? 0) + 1;
  console.log(mode, "lane=", lane ?? "host", "n=", files.length, JSON.stringify(tally));
  process.exit(0);
}

console.log("unknown mode", mode);
process.exit(1);
