// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6846 soundness control, in its own module so it compiles on the parent too:
// `count()` runs BEFORE the await, so recompiling this statement after the
// resumption would call it twice. The planner must decline it — whatever the
// result, `count` runs exactly once per call.

import { sus } from "./lib.js";

let calls = 0;
function count() {
  calls = calls + 1;
  return calls;
}
function second(a, b) {
  return b;
}
export async function effectBeforeAwait() {
  return second(count(), await sus());
}
export function callCount() {
  return calls;
}
