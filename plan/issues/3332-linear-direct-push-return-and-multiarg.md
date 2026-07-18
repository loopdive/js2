---
id: 3332
title: "linear direct path: arr.push returns 0 (not new length) and drops extra args"
status: done
completed: 2026-07-17
assignee: ttraenkler/dev-standalone2
sprint: current
goal: backend-agnostic-ir
feasibility: medium
depends_on: []
priority: medium
es_edition: ES3
language_feature: arrays
task_type: bug
area: codegen-linear
horizon: s
created: 2026-07-17
updated: 2026-07-17
related: [2956, 1854]
loc-budget-allow:
  # Intended +13 LOC in the direct-path push lowering: evaluate the receiver
  # once into a local, loop over all arguments, and read __arr_len back for the
  # expression-position new-length result (fixes the returns-0 / drops-args bug).
  - src/codegen-linear/index.ts
---

## Resolution (2026-07-17)

Fixed the DIRECT linear-path `Array.prototype.push` lowering in
`src/codegen-linear/index.ts` (`compileArrayMethodCall`, `methodName === "push"`):

- The receiver is evaluated **once** into a fresh i32 local (so a
  side-effecting receiver expression is not re-run per argument).
- **Every** argument is appended (loop over `expr.arguments`), fixing the
  dropped-extra-args defect.
- The expression-position result is now the **new length** — after the pushes,
  `__arr_len(arr)` is read back and converted to f64 — instead of the previous
  `f64.const 0`.

Guarded by `tests/issue-3332.test.ts` (6 cases, direct path forced via
`JS2WASM_LINEAR_IR=0`). The two forward-looking `#3332` assertions in
`tests/issue-2956.test.ts` (direct `pushExpr` returning `8`; demoted multi-arg
`multiPush` returning length `2`) were flipped to their spec-correct values
(`28` folded into the parity loop; `3`), as those comments instructed.

# #3332 — linear direct path push defects

## Problem

Found while validating the #2956 L2 vec-mutation sub-slice (linear-IR
overlay). The DIRECT linear path (`--target linear`, no `JS2WASM_LINEAR_IR`)
mis-lowers `Array.prototype.push`:

```ts
export function pushRet(): number { const a = [1]; return a.push(8); }
// direct linear: 0     JS/spec: 2 (the new length)
export function multiPush(): number { const a = [1]; a.push(2, 3); return a.length; }
// direct linear: 2     JS/spec: 3 (extra args dropped)
```

The IR overlay path (selector-claimed, `JS2WASM_LINEAR_IR=1`) is
spec-correct for the single-arg expression-position case (returns the new
length via the shared from-ast lowering) — so the direct path now DIVERGES
from the overlay on the same source. `tests/issue-2956.test.ts` documents
the divergence with explicit assertions referencing this issue.

## Fix sketch

`src/codegen-linear/` push lowering: (a) expression position must yield the
new length (`__arr_push` is void — read `__arr_len` after, or return len
from the helper); (b) multi-arg push must loop all arguments. Note the IR
overlay's single-arg-only gate demotes multi-arg push to the direct path,
so (b) also unblocks overlay-adjacent parity.

## Acceptance

- `a.push(v)` in expression position returns the new length on the direct
  linear path.
- Multi-arg `a.push(x, y, …)` appends all values.
- Cross-backend corpus rows for push flip to executed parity.
