// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#1490, #6910) The Node `process` platform capability: the `__get_process*`
 * readers a JavaScript-environment module imports for `process`,
 * `process.env`, `process.argv`, `process.platform`, `process.arch`,
 * `process.cwd` and the stdout/stderr streams. Each answers a host-free
 * stand-in when the embedder has no `process`.
 *
 * Under the native regime the value crosses the JS value boundary (injected
 * `toNative`): an object is ADMITTED so its members read through the boundary
 * object MOP, a string becomes a native string. Other lanes see the raw value.
 */

type ProcessReader = () => unknown;

// prettier-ignore
const emptyProcessStream = { on() { return this; }, removeListener() { return this; } };

function hostProcess(): any {
  return typeof process !== "undefined" ? process : undefined;
}

const PROCESS_READERS: Readonly<Record<string, ProcessReader>> = {
  // prettier-ignore
  __get_process: () => hostProcess() ?? { env: {}, platform: "", arch: "", argv: [], stdout: emptyProcessStream, stderr: emptyProcessStream, [Symbol.toStringTag]: "process" },
  __get_process_argv: () => hostProcess()?.argv ?? [],
  __get_process_env: () => hostProcess()?.env ?? {},
  __get_process_cwd: () => (typeof hostProcess()?.cwd === "function" ? hostProcess().cwd() : ""),
  __get_process_platform: () => hostProcess()?.platform || "",
  __get_process_arch: () => hostProcess()?.arch || "",
  __get_process_stdout: () => hostProcess()?.stdout ?? emptyProcessStream,
  __get_process_stderr: () => hostProcess()?.stderr ?? emptyProcessStream,
};

/**
 * Resolve a `__get_process*` builtin, or `undefined` when `name` is not one.
 * `toNative` presents the host value to the importing module (identity for a
 * non-native-regime module).
 */
export function resolveProcessCapability(
  name: string,
  toNative: (value: unknown) => unknown,
): (() => unknown) | undefined {
  const read = Object.prototype.hasOwnProperty.call(PROCESS_READERS, name) ? PROCESS_READERS[name] : undefined;
  return read && (() => toNative(read()));
}
