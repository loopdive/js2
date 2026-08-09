// Shared bounded compile + run harness for npm packages with a primitive API
// workload.  The package entry harness deliberately stops at compile/validate;
// this helper adds one consumed workload without pretending that validation is
// a correctness proof.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, "../..");
const RUN_PROBE = fileURLToPath(new URL("../helpers/compile-project-run-probe.mjs", import.meta.url));
const PROBE_MARKER = "__JS2_COMPILE_PROJECT_RUN_PROBE__";

function parseProbe(stdout) {
  const markerIndex = stdout.lastIndexOf(PROBE_MARKER);
  if (markerIndex < 0) return null;
  const payload = stdout.slice(markerIndex + PROBE_MARKER.length).split(/\r?\n/, 1)[0];
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function errorsFromProbe(probe, child) {
  if (probe) return probe.errors ?? [];
  if (!child) return [{ message: "workload probe was not started" }];
  if (child.error?.code === "ETIMEDOUT") return [];
  if (child.error?.message) return [{ message: child.error.message }];
  if (child.stderr?.trim()) return [{ message: child.stderr.trim() }];
  return [
    {
      message: `workload probe exited ${child.status ?? "without a status"}${child.signal ? ` (${child.signal})` : ""}`,
    },
  ];
}

function diagnosticCategories(errors, timedOut, timeoutMs) {
  if (timedOut) {
    return {
      "compile-budget": {
        count: 1,
        sample: `compileProject exceeded the ${timeoutMs}ms workload budget`,
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

function compileOptions(options) {
  return {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
    ...options,
  };
}

/**
 * @param {{
 *   name: string;
 *   issue: number | null;
 *   setup: () => {root:string, entryModulePath:string, version:string, pin:object};
 *   driverPath: (setup: object) => string;
 *   driverSource: string;
 *   oracle: (setup: object) => Promise<number> | number;
 *   reportName?: string;
 *   timeoutMs?: number;
 *   compile?: object;
 * }} config
 */
export function createNpmWorkloadHarness(config) {
  return async function runHarness({ quiet = false } = {}) {
    const log = quiet ? () => {} : (...values) => console.log(...values);
    const setup = config.setup();
    const driverPath = config.driverPath(setup);
    mkdirSync(dirname(driverPath), { recursive: true });
    writeFileSync(driverPath, config.driverSource);

    const timeoutMs = config.timeoutMs ?? 180_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error(`[dogfood] ${config.name} workload timeout must be a positive integer`);
    }
    const started = performance.now();
    log(`[dogfood] ${config.name}@${setup.version} — compile + run workload with ${timeoutMs}ms budget`);
    const child = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=2048",
        "--import",
        "tsx",
        RUN_PROBE,
        driverPath,
        JSON.stringify(compileOptions(config.compile)),
        "runCase",
      ],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: "SIGTERM",
      },
    );
    const durationMs = Math.round(performance.now() - started);
    const timedOut = child.error?.code === "ETIMEDOUT";
    const probe = timedOut ? null : parseProbe(child.stdout ?? "");
    const errors = errorsFromProbe(probe, child);
    const processFailure = !timedOut && !probe;
    const compileSuccess = probe?.success === true;
    const validates = compileSuccess && probe.valid === true;
    const runtimeRan = probe?.runtime?.ran === true;
    const compileBlocker = timedOut
      ? `compileProject exceeded the ${timeoutMs}ms budget`
      : processFailure
        ? (errors[0]?.message ?? "workload probe emitted no structured report")
        : !compileSuccess
          ? (errors[0]?.message ?? "compile did not emit a binary")
          : !validates
            ? (probe.validationError ?? "emitted binary failed WebAssembly validation")
            : probe.runtime?.error
              ? `compiled workload failed: ${probe.runtime.error}`
              : null;

    let expected = null;
    let oracleError = null;
    try {
      expected = await config.oracle(setup);
    } catch (error) {
      oracleError = error instanceof Error ? error.message : String(error);
    }

    const skippedReason = oracleError
      ? `native oracle failed: ${oracleError}`
      : (compileBlocker ?? (runtimeRan ? null : "compiled workload did not run"));
    const actual = runtimeRan ? probe.runtime.value : null;
    const equal = runtimeRan && oracleError === null && Object.is(actual, expected);
    const tests =
      runtimeRan && oracleError === null
        ? { kind: "api-workload", passed: equal ? 1 : 0, total: 1 }
        : { kind: "api-workload", status: "blocked", reason: skippedReason ?? "workload did not produce a verdict" };
    const correctness = equal
      ? { status: "verified", passed: 1, total: 1, reason: "compiled workload matched the native Node oracle" }
      : runtimeRan && oracleError === null
        ? {
            status: "divergent",
            passed: 0,
            total: 1,
            reason: `compiled workload returned ${JSON.stringify(actual)}; native Node returned ${JSON.stringify(expected)}`,
          }
        : { status: "unverified", reason: skippedReason ?? "workload did not produce a verdict" };

    const report = {
      issue: config.issue,
      generatedAt: new Date().toISOString(),
      [config.name]: {
        version: setup.version,
        source: setup.pin.tarball,
        entryModule: setup.pin.entryModule,
      },
      compile: {
        success: compileSuccess,
        durationMs,
        timedOut,
        timeoutMs,
        errorCount: errors.length,
        binaryBytes: probe?.binaryByteLength ?? 0,
        categories: diagnosticCategories(errors, timedOut, timeoutMs),
        ...(errors.length > 0 ? { errors } : {}),
      },
      validation: {
        validates,
        firstError: validates ? null : compileBlocker,
      },
      diff: {
        runnable: runtimeRan,
        skippedReason: runtimeRan ? null : skippedReason,
        expected,
        actual,
      },
      tests,
      correctness,
      summary: {
        headline: !compileSuccess
          ? timedOut
            ? "compile exceeded the bounded harness budget"
            : "compile reported failure"
          : !validates
            ? "compiled, but binary invalid"
            : equal
              ? "compiled + valid + workload matched native Node"
              : runtimeRan
                ? "compiled + valid, but workload diverged from native Node"
                : "compiled + valid, but workload did not run",
        compileMs: durationMs,
        compileSuccess,
        binaryValidates: validates,
        runtimeDiff: runtimeRan ? { passed: equal ? 1 : 0, total: 1 } : { skipped: true, reason: skippedReason },
      },
    };

    const reportPath = join(HERE, "report", `${config.reportName ?? `${config.name}-workload`}-surface.json`);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    log(`\n[dogfood] === ${config.name} workload report ===`);
    log(JSON.stringify(report.summary, null, 2));
    log(`[dogfood] full report → ${reportPath}`);
    return report;
  };
}

export function runWorkloadHarnessCli(runHarness) {
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

export function isCli(moduleUrl, path) {
  return Boolean(path) && moduleUrl === pathToFileURL(path).href;
}
