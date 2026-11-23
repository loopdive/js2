// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Runtime-phase verdict rules of every test262 lane (the worker, the fixture lane,
// the local runner) that depend only on the thrown value, so they can be tested
// without a compiler bundle (#7354 U0, X).
//
// A Wasm trap is never a JavaScript throw. Its message carries the frame names
// (`unreachable [in Test262Error() ← assert]`), so a name match on the rendered
// text counts a trap inside a function named after the expected error as the
// expected throw. The Prepared lane refuses that; every other lane keeps the
// published behaviour until #7447 measures and lands the same rule there.

import { isWasmTrap } from "./lib/wasm-exn-render.mjs";

/**
 * (#7354 X) Did `err` carry the expected error type? `thrown` is its reading by `readThrownValue`
 * (scripts/lib/wasm-exn-render.mjs), `{ kinds, text }`. Only a KIND that was read counts — never message text, and
 * never the label written for a value that could not be read (it has no kind): a pass needs the thrown value
 * positively known to be of that type.
 */
function originalHarnessExceptionMatches(err, thrown, expectedErrorType) {
  if (!expectedErrorType) return true;
  // #7447 keeps the published trap rule on the non-Prepared lanes until it is measured: a trap matches by the
  // frame names in its reader text.
  if (isWasmTrap(err)) return thrown.text.includes(expectedErrorType);
  return thrown.kinds.includes(expectedErrorType);
}

/**
 * Does a throw out of a runtime-negative test count as the expected throw? Without the original harness any throw
 * does.
 */
export function runtimeNegativeThrowAccepted(err, thrown, { expectedErrorType, originalHarness, prepared }) {
  if (prepared && isWasmTrap(err)) return false;
  return !originalHarness || originalHarnessExceptionMatches(err, thrown, expectedErrorType);
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
