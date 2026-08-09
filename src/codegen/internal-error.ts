// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4030 — provenance for exceptions that escape into a codegen catch.
//
// A `RangeError`/`TypeError` reaching one of codegen's generic `catch` blocks is
// ALWAYS a compiler bug, never a user diagnostic. Reporting only `e.message`
// discards the one thing needed to act on it. Two concrete costs already paid:
//
//   - #4019 surfaced as bare `Maximum call stack size exceeded`. Localising it
//     needed a hand-patched catch and a full re-run of a ~9-minute compile.
//   - #4038 is `Cannot read properties of undefined (reading 'kind')` with no
//     file, function or frame — currently undiagnosable without the same tax.
//
// So: name the innermost `src/` frame in the message itself. It is one line of
// output, it cannot be wrong (it is read off the real stack), and it turns an
// unactionable string into a pointer.

/** Frames inside the compiler itself, not node internals or dependencies. */
const SRC_FRAME = /\(?((?:\/|[A-Za-z]:\\)?[^\s()]*(?:src[/\\][^\s()]+?)):(\d+):(\d+)\)?/;

/**
 * The innermost compiler frame of `error`'s stack, as `src/foo.ts:12:34`.
 *
 * Returns `undefined` when there is no stack, or no frame inside `src/` — a
 * throw from a dependency or from a synthesized function has nothing useful to
 * point at, and inventing a location would be worse than omitting one.
 */
export function innermostCompilerFrame(error: unknown): string | undefined {
  if (!(error instanceof Error) || typeof error.stack !== "string") return undefined;
  for (const line of error.stack.split("\n").slice(1)) {
    // Skip this module's own frames so the pointer is never self-referential.
    if (line.includes("internal-error.ts")) continue;
    const match = SRC_FRAME.exec(line);
    if (!match) continue;
    const [, file, row, column] = match;
    if (file === undefined) continue;
    // Trim everything before `src/` so the pointer is repo-relative and stable
    // across checkouts (absolute container paths are noise in a diagnostic).
    const index = file.lastIndexOf("src/") >= 0 ? file.lastIndexOf("src/") : file.lastIndexOf("src\\");
    return `${index >= 0 ? file.slice(index) : file}:${row}:${column}`;
  }
  return undefined;
}

/**
 * Render an internal exception for a user-facing diagnostic: the message plus
 * the innermost compiler frame when one is available.
 *
 * `JS2WASM_CODEGEN_STACK=1` additionally writes the full stack to stderr, for
 * the cases where one frame is not enough (mutual recursion, for instance,
 * where the repeating pair is the actual finding).
 */
export function describeInternalError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (typeof process !== "undefined" && process.env?.JS2WASM_CODEGEN_STACK && error instanceof Error) {
    process.stderr.write(`[js2:internal] ${message}\n${error.stack ?? "<no stack>"}\n`);
  }
  const frame = innermostCompilerFrame(error);
  return frame === undefined ? message : `${message} (at ${frame})`;
}
