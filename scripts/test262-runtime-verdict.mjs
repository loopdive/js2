// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Runtime-phase verdict rules of scripts/test262-worker.mjs that depend only on
// the thrown value, so they can be tested without a compiler bundle (#7354 U0).
//
// A Wasm trap is never a JavaScript throw. Its message carries the frame names
// (`unreachable [in Test262Error() ← assert]`), so a name match on the rendered
// text counts a trap inside a function named after the expected error as the
// expected throw. The Prepared lane refuses that; every other lane keeps the
// published behaviour until #7447 measures and lands the same rule there.

/**
 * A trap (`unreachable`, out of bounds, illegal cast, null dereference). A
 * JavaScript throw leaves Wasm as a `WebAssembly.Exception` carried by the
 * exception tag, or as the host's own error object, never as this class.
 */
function isWasmTrap(err) {
  return err instanceof WebAssembly.RuntimeError;
}

/**
 * A host error's message, followed for a trap by its Wasm frames in
 * trap-first order (#1316/#1317: the leaf is often a tiny lifted helper whose
 * name alone says nothing without its callers).
 */
export function renderHostError(err, abortBodies = []) {
  let info = err.message ?? String(err);
  if (!/illegal cast|null|unreachable|out of bounds/.test(info)) return info;
  const frameRe = /at\s+(\S+)\s+\(wasm:\/\//g;
  const frames = [];
  let m;
  while ((m = frameRe.exec(err.stack ?? "")) !== null) frames.push(m[1]);
  if (frames.length === 0) return info;
  // (#7354 U) A Prepared function whose body could not be lowered has the abort as its whole body, so a trap whose
  // top frame is that function is its abort.
  // oracle-version-exempt: only the error TEXT of a trap changes, and only for a row that carries an abort table
  // (the Prepared lane with abort bodies, new in this slice); no row's pass/fail scoring changes.
  const aborted = isWasmTrap(err) ? abortBodies.find((row) => row.name === frames[0]) : undefined;
  if (aborted) info = `aborted in unlowerable unit ${aborted.name}: ${aborted.detail}`;
  info = `${info} [in ${frames[0]}()`;
  // Cap at 3 caller frames so the line stays readable inside the 300-char
  // `error.substring(0, 300)` truncation downstream.
  if (frames.length > 1) info += ` ← ${frames.slice(1, 4).join(" ← ")}`;
  return `${info}]`;
}

/** Did `err` carry the expected error type? `render` is the worker's message renderer. */
function originalHarnessExceptionMatches(err, instance, expectedErrorType, render) {
  if (!expectedErrorType) return true;
  if (err instanceof WebAssembly.Exception && instance) {
    try {
      const tag = instance.exports.__exn_tag ?? instance.exports.__tag;
      const payload = tag ? err.getArg(tag, 0) : undefined;
      const name = payload?.name ?? payload?.constructor?.name;
      if (name === expectedErrorType) return true;
    } catch {}
  } else if (err?.name === expectedErrorType || err?.constructor?.name === expectedErrorType) {
    return true;
  }
  return render(err, instance).includes(expectedErrorType);
}

/**
 * Does a throw out of a runtime-negative test's instantiate or module init
 * count as the expected throw? Without the original harness any throw does.
 */
export function runtimeNegativeThrowAccepted(err, instance, { expectedErrorType, originalHarness, prepared, render }) {
  if (prepared && isWasmTrap(err)) return false;
  return !originalHarness || originalHarnessExceptionMatches(err, instance, expectedErrorType, render);
}

/**
 * Verdict of an async row after the drain and the marker poll:
 * "pass" | "failure-marker" | "no-completion" | "threw-after-completion".
 * A Prepared row drains one module's ring, which stops at its first throw, so
 * a drain error next to a completion marker is a continuation that threw or
 * trapped after `$DONE` ran.
 */
export function asyncRowVerdict({ failureMarker, completed, drainError, prepared }) {
  if (failureMarker) return "failure-marker";
  if (!completed) return "no-completion";
  if (prepared && drainError != null) return "threw-after-completion";
  return "pass";
}
