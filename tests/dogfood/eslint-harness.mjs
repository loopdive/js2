// ESLint npm-compat dogfood harness (#1400).
//
// The contract matches the other npm-compat packages:
//   1. acquire and integrity-check a committed npm tarball,
//   2. compile the real published package entry,
//   3. validate any emitted Wasm,
//   4. record runtime-test availability without converting an unfinished
//      package into a fake pass,
//   5. emit a structured report consumed by the npm-compat page.
//
// ESLint is intentionally allowed to remain red. Its multi-file CommonJS graph
// is the active #1400/#3672 frontier; a child-process budget prevents the page
// generator from hanging or exhausting its own process.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { setupEslint } from "./setup-eslint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(HERE, "report", "eslint-surface.json");
const COMPILE_PROJECT_PROBE = fileURLToPath(new URL("../helpers/compile-project-probe.ts", import.meta.url));
const PROBE_MARKER = "__JS2_COMPILE_PROJECT_PROBE__";
const DEFAULT_COMPILE_TIMEOUT_MS = 180_000;

function compileTimeoutMs() {
  const value = Number(process.env.DOGFOOD_ESLINT_TIMEOUT_MS ?? DEFAULT_COMPILE_TIMEOUT_MS);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("DOGFOOD_ESLINT_TIMEOUT_MS must be a positive integer");
  }
  return value;
}

function diagnosticCategories(errors, timedOut) {
  if (timedOut) {
    return {
      "compile-budget": {
        count: 1,
        sample: `compileProject exceeded the ${compileTimeoutMs()}ms ESLint harness budget`,
      },
    };
  }
  if (errors.length === 0) return {};
  return {
    "compiler-diagnostic": {
      count: errors.length,
      sample: errors[0].message,
    },
  };
}

function parseProbe(stdout) {
  const markerIndex = stdout.lastIndexOf(PROBE_MARKER);
  if (markerIndex < 0) return null;
  const payload = stdout.slice(markerIndex + PROBE_MARKER.length).split(/\r?\n/, 1)[0];
  return JSON.parse(payload);
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const { entryModulePath, version, pin } = setupEslint();
  const timeoutMs = compileTimeoutMs();
  const started = performance.now();
  log(`[dogfood] eslint@${version} — compileProject(${pin.entryModule}) with ${timeoutMs}ms budget`);

  const child = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=2048",
      "--import",
      "tsx",
      COMPILE_PROJECT_PROBE,
      entryModulePath,
      JSON.stringify({ allowJs: true, target: "gc", platform: "node" }),
    ],
    {
      cwd: join(HERE, "../.."),
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGTERM",
    },
  );
  const durationMs = Math.round(performance.now() - started);
  const timedOut = child.error?.code === "ETIMEDOUT";
  const probe = timedOut ? null : parseProbe(child.stdout ?? "");
  const processError =
    !timedOut && !probe
      ? (child.error?.message ??
        child.stderr?.trim() ??
        `compile probe exited ${child.status ?? "without a status"}${child.signal ? ` (${child.signal})` : ""}`)
      : null;
  const errors = probe?.errors ?? (processError ? [{ message: processError }] : []);
  const compileSuccess = probe?.success === true;
  const validates = compileSuccess && probe.valid === true;
  const blockedReason = timedOut
    ? `compileProject exceeded the ${timeoutMs}ms budget (#3672)`
    : processError
      ? `compile probe failed: ${processError}`
      : !compileSuccess
        ? (errors[0]?.message ?? "compile did not emit a binary")
        : !validates
          ? (probe.validationError ?? "emitted binary failed WebAssembly validation")
          : "Linter.verify runtime proof remains unfinished (#1400)";

  const report = {
    issue: 1400,
    generatedAt: new Date().toISOString(),
    eslint: {
      version,
      source: pin.tarball,
      entryModule: pin.entryModule,
    },
    compile: {
      success: compileSuccess,
      durationMs,
      timedOut,
      timeoutMs,
      errorCount: errors.length,
      binaryBytes: probe?.binaryByteLength ?? 0,
      categories: diagnosticCategories(errors, timedOut),
      ...(errors.length > 0 ? { errors } : {}),
    },
    validation: {
      validates,
      firstError: validates ? null : blockedReason,
    },
    diff: {
      runnable: false,
      skippedReason: blockedReason,
    },
    summary: {
      headline: compileSuccess
        ? validates
          ? "compiled + valid; Linter.verify runtime proof not complete"
          : "compiled, but binary invalid"
        : timedOut
          ? "compile exceeded the bounded harness budget"
          : "compile reported failure",
      compileMs: durationMs,
      compileSuccess,
      binaryValidates: validates,
      runtimeDiff: { skipped: true, reason: blockedReason },
    },
  };

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  log(`\n[dogfood] === eslint surface report ===`);
  log(JSON.stringify(report.summary, null, 2));
  log(`[dogfood] full report → ${REPORT_PATH}`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const jsonOnly = process.argv.includes("--json");
  runHarness({ quiet: jsonOnly })
    .then((report) => {
      if (jsonOnly) process.stdout.write(`${JSON.stringify(report)}\n`);
    })
    .catch((error) => {
      if (jsonOnly) {
        process.stdout.write(`${JSON.stringify({ fatal: error instanceof Error ? error.message : String(error) })}\n`);
      } else {
        console.error(error);
      }
      process.exitCode = 1;
    });
}
