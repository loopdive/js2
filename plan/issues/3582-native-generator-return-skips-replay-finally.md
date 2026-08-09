---
id: 3582
title: "Native generator: `return v` inside try/finally SKIPS the finally (silent wrong answer, standalone/wasi)"
status: ready
created: 2026-07-24
updated: 2026-07-24
priority: high
feasibility: medium
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: m
related: [2864, 3050]
umbrella: 2864
---

# Native generator: an explicit `return` inside try/finally skips the finally

## Problem

In a Wasm-native (standalone / wasi) generator, an explicit `return <expr>`
inside a `try` whose `finally` is **yield-free** does **not** run the finally.
This is a **silent wrong answer**, not a refusal — the generator completes with
the right value but the cleanup never happens.

Verify-first repro (`--target standalone`, compiles host-free, `imports = []`):

```ts
let log = 0;
function* g() {
  try {
    yield 1;
    return 5;
  } finally {
    log = 3;
  }
}
export function test(): number {
  const it = g();
  const a = it.next().value as number;
  const r = it.next();
  return log * 100 + a * 10 + (r.value as number);
}
```

| lane              | result                      |
| ----------------- | --------------------------- |
| Node              | `315` (log=3, a=1, value=5) |
| standalone / wasi | **`15`** — `log` stayed 0   |

Also reproduces with **no yield inside the try** at all
(`yield 1; try { return 5 } finally { log = 3 }` → `15` vs `315`), so it is not
a suspension-crossing issue: it is the `return` lowering itself.

Split out of #2864 D4 (2026-07-24) so the D4 `doneState` fix ships as its own
slice.

## Root cause

`buildNativeGeneratorPlan` → `lowerStatements`, the `ts.isReturnStatement`
branch (`src/codegen/generators-native.ts`). It bails only when the unwind
chain contains a **state-lowered** finally:

```ts
if (unwind.some((e) => e.kind === "finally")) return fail();
collectSpillsIn(stmt);
finishState(curId, { kind: "return", expr: stmt.expression });
```

A **legacy kind-L region** (finally-only with a yield-free finally, the
byte-identical pre-#3050 path) contributes `replay` entries to `unwind`, not
`finally` entries. `replay` entries are neither run nor bailed on here — so the
finalizer statements are simply dropped on the `return` path. They ARE run on
the normal fallthrough path (`lowerStatements` pushes them into the current
state's prelude after lowering the try body) and on the abrupt-resume path
(`startStateAfterYield` captures them into `abruptResume.finalizers`); only the
explicit-`return` path misses them.

## Implementation notes (read before coding)

**Do the finalizers on the `return` TERMINATOR, not in the state prelude.**
JS order is: evaluate the return expression FIRST, then run the finally
(`try { return f() } finally { g() }` calls `f()` before `g()`). Pushing the
finalizer statements into `curStatements` runs them **before** the terminator
compiles `expr` — wrong order, observable whenever the finally writes anything
the return expression reads.

So: add an optional `finalizers?: ts.Statement[][]` to the `return` terminator
and, at emit time, compile `expr` into the result local first, then run the
finalizers, then complete. This mirrors what the abrupt tail already does
(`storeSpills` → set done → build result) and what
`emitUnwindWalk`'s `replay` arm does.

**Do NOT** try to introduce a synthetic `const __genret = expr;`
`VariableStatement` to hold the value: a factory-created identifier has no
checker type, so `resolveSpillLocalValType` (and the whole spill-typing
cascade) cannot type it. The existing synthetic nodes in this file all re-use
REAL declaration lists / expressions for exactly this reason.

**Ordering:** `unwind` is threaded **outermost-first**; every existing consumer
(`startStateAfterYield`, the `emitYield` asterisk branch) `.reverse()`s it to
innermost-first before use. Match that — innermost finally runs first.

**Scope note:** only `replay` entries need handling here. The
state-lowered-`finally` case keeps its existing clean `fail()` bail (that is
the return-through-a-_suspending_-finally path, a separate capability — the
async analogue is #2906 3c-ii-b).

## Acceptance criteria

- The repro above returns `315` on `--target standalone` and `--target wasi`,
  host-free (`result.imports` empty).
- The no-yield-in-try variant returns `315` too.
- Nested try/finally around a `return` runs finalizers innermost-first.
- A finally that MUTATES a variable read by the return expression still
  observes JS order (expression evaluated first).
- Byte-stability: generators with no `return`-inside-a-replay-region are
  byte-identical across gc / standalone / wasi.

## Test plan

Extend `tests/issue-2864-standalone-generator-carrier.test.ts` (or a new
`tests/issue-3582-*.test.ts`) with the standalone cases above, zero-host-import
asserted. test262: `test/language/statements/return/**` and
`test/language/statements/generators/**` shapes that pair `return` with
`finally`.
