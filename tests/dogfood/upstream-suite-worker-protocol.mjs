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

export async function runSequentialUpstreamTests({ ids, invoke, timeoutMs, failureText, thrownText }) {
  const statuses = [];
  const errors = [];
  for (const id of ids) {
    let value;
    let thrown = null;
    try {
      value = await withUpstreamTestTimeout(() => invoke(id), timeoutMs, `compiled upstream test ${String(id)}`);
    } catch (error) {
      thrown = error;
    }
    const passed = Number(value) === 1;
    statuses.push(passed);
    if (passed) errors.push("");
    else if (thrown) errors.push(thrownText(thrown));
    else errors.push(await failureText(id));
  }
  return { statuses, errors };
}
