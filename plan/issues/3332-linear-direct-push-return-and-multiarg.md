---
id: 3332
title: "linear direct path: arr.push returns 0 (not new length) and drops extra args"
status: done
completed: 2026-07-17
sprint: Backlog
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
---

# #3332 — linear direct path push defects

> **Resolution (2026-07-17):** fixed in `src/codegen-linear/index.ts`
> `compileArrayMethodCall` — the `push` handler now (a) holds the receiver in a
> local and loops over **every** argument (multi-arg no longer dropped), and (b)
> reads `__arr_len` for the expression value so push returns the **new length**
> instead of `f64.const 0`. Guarded by `tests/issue-3332.test.ts` (6 cases:
> single/multi-arg return value, no-arg, value ordering, ref-element push) and
> the `#2956` divergence assertions were folded into the direct↔IR parity loop
> (`tests/issue-2956.test.ts`). The IR overlay's single-arg-only gate still
> demotes multi-arg push to the direct path, which is now itself spec-correct.

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
