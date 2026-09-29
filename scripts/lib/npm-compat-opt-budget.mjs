// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6742) Budget-aware wasm-opt level for the npm-compat standalone lanes.
 *
 * The lanes request Binaryen `-O4`. Binaryen's npm `wasm-opt` is a
 * single-threaded Emscripten build, and its cost grows with the raw module:
 * axios (9.3 MB raw) needed ~38 min at `-O4` without Flatten, far past the
 * 600 s wasm-opt timeout, and lodash-es (5.8 MB) spent ~75 % of its lane in
 * `-O4` against a 120 s CI child budget. Both lanes then reported an error
 * for a module that was valid all along.
 *
 * The policy here:
 *   1. Plan a level from the raw size ({@link STANDALONE_OPT_SIZE_CEILINGS}).
 *   2. Try it. If wasm-opt fails or times out, step down the ladder
 *      (4 → 2 → 1; `-O3` is skipped because it costs the same as `-O4` minus
 *      Flatten, so it cannot rescue an `-O4` timeout). Every attempt is
 *      recorded.
 *   3. When a lane budget is known (the lane runs in a bounded child), an
 *      attempt gets only the time left before the deadline, and any attempt
 *      but the last rung gets at most {@link NON_FINAL_RUNG_SHARE} of it, so a
 *      timeout still leaves the cheaper rung time to finish.
 *   4. If no level produced an artifact, measure the raw module and say so:
 *      `optimizationLevel: 0`, `optimizationVerified: false`.
 *
 * The level that produced the measured artifact is what the record reports as
 * `optimizationLevel`; the request stays visible as
 * `optimizationLevelRequested`. The dashboard never shows a lower-level
 * artifact under an O4 label.
 */

import { O4_TRY_TABLE_FLATTEN_OMISSION } from "./npm-compat-perf.mjs";

/**
 * Highest level planned for a raw module of at most `maxRawBytes` bytes.
 * Ordered from the most to the least expensive level; the first ceiling the
 * module fits under wins. Measured 2026-09-29 (see #6742 for the table).
 */
export const STANDALONE_OPT_SIZE_CEILINGS = Object.freeze([
  Object.freeze({ level: 4, maxRawBytes: 7_000_000 }),
  Object.freeze({ level: 2, maxRawBytes: 12_000_000 }),
  Object.freeze({ level: 1, maxRawBytes: Number.POSITIVE_INFINITY }),
]);

/**
 * Lower bound on wasm-opt's cost per raw MB, in CPU ms (#6742). Measured with
 * `/usr/bin/time` on Binaryen 132's npm `wasm-opt` over hono, moment,
 * lodash-es and axios (the smallest per-MB figure of the four); `-O4`
 * includes the aborted first run that the #4586 Flatten retry repeats. Wall
 * time on a loaded or slower machine is only ever higher, so a rung whose
 * floor does not fit the time left is skipped instead of started.
 */
const WASM_OPT_MIN_CPU_MS_PER_MB = Object.freeze({ 4: 25_000, 3: 23_000, 2: 15_000, 1: 6_000 });

const DEFAULT_ATTEMPT_TIMEOUT_MS = 600_000;
/** Below this, an attempt cannot finish on any module the lanes compile. */
const MIN_ATTEMPT_MS = 5_000;
/** Share of the remaining lane budget a non-final rung may spend. */
const NON_FINAL_RUNG_SHARE = 0.6;

/**
 * @param {number} rawBytes
 * @param {number} requestedLevel
 * @returns {{ level: number, reason: string }}
 */
export function planStandaloneOptimization(rawBytes, requestedLevel, ceilings = STANDALONE_OPT_SIZE_CEILINGS) {
  const index = ceilings.findIndex((entry) => entry.level <= requestedLevel && rawBytes <= entry.maxRawBytes);
  const fit = ceilings[index] ?? ceilings.at(-1);
  if (fit.level === requestedLevel || index <= 0) return { level: fit.level, reason: "requested" };
  const above = ceilings[index - 1];
  return {
    level: fit.level,
    reason: `raw module ${rawBytes} B exceeds the -O${above.level} size ceiling (${above.maxRawBytes} B)`,
  };
}

/**
 * Optimize a raw standalone lane binary under the size/time budget.
 *
 * @param {Uint8Array} raw
 * @param {object} options
 * @param {(binary: Uint8Array, options: object) => Promise<{ binary: Uint8Array, optimized: boolean, warning?: string, timedOut?: boolean }>} options.optimize
 *   `optimizeBinaryAsync` from src/optimize.ts (injected so tests need no wasm-opt).
 * @param {number} options.requestedLevel
 * @param {number} [options.deadline] `now()` value by which optimization must end.
 * @param {() => number} [options.now]
 * @param {boolean} [options.preserveNames]
 * @param {number} [options.attemptTimeoutMs]
 * @param {readonly { level: number, maxRawBytes: number }[]} [options.ceilings]
 */
export async function optimizeStandaloneLaneBinary(raw, options) {
  const { optimize, requestedLevel, deadline, preserveNames } = options;
  const now = options.now ?? (() => performance.now());
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const ceilings = options.ceilings ?? STANDALONE_OPT_SIZE_CEILINGS;
  const plan = planStandaloneOptimization(raw.length, requestedLevel, ceilings);
  const ladder = ceilings.map((entry) => entry.level).filter((level) => level <= plan.level);
  const started = now();
  const attempts = [];
  let reason = plan.reason;
  for (const level of ladder) {
    const share = level === ladder.at(-1) ? 1 : NON_FINAL_RUNG_SHARE;
    const timeoutMs = Math.floor(
      deadline === undefined ? attemptTimeoutMs : Math.min(attemptTimeoutMs, (deadline - now()) * share),
    );
    const floorMs = Math.max(
      MIN_ATTEMPT_MS,
      Math.round((raw.length / 1_000_000) * (WASM_OPT_MIN_CPU_MS_PER_MB[level] ?? 0)),
    );
    if (timeoutMs < floorMs) {
      const detail = `needs at least ${floorMs} ms, ${Math.max(0, timeoutMs)} ms available`;
      attempts.push({ level, outcome: "skipped", detail });
      reason = `-O${level} skipped: ${detail}`;
      continue;
    }
    const attemptStarted = now();
    const result = await optimize(raw, { level, preserveNames, timeoutMs });
    const durationMs = Math.round(now() - attemptStarted);
    const flattenOmitted = level === 4 && result.warning === O4_TRY_TABLE_FLATTEN_OMISSION;
    if (result.optimized && (!result.warning || flattenOmitted)) {
      attempts.push({ level, outcome: "optimized", durationMs });
      return {
        binary: result.binary,
        metadata: laneMetadata(raw, requestedLevel, level, reason, attempts, now() - started, flattenOmitted),
      };
    }
    const outcome = result.timedOut ? "timeout" : "error";
    attempts.push({ level, outcome, durationMs, detail: String(result.warning ?? "no artifact").slice(0, 400) });
    reason = `-O${level} ${outcome === "timeout" ? "timed out" : "failed"}`;
  }
  return { binary: raw, metadata: laneMetadata(raw, requestedLevel, 0, reason, attempts, now() - started, false) };
}

function laneMetadata(raw, requestedLevel, level, reason, attempts, optimizeDurationMs, flattenOmitted) {
  return {
    optimizationRequested: true,
    optimizationVerified: level > 0,
    optimizationLevel: level,
    optimizationLevelRequested: requestedLevel,
    ...(level !== requestedLevel ? { optimizationLevelReason: reason } : {}),
    optimizationAttempts: attempts,
    rawBinaryBytes: raw.length,
    optimizeDurationMs: Math.round(optimizeDurationMs),
    ...(flattenOmitted ? { optimizationOmittedPasses: ["flatten"] } : {}),
  };
}

/**
 * Whether a measured lane carries an honest optimizer receipt: either the
 * plain verified receipt at the expected level, or a budget receipt (#6742)
 * whose recorded level is the one its last attempt actually produced
 * (0 = raw module, never marked verified).
 */
export function optimizationReceiptHolds(lane, expectedLevel) {
  if (lane?.optimizationRequested !== true) return false;
  if (!Array.isArray(lane.optimizationAttempts)) {
    return lane.optimizationVerified === true && lane.optimizationLevel === expectedLevel;
  }
  if (lane.optimizationLevelRequested !== expectedLevel) return false;
  if (lane.optimizationLevel === 0) return lane.optimizationVerified === false;
  const last = lane.optimizationAttempts.at(-1);
  return (
    lane.optimizationVerified === true &&
    last?.outcome === "optimized" &&
    last.level === lane.optimizationLevel &&
    lane.optimizationLevel <= expectedLevel
  );
}
