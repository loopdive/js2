// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3672 — supervise the out-of-process `compileProject` probe under an explicit
// heap and wall-clock budget.
//
// Why this exists: the ESLint package graph is the first workload big enough
// that "the compiler died" and "the compiler produced a diagnostic" are easy to
// confuse. `execFile` on its own conflates them — an OOM-killed child (SIGABRT,
// empty stdout) and a clean run that reports a compile error both arrive as
// "no useful output". #3672 requires the opposite: a child that is killed, that
// exceeds its budget, or that emits no structured report must fail **loudly and
// distinguishably**, and must never be folded into the compiler's diagnostic
// list. A budget breach that degrades into a silent skip is worse than a crash.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(__dirname, "../..");
const PROBE_ENTRY = resolve(__dirname, "compile-project-probe.ts");

/** Marker the probe prints in front of its JSON report. */
export const COMPILE_PROJECT_PROBE_MARKER = "__JS2_COMPILE_PROJECT_PROBE__";

/** Structured result emitted by `tests/helpers/compile-project-probe.ts`. */
export interface CompileProjectProbeReport {
  success: boolean;
  binaryByteLength: number;
  valid: boolean;
  validationError: string | null;
  errors: Array<{
    message: string;
    line: number;
    column: number;
    severity: "error" | "warning";
    file?: string;
  }>;
}

/** Every way the probe can fail *as a probe*, as opposed to compiling badly. */
export type GraphProbeFailureKind = "timeout" | "abnormal-exit" | "no-structured-report";

/**
 * A supervision failure. Deliberately a distinct type from a compiler
 * diagnostic so a caller can never assert against it as if it were one.
 */
export class EslintGraphProbeFailure extends Error {
  constructor(
    readonly kind: GraphProbeFailureKind,
    message: string,
    readonly detail: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      elapsedMs: number;
      stderrTail: string;
      stdoutTail: string;
    },
  ) {
    super(message);
    this.name = "EslintGraphProbeFailure";
  }
}

export interface GraphProbeBudget {
  /** Entry file handed to `compileProject`. */
  entry: string;
  /** `CompileOptions`, serialised for the child. */
  options: Record<string, unknown>;
  /** Enforced V8 old-space ceiling for the child, in MB. */
  heapLimitMb: number;
  /** Enforced wall-clock ceiling. The child is SIGKILLed past this. */
  timeoutMs: number;
  /** Override the probe arguments wholesale (used by the self-checks below). */
  rawArgs?: string[];
}

export interface GraphProbeOutcome {
  report: CompileProjectProbeReport;
  elapsedMs: number;
  heapLimitMb: number;
  timeoutMs: number;
}

const tail = (text: string, lines = 12): string => text.split("\n").slice(-lines).join("\n");

/**
 * Run the probe as a child process under an enforced heap + wall-clock budget.
 *
 * Resolves only when the child exited normally *and* printed a parseable
 * structured report. Every other outcome rejects with an
 * {@link EslintGraphProbeFailure} naming which budget or invariant broke.
 */
export function runCompileProjectProbe(budget: GraphProbeBudget): Promise<GraphProbeOutcome> {
  const { entry, options, heapLimitMb, timeoutMs, rawArgs } = budget;
  const args = [
    `--max-old-space-size=${heapLimitMb}`,
    "--import",
    "tsx",
    PROBE_ENTRY,
    ...(rawArgs ?? [entry, JSON.stringify(options)]),
  ];

  return new Promise<GraphProbeOutcome>((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: REPOSITORY_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(
        new EslintGraphProbeFailure("abnormal-exit", `compileProject probe could not be spawned: ${error.message}`, {
          exitCode: null,
          signal: null,
          elapsedMs: Date.now() - startedAt,
          stderrTail: tail(stderr),
          stdoutTail: tail(stdout),
        }),
      );
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      const elapsedMs = Date.now() - startedAt;
      const detail = { exitCode, signal, elapsedMs, stderrTail: tail(stderr), stdoutTail: tail(stdout) };

      if (timedOut) {
        rejectPromise(
          new EslintGraphProbeFailure(
            "timeout",
            `compileProject probe exceeded its ${timeoutMs} ms wall-clock budget and was killed ` +
              `(heap limit ${heapLimitMb} MB). This is a budget breach, not a compiler diagnostic.\n${detail.stderrTail}`,
            detail,
          ),
        );
        return;
      }

      if (exitCode !== 0 || signal !== null) {
        rejectPromise(
          new EslintGraphProbeFailure(
            "abnormal-exit",
            `compileProject probe exited abnormally (code=${exitCode} signal=${signal}) after ${elapsedMs} ms ` +
              `under a ${heapLimitMb} MB heap limit. An out-of-memory abort lands here (SIGABRT / exit 134); ` +
              `it is NOT a compiler diagnostic and must not be reported as one.\n${detail.stderrTail}`,
            detail,
          ),
        );
        return;
      }

      const marker = stdout.lastIndexOf(COMPILE_PROJECT_PROBE_MARKER);
      if (marker === -1) {
        rejectPromise(
          new EslintGraphProbeFailure(
            "no-structured-report",
            `compileProject probe exited 0 but emitted no structured report after ${elapsedMs} ms. ` +
              `Missing output is a probe failure, never an expected compiler diagnostic.\n${detail.stdoutTail}`,
            detail,
          ),
        );
        return;
      }

      let report: CompileProjectProbeReport;
      try {
        report = JSON.parse(
          stdout.slice(marker + COMPILE_PROJECT_PROBE_MARKER.length).trim(),
        ) as CompileProjectProbeReport;
      } catch (error) {
        rejectPromise(
          new EslintGraphProbeFailure(
            "no-structured-report",
            `compileProject probe emitted an unparseable structured report: ${
              error instanceof Error ? error.message : String(error)
            }\n${detail.stdoutTail}`,
            detail,
          ),
        );
        return;
      }

      resolvePromise({ report, elapsedMs, heapLimitMb, timeoutMs });
    });
  });
}

/** Join a report's diagnostics for substring assertions. */
export function diagnosticText(report: CompileProjectProbeReport): string {
  return report.errors.map((error) => error.message).join("\n");
}
