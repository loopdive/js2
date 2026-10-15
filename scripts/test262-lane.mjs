import { parseTest262CompilerPath } from "./test262-compiler-path.mjs";

/**
 * Lane identity shared by the runner, workers and report tooling.
 *
 * (#6979 S7) The native semantic regime is the only ECMAScript implementation
 * on the WasmGC backend, so a lane is named by its target alone: `gc` (the
 * regime in the JavaScript environment) or `standalone`. The former
 * `TEST262_SEMANTIC_PROVIDERS` axis (`host-assisted` control lane) is gone.
 */

/** Does a lane lower with the native semantic regime? (`gc` or standalone.) */
export function test262LaneUsesNativeRegime(target) {
  return target === undefined || target === "gc" || target === "standalone";
}

export function test262ResultPrefix(target = "gc", compilerPath = process.env.TEST262_COMPILER_PATH) {
  const prefix = target === "gc" ? "test262" : `test262-${target}`;
  return parseTest262CompilerPath(compilerPath) === "ir" ? `${prefix}-ir` : prefix;
}
