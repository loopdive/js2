import { attributeRejections } from "./upstream-unhandled-rejections.mjs";

export const WORKER_COMPILE_COMPLETE_PREFIX = "__JS2WASM_COMPILE_COMPLETE__:";

export function signalWorkerCompileComplete(durationMs, stream = process.stderr) {
  stream.write(`${WORKER_COMPILE_COMPLETE_PREFIX}${Math.max(0, Math.round(durationMs))}\n`);
}

/**
 * Write a worker's single terminal JSON result and exit.
 *
 * The exit is explicit — a disposable compile worker must not be held open by
 * abandoned upstream timers, streams, or scheduler handles, which would turn a
 * finished result into an outer worker timeout.
 *
 * It happens from the write callback, though, and that ordering is the whole
 * point of this helper. The parent captures stdout through a pipe (`spawn`
 * with stdio "pipe"), and a pipe accepts only its buffer — 64 KB on Linux —
 * before the remainder has to be drained asynchronously by the reader.
 * Writing and then exiting immediately truncates any larger report at exactly
 * that boundary, leaving the parent a half-written JSON document (#4767).
 */
export function emitWorkerResult(value, exitCode = 0, stream = process.stdout) {
  stream.write(`${JSON.stringify(value)}\n`, () => {
    process.exit(exitCode);
  });
}

export function readWorkerCompileDuration(stderr) {
  const match = String(stderr).match(new RegExp(`${WORKER_COMPILE_COMPLETE_PREFIX}(\\d+)`));
  return match ? Number(match[1]) : null;
}

export function stripWorkerProtocol(stderr) {
  return String(stderr)
    .replace(new RegExp(`(?:^|\\n)${WORKER_COMPILE_COMPLETE_PREFIX}\\d+(?=\\n|$)`, "g"), "")
    .trim();
}

export function configuredUpstreamTestTimeoutMs(env = process.env) {
  const configured = Number(env.DOGFOOD_UPSTREAM_TEST_TIMEOUT_MS ?? 0);
  return Number.isFinite(configured) && configured > 0 ? configured : 0;
}

export async function withUpstreamTestTimeout(run, timeoutMs, label) {
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) return run();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const UNCAUGHT_KIND = "uncaught host exception";

/** Fold reasons that surfaced after the last test settled onto that test. */
function foldTrailing(reasons, statuses, errors, moduleRejections, kind = undefined) {
  if (reasons.length === 0) return;
  const last = statuses.length - 1;
  if (last < 0) {
    moduleRejections.push(...reasons);
    return;
  }
  const folded = attributeRejections({
    reasons,
    passed: statuses[last],
    error: errors[last],
    late: true,
    ...(kind ? { kind } : {}),
  });
  statuses[last] = folded.passed;
  errors[last] = folded.error;
}

/**
 * Run the module's tests one at a time, attributing host rejections as it goes.
 *
 * `rejections` is the worker's unhandled-rejection sink (#5369). Draining it
 * after each test is what turns "the worker died somewhere in this file" into
 * "test N leaked this reason": the drain yields an event-loop turn, which is
 * the only point at which Node reports a rejection nothing observed.
 *
 * (#6424) The sink's `uncaughtException` channel is armed for the duration of
 * this loop and disarmed again on the way out. That window is the whole rule:
 * a stray host timer a test left behind throws while tests are running, so it
 * is attributable and the file keeps its other results; anything that throws
 * during compile, instantiation, module init, teardown or emit is outside the
 * window and still kills the worker fast with a readable message, instead of
 * being swallowed into a 180 s timeout the worker can never emit out of.
 */
export async function runSequentialUpstreamTests({
  ids,
  invoke,
  timeoutMs,
  failureText,
  thrownText,
  rejections = null,
}) {
  const statuses = [];
  const errors = [];
  const moduleRejections = [];
  const disarmUncaught = rejections?.armUncaughtExceptions?.() ?? (() => {});
  try {
    for (const id of ids) {
      let value;
      let thrown = null;
      try {
        value = await withUpstreamTestTimeout(() => invoke(id), timeoutMs, `compiled upstream test ${String(id)}`);
      } catch (error) {
        thrown = error;
      }
      let passed = Number(value) === 1;
      let error = passed ? "" : thrown ? thrownText(thrown) : await failureText(id);
      if (rejections) {
        // Rejections first, then uncaught exceptions: a test that already has
        // a reason keeps it (#5823), and the worker's `unhandledRejections`
        // field keeps meaning only what its name says.
        ({ passed, error } = attributeRejections({ reasons: await rejections.drain(), passed, error }));
        ({ passed, error } = attributeRejections({
          reasons: (await rejections.drainUncaught?.()) ?? [],
          passed,
          error,
          kind: UNCAUGHT_KIND,
        }));
      }
      statuses.push(passed);
      errors.push(error);
    }
    if (rejections) {
      // A rejection that only surfaces after the last test settled still came
      // from a test — the one that leaked it — so it lands there, marked late.
      // With no tests at all it can only belong to the module.
      foldTrailing(await rejections.drain(), statuses, errors, moduleRejections);
      foldTrailing((await rejections.drainUncaught?.()) ?? [], statuses, errors, moduleRejections, UNCAUGHT_KIND);
    }
  } finally {
    disarmUncaught();
  }
  return { statuses, errors, moduleRejections };
}
