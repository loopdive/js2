/**
 * Reproduce ONE test262 row locally, without the test262 submodule.
 *
 *   npx tsx scripts/run-test262-row.mts built-ins/Array/prototype/includes/no-arg.js
 *
 * Why this exists: diagnosing a single conformance failure previously required
 * either the ~GB test262 submodule checkout or a full sharded CI run, and
 * hand-written repros are misleading — the runner compiles each test as
 * TypeScript through `wrapTest`, so the shape that reaches codegen is not the
 * shape you get by pasting the test body into a .ts file. Guessing at it sends
 * you after the wrong bug: `includes/samevaluezero.js` looks like a wrong-answer
 * row from its baseline error string, but reproduced faithfully it is a
 * COMPILE_ERROR row (TypeScript rejects `[42].includes("42")` because its lib
 * types searchElement as the element type, stricter than the language).
 *
 * The file is fetched from tc39/test262 at the pinned submodule SHA, wrapped by
 * the runner's own `wrapTest`, compiled with the runner's options, then
 * instantiated and run. Output is the row's verdict: compile_error / fail / pass.
 *
 * Requires network access to raw.githubusercontent.com. Pass --sha <sha> to
 * pin a different revision (defaults to the submodule commit recorded below).
 */
import { compile } from "../src/index.js";
import { parseMeta, wrapTest } from "../tests/test262-runner.js";

/** The test262 submodule commit this repo pins (`git submodule status test262`). */
const DEFAULT_SHA = "b363f29d3c43c626dc852744ad64a0b48a003693";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const shaFlag = args.indexOf("--sha");
  const sha = shaFlag >= 0 ? (args[shaFlag + 1] ?? DEFAULT_SHA) : DEFAULT_SHA;
  const rel = args.find((a) => a.endsWith(".js"));
  if (!rel) {
    console.error("usage: run-test262-row.mts <path-under-test262/test> [--sha <sha>]");
    process.exit(2);
  }

  const url = `https://raw.githubusercontent.com/tc39/test262/${sha}/test/${rel}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(`fetch failed: ${resp.status} ${url}`);
    process.exit(1);
  }
  const source = await resp.text();
  const meta = parseMeta(source);
  const wrapped = wrapTest(source, meta);

  const result = (await compile(wrapped.source, { fileName: "test.ts", emitWat: false })) as {
    success: boolean;
    binary: Uint8Array;
    errors?: { message: string; line?: number; severity: string }[];
    importObject?: WebAssembly.Imports;
  };
  const diags = result.errors ?? [];
  const errors = diags.filter((d) => d.severity === "error");
  console.log(`compile: success=${result.success} errors=${errors.length} warnings=${diags.length - errors.length}`);
  for (const d of diags.slice(0, 5)) console.log(`  ${d.severity} @${d.line ?? "?"}: ${d.message}`);

  // Mirror the runner's own criterion (tests/test262-runner.ts): an
  // error-SEVERITY diagnostic is a compile_error row even when a binary came
  // out. Judging by `binary.length` alone reports "pass" for a row the real
  // runner still counts as failing — which is exactly how a downgrade that
  // forgot the severity map looks green locally.
  if (!result.success || errors.length > 0 || !result.binary?.length) {
    // Note: an empty binary with ZERO errors is itself a defect worth chasing —
    // the compile refused without saying why.
    console.log("RESULT: compile_error");
    return;
  }

  try {
    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
    const exports = instance.exports as Record<string, () => void>;
    (exports._start ?? exports.__module_init ?? (() => {}))();
    console.log("RESULT: pass");
  } catch (error) {
    console.log(`RESULT: fail — ${String((error as Error)?.message ?? error).split("\n")[0]}`);
  }
}

await main();
