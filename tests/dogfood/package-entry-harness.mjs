import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPILE_PROJECT_PROBE = fileURLToPath(new URL("../helpers/compile-project-probe.ts", import.meta.url));
const PROBE_MARKER = "__JS2_COMPILE_PROJECT_PROBE__";

function parseProbe(stdout) {
  const markerIndex = stdout.lastIndexOf(PROBE_MARKER);
  if (markerIndex < 0) return null;
  const payload = stdout.slice(markerIndex + PROBE_MARKER.length).split(/\r?\n/, 1)[0];
  return JSON.parse(payload);
}

function diagnosticCategories(errors, timedOut, timeoutMs) {
  if (timedOut) {
    return { "compile-budget": { count: 1, sample: `compileProject exceeded the ${timeoutMs}ms budget` } };
  }
  if (errors.length === 0) return {};
  return { "compiler-diagnostic": { count: errors.length, sample: errors[0].message } };
}

export function createPackageEntryHarness({
  name,
  setup,
  issue = null,
  timeoutMs = 120_000,
  compileOptions = { allowJs: true, skipSemanticDiagnostics: true, target: "gc", platform: "node" },
}) {
  return async function runHarness({ quiet = false } = {}) {
    const log = quiet ? () => {} : (...values) => console.log(...values);
    const { entryModulePath, entryExists = true, version, pin } = setup();
    const started = performance.now();
    log(`[dogfood] ${name}@${version} — compileProject(${pin.entryModule}) with ${timeoutMs}ms budget`);

    const child = entryExists
      ? spawnSync(
          process.execPath,
          [
            "--max-old-space-size=2048",
            "--import",
            "tsx",
            COMPILE_PROJECT_PROBE,
            entryModulePath,
            JSON.stringify(compileOptions),
          ],
          {
            cwd: join(HERE, "../.."),
            encoding: "utf-8",
            maxBuffer: 64 * 1024 * 1024,
            timeout: timeoutMs,
            killSignal: "SIGTERM",
          },
        )
      : null;
    const durationMs = Math.round(performance.now() - started);
    const timedOut = child?.error?.code === "ETIMEDOUT";
    const probe = !child || timedOut ? null : parseProbe(child.stdout ?? "");
    const processError = !entryExists
      ? `published tarball does not contain its declared entry ${pin.entryModule}`
      : !timedOut && !probe
        ? (child.error?.message ??
          child.stderr?.trim() ??
          `compile probe exited ${child.status ?? "without a status"}${child.signal ? ` (${child.signal})` : ""}`)
        : null;
    const errors = probe?.errors ?? (processError ? [{ message: processError }] : []);
    const compileSuccess = probe?.success === true;
    const validates = compileSuccess && probe.valid === true;
    const blockedReason = timedOut
      ? `compileProject exceeded the ${timeoutMs}ms budget`
      : processError
        ? `compile probe failed: ${processError}`
        : !compileSuccess
          ? (errors[0]?.message ?? "compile did not emit a binary")
          : !validates
            ? (probe.validationError ?? "emitted binary failed WebAssembly validation")
            : "runtime differential harness not implemented";

    const report = {
      issue,
      generatedAt: new Date().toISOString(),
      [name]: { version, source: pin.tarball, entryModule: pin.entryModule },
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
        firstError: validates ? null : blockedReason,
      },
      capabilities: {
        nodeFs: compileOptions.allowFs === true,
      },
      diff: {
        runnable: false,
        skippedReason: blockedReason,
      },
      // (#4127) This harness compiles and validates; it never RUNS the package,
      // so it has no correctness evidence. Say so explicitly on the report
      // rather than leaving the axis absent — an absent field reads as "fine",
      // and a package that emits a valid module while computing the wrong
      // answer is exactly what this axis exists to surface.
      correctness: {
        status: "unverified",
        reason:
          compileSuccess && validates
            ? "no differential workload — compile/validation only; correctness is unknown"
            : "package does not compile, so no workload could run",
      },
      summary: {
        headline: !compileSuccess
          ? timedOut
            ? "compile exceeded the bounded harness budget"
            : "compile reported failure"
          : validates
            ? "compiled + valid; runtime differential proof not implemented"
            : "compiled, but binary invalid",
        compileMs: durationMs,
        compileSuccess,
        binaryValidates: validates,
        runtimeDiff: { skipped: true, reason: blockedReason },
      },
    };

    const reportPath = join(HERE, "report", `${name}-surface.json`);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    log(`\n[dogfood] === ${name} surface report ===`);
    log(JSON.stringify(report.summary, null, 2));
    log(`[dogfood] full report → ${reportPath}`);
    return report;
  };
}

export function runPackageEntryHarnessCli(runHarness) {
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
