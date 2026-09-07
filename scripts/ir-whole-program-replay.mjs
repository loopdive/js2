// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3518 package C — fresh-process replay of an encoded PreparedIrProgram.
//
//   node --import tsx scripts/ir-whole-program-replay.mjs <encoded.json> <oracle.json> [--probe-forbidden-import]
//
// oracle.json: { "targets": [{ "backend", "target" }], "calls": [{ "export", "args", "expected" }] }
//
// Schema (validated BEFORE the program is touched; violations exit 2):
//   - targets: nonempty, unique backend/target pairs; backend ∈ {wasmgc, linear};
//     target ∈ the actual RuntimeTarget set {host, strict-no-host, standalone, wasi}
//     (artifact target labels are a different domain and are not accepted here)
//   - calls: nonempty; each names an export string, an args array of finite
//     numbers, and an `expected` value in the exact oracle-value domain: JSON
//     null / boolean / string / finite non-negative-zero number, or a single-key
//     tag {"$bigint": "<canonical decimal>"} | {"$number": "-0"|"NaN"|"Infinity"|"-Infinity"}.
//     A malformed value is a schema refusal, never a mismatch.
//
// The child decodes the bytes through the complete (re-authenticating) decode,
// accepts and emits the SAME decoded object for every requested backend/target
// through the consumer's one-argument emission, instantiates each module and
// compares the program's own declared exports (functions called, globals read)
// with the pinned oracle.
//
// Module boundary. A `node:module` resolve hook appends one line per
// resolution — `{url, parent}` — synchronously to a census file BEFORE the
// resolution result is returned to the importing thread. Every module this
// process loads is therefore on disk before the import that loaded it settles,
// so reading the file after the last await is a deterministic handshake: no
// timer, no "late" records. The census must contain the codec itself and no
// TypeScript library, `ts-api`, source frontend, checker, compiler, or frontend
// producer module. `--probe-forbidden-import` deliberately imports the
// TypeScript shim after the replay so the boundary check can be shown to fail
// closed.
//
// Exit 0 only when every target accepted, emitted a nonzero number of bodies
// whose receipts equal both the projection's physical functions and the
// module's owned functions (the startup adapter is identified by construction
// ownership, never by name), every oracle row matched, and the boundary held.
// Any other outcome — including a physical capability gap — exits 1.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FRONTEND_MODULES = [
  /\/src\/ir\/from-ast\./,
  /\/src\/compiler\./,
  /\/src\/checker\//,
  /\/src\/index\./,
  /\/src\/codegen\/index\./,
  /\/src\/codegen-linear\/index\./,
  /\/src\/ir\/async-from-ast\./,
  /\/src\/ir\/async-prepare\./,
  /\/src\/ir\/runtime-program-producers\./,
  /\/src\/ir\/program-source\./,
  /\/src\/ir\/program-preparation\./,
];
const TYPESCRIPT_MODULES = [/\/node_modules\/typescript\//, /\/node_modules\/typescript7\//, /\/src\/ts-api\./];

const censusDir = mkdtempSync(join(tmpdir(), "ir-whole-program-census-"));
const censusFile = join(censusDir, "modules.jsonl");
register(
  `data:text/javascript,${encodeURIComponent(`
    import { appendFileSync } from "node:fs";
    let file;
    export function initialize(data) { file = data.file; }
    export async function resolve(specifier, context, next) {
      const result = await next(specifier, context);
      appendFileSync(file, JSON.stringify({ url: result.url, parent: context.parentURL ?? null }) + "\\n");
      return result;
    }
  `)}`,
  { parentURL: import.meta.url, data: { file: censusFile } },
);

const args = process.argv.slice(2);
const probeForbiddenImport = args.includes("--probe-forbidden-import");
const [encodedPath, oraclePath] = args.filter((arg) => !arg.startsWith("--"));

const report = {
  digest: undefined,
  reencodedIdentical: false,
  decodeFailure: undefined,
  oracle: undefined,
  targets: {},
  loadedModuleCount: 0,
  frontendModules: [],
  typescriptModules: [],
  failures: [],
  ok: false,
};
const fail = (why) => {
  report.failures.push(why);
};
const finish = (code) => {
  report.ok = report.failures.length === 0 && code === 0;
  process.stdout.write(`${JSON.stringify(report)}\n`);
  rmSync(censusDir, { recursive: true, force: true });
  process.exit(code);
};

if (!encodedPath || !oraclePath) {
  console.error(
    "usage: node --import tsx scripts/ir-whole-program-replay.mjs <encoded.json> <oracle.json> [--probe-forbidden-import]",
  );
  fail("usage");
  finish(2);
}

// The value-domain validator is the same one the in-process comparison uses.
const { compareExports, oracleValueProblem, replayOptions, replayProgram, RUNTIME_BACKENDS, RUNTIME_TARGETS } =
  await import("../tests/helpers/ir-whole-program-replay.ts");

function validateOracle(raw) {
  const problems = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return ["oracle must be a JSON object"];
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) problems.push("oracle.targets must be a nonempty array");
  else {
    const seen = new Set();
    raw.targets.forEach((target, index) => {
      if (
        target === null ||
        typeof target !== "object" ||
        typeof target.backend !== "string" ||
        typeof target.target !== "string"
      ) {
        problems.push(`oracle.targets[${index}] must name backend and target strings`);
        return;
      }
      if (!RUNTIME_BACKENDS.includes(target.backend))
        problems.push(`oracle.targets[${index}].backend ${target.backend} is not a known backend`);
      if (!RUNTIME_TARGETS.includes(target.target))
        problems.push(
          `oracle.targets[${index}].target ${target.target} is not a RuntimeTarget (${RUNTIME_TARGETS.join(", ")})`,
        );
      const key = `${target.backend}:${target.target}`;
      if (seen.has(key)) problems.push(`oracle.targets repeats ${key}`);
      seen.add(key);
    });
  }
  if (!Array.isArray(raw.calls) || raw.calls.length === 0) problems.push("oracle.calls must be a nonempty array");
  else {
    raw.calls.forEach((call, index) => {
      if (call === null || typeof call !== "object" || Array.isArray(call)) {
        problems.push(`oracle.calls[${index}] must be an object`);
        return;
      }
      if (typeof call.export !== "string" || call.export.length === 0)
        problems.push(`oracle.calls[${index}].export must be a nonempty string`);
      if (!Array.isArray(call.args) || !call.args.every((arg) => typeof arg === "number" && Number.isFinite(arg))) {
        problems.push(`oracle.calls[${index}].args must be an array of finite numbers`);
      }
      if (!Object.hasOwn(call, "expected")) problems.push(`oracle.calls[${index}] lacks an expected value`);
      else {
        const problem = oracleValueProblem(call.expected);
        if (problem) problems.push(`oracle.calls[${index}].expected is malformed: ${problem}`);
      }
    });
  }
  return problems;
}

let oracle;
try {
  oracle = JSON.parse(readFileSync(oraclePath, "utf8"));
} catch (error) {
  fail(`oracle is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  finish(2);
}
const oracleProblems = validateOracle(oracle);
report.oracle = { targets: oracle?.targets?.length ?? 0, calls: oracle?.calls?.length ?? 0, problems: oracleProblems };
if (oracleProblems.length > 0) {
  for (const problem of oracleProblems) fail(problem);
  finish(2);
}

// --- replay ---
try {
  const { decodePreparedIrProgram, digestEncodedPreparedIrProgram, encodePreparedIrProgram } =
    await import("../src/ir/program-codec.ts");
  const { emittedStartupAdapterIndex } = await import("../src/ir/program-consumer.ts");

  const text = readFileSync(encodedPath, "utf8");
  report.digest = digestEncodedPreparedIrProgram(text);
  const program = decodePreparedIrProgram(text);
  report.reencodedIdentical = encodePreparedIrProgram(program) === text;
  if (!report.reencodedIdentical) fail("decoded program does not re-encode to the input bytes");

  for (const { backend, target } of oracle.targets) {
    const key = `${backend}:${target}`;
    try {
      const outcome = await replayProgram(program, replayOptions(backend, target));
      if (outcome.kind === "not-accepted") {
        report.targets[key] = { kind: "not-accepted", failure: outcome.failure };
        fail(`${key}: not accepted (${outcome.failure.kind} ${outcome.failure.code}: ${outcome.failure.detail})`);
        continue;
      }
      const { run } = outcome;
      const rows = compareExports(run.exports, oracle.calls);
      const receipts = run.emitted.emittedUnitIds;
      const projection = run.accepted.runtime.prepared.functions.map((fn) => fn.unitId);
      const adapterIndex = emittedStartupAdapterIndex(run.emitted);
      const importedFunctions = run.emitted.module.imports.filter((entry) => entry.desc.kind === "func").length;
      const ownedFunctions = run.emitted.module.functions.filter(
        (_, position) => importedFunctions + position !== adapterIndex,
      ).length;
      report.targets[key] = {
        kind: "ran",
        bytes: run.bytes,
        emittedUnits: receipts.length,
        projectionUnits: projection.length,
        moduleFunctions: run.emitted.module.functions.length,
        startupAdapterIndex: adapterIndex,
        moduleExports: run.emitted.module.exports.length,
        rows,
      };
      if (receipts.length === 0) fail(`${key}: emitted zero bodies`);
      if (receipts.length !== projection.length || receipts.some((id, index) => id !== projection[index])) {
        fail(`${key}: emitted unit receipts differ from the projection's physical functions`);
      }
      if (ownedFunctions !== receipts.length)
        fail(`${key}: module holds ${ownedFunctions} owned functions but ${receipts.length} receipts`);
      if (rows.length === 0) fail(`${key}: no oracle rows were checked`);
      for (const row of rows)
        if (!row.match) fail(`${key}: ${row.export}(${row.args.join(",")}) = ${row.actual}, expected ${row.expected}`);
    } catch (error) {
      report.targets[key] = {
        kind: "threw",
        detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
      fail(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (probeForbiddenImport) {
    // Deliberate boundary violation: the census below must catch it.
    await import("../src/ts-api.ts");
  }
} catch (error) {
  report.decodeFailure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  fail(report.decodeFailure);
}

// --- deterministic module census: every resolution is on disk before its import settled ---
const loaded = readFileSync(censusFile, "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line));
const chain = (record) => (record.parent ? `${record.url} <- ${record.parent}` : record.url);
report.loadedModuleCount = loaded.length;
report.frontendModules = loaded.filter(({ url }) => FRONTEND_MODULES.some((pattern) => pattern.test(url))).map(chain);
report.typescriptModules = loaded
  .filter(({ url }) => TYPESCRIPT_MODULES.some((pattern) => pattern.test(url)))
  .map(chain);
if (report.loadedModuleCount === 0) fail("module-load census is empty; the hook recorded nothing");
if (!loaded.some(({ url }) => /\/src\/ir\/program-codec\./.test(url)))
  fail("module-load census does not contain the codec itself");
if (report.frontendModules.length > 0)
  fail(`source frontend modules were loaded: ${report.frontendModules.join("; ")}`);
if (report.typescriptModules.length > 0) fail(`TypeScript modules were loaded: ${report.typescriptModules.join("; ")}`);
finish(report.failures.length === 0 ? 0 : 1);
