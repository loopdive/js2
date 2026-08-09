// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Shared by the landing chart generator and the #3498 evidence runner. */
export const LANDING_WASMTIME_FEATURES = Object.freeze([
  "-W",
  "gc=y",
  "-W",
  "function-references=y",
  "-W",
  "exceptions=y",
]);

/** Keep these options aligned with the existing landing-page Wasmtime lane. */
export const LANDING_WASMTIME_COMPILE_OPTIONS = Object.freeze({
  target: "wasi",
  nativeStrings: true,
  optimize: 3,
});

export const LANDING_WASM_OPT_ARGS = Object.freeze(["--all-features", "--disable-custom-descriptors", "-O3"]);
export const LANDING_WASMTIME_WARM_VALIDATION_EXPORT = "landing_validate";
export const LANDING_FOUR_LANE_INNER_WARMUP_CALLS = 6;
export const LANDING_FOUR_LANE_INNER_MEASURED_CALLS = 9;

export function landingWasmtimeWarmDriverSource(warmupIterations = 5, measuredIterations = 40) {
  if (!Number.isInteger(warmupIterations) || warmupIterations < 0) throw new Error("invalid warmup iteration count");
  if (!Number.isInteger(measuredIterations) || measuredIterations <= 0) {
    throw new Error("invalid measured iteration count");
  }
  return `
/** @param {number} __n @returns {number} */
export function warm(__n) {
  for (let __w = 0; __w < ${warmupIterations}; __w++) { run(__n); }
  let __best = 1e18;
  let __sink = 0;
  for (let __m = 0; __m < ${measuredIterations}; __m++) {
    const __t0 = performance.now();
    const __r = run(__n);
    const __dt = performance.now() - __t0;
    __sink = (__sink + __r) | 0;
    if (__dt < __best) __best = __dt;
  }
  if (__sink === 0x7fffffff) return -1;
  return __best;
}

/** @param {number} __n @returns {number} */
export function ${LANDING_WASMTIME_WARM_VALIDATION_EXPORT}(__n) {
  return run(__n);
}
`;
}

/**
 * Four-lane-only warm driver. Nine scalar timings are sorted with an unrolled
 * compare/swap network so this path uses the same 6-warmup/9-call median as
 * V8 and native without requiring array lowering in the compatibility frontend.
 */
export function landingFourLaneWasmtimeMedianWarmDriverSource() {
  const timings = Array.from({ length: LANDING_FOUR_LANE_INNER_MEASURED_CALLS }, (_, index) => `__t${index}`);
  const measured = timings
    .map(
      (timing, index) => `
  const __started${index} = performance.now();
  const __result${index} = run(__n);
  let ${timing} = performance.now() - __started${index};
  __sink = (__sink + __result${index}) | 0;`,
    )
    .join("");
  const swaps = [];
  for (let pass = timings.length - 1; pass > 0; pass--) {
    for (let index = 0; index < pass; index++) {
      const left = timings[index];
      const right = timings[index + 1];
      swaps.push(`  if (${left} > ${right}) { const __swap = ${left}; ${left} = ${right}; ${right} = __swap; }`);
    }
  }
  return `
/** @param {number} __n @returns {number} */
export function warm(__n) {
  for (let __w = 0; __w < ${LANDING_FOUR_LANE_INNER_WARMUP_CALLS}; __w++) { run(__n); }
  let __sink = 0;${measured}
${swaps.join("\n")}
  if (__sink === 0x7fffffff) return -1;
  return __t4;
}

/** @param {number} __n @returns {number} */
export function ${LANDING_WASMTIME_WARM_VALIDATION_EXPORT}(__n) {
  return run(__n);
}
`;
}

export function landingWasmtimeCompileArgs(wasmPath, cwasmPath) {
  return ["compile", ...LANDING_WASMTIME_FEATURES, wasmPath, "-o", cwasmPath];
}

export function landingWasmtimeRunArgs(cwasmPath, exportName, argument) {
  return [
    "run",
    "--allow-precompiled",
    ...LANDING_WASMTIME_FEATURES,
    "--invoke",
    exportName,
    cwasmPath,
    String(argument),
  ];
}
