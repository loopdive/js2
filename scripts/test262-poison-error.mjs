// Shared test262 worker poison-error classifier.
//
// #1808/#1862: emit/allocation-class failures can leave a long-lived worker or
// its incremental compiler in a bad state. Treat these as contaminated worker
// verdicts: recycle the worker/compiler before accepting another test, and let
// the runner retry the current test in a clean fork before writing JSONL.
export const POISON_ERROR_RE =
  /Binary emit error|offset is out of bounds|out of memory|Array buffer allocation failed|Maximum call stack size exceeded|Invalid (?:typed )?array length/i;

export function isPoisonCompileError(error) {
  return typeof error === "string" && POISON_ERROR_RE.test(error);
}

export function poisonRecycleReason(error) {
  return isPoisonCompileError(error) ? "poison-class compile error (#1862)" : undefined;
}
