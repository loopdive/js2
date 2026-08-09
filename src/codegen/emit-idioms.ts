// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Emit-idiom builders for the WasmGC backend (#3105).
//
// The WasmGC runtime hand-rolls the same small Wasm instruction scaffolds at
// dozens of sites — one copy per operation. Each copy re-derives the same
// operand order, branch depths, and local layout by hand, which is both
// duplication and a latent bug surface (a mistyped operand or a wrong branch
// depth is exactly what the stack-balance layers exist to catch).
//
// These builders return the **byte-identical** instruction sequence the sites
// already emit — same ops, same operand order, same `blockType`, same branch
// depths — so migrating a site is provably a no-op for the emitted binary
// (`scripts/prove-emit-identity.mjs`). They are per-backend by design: the
// WasmGC and linear backends stay separate (#1527).

import type { Instr } from "../ir/types.js";

/**
 * Counted forward loop: `for (; i < bound; i += step) { body }`.
 *
 * This is the counter-loop idiom of #3105 — a `block { loop { … } }` nest whose
 * head tests `i >= bound` (signed) and `br_if`s out of the enclosing block, runs
 * `body`, then increments `i` by `step` and `br`s back to the loop top. It is the
 * exact scaffold hand-rolled across the WasmGC runtimes (e.g. the JSON string /
 * value writers in `json-runtime.ts`).
 *
 * The caller supplies:
 *  - `i`      — the local holding the counter (read for the guard + the bump);
 *  - `bound`  — the instructions that push the (signed-`i32`) loop bound; the
 *               guard compares `i >= bound` via `i32.ge_s`;
 *  - `body`   — the loop body. Its branch depths are relative to the `loop`
 *               exactly as when hand-rolled: `br 0` continues, `br 1` exits — the
 *               builder wraps `body` in the identical two-level nest, so any
 *               `br`/`br_if` already inside `body` keeps its meaning unchanged;
 *  - `step`   — the increment (default `1`).
 *
 * Returns a single `block` instruction (the whole scaffold), so a call site
 * spreads it: `...counterLoopInstrs({ i, bound, body })`.
 */
export function counterLoopInstrs(opts: { i: number; bound: Instr[]; body: Instr[]; step?: number }): Instr[] {
  const { i, bound, body, step = 1 } = opts;
  return [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: i },
            ...bound,
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            ...body,
            { op: "local.get", index: i },
            { op: "i32.const", value: step },
            { op: "i32.add" },
            { op: "local.set", index: i },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}
