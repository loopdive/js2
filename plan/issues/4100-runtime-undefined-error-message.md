---
id: 4100
title: "new Error(m) with a RUNTIME-undefined m renders \"Error: undefined\" instead of the name alone (§20.5.1.1 step 3)"
status: done
sprint: 78
created: 2026-08-02
completed: 2026-08-02
updated: 2026-08-18
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: compiler
area: codegen
language_feature: errors
goal: core-semantics
related: [4035, 2969, 2106, 2877]
---

# Problem

`§20.5.1.1` step 3 is "if message is **not undefined**, set `.message`". Under
`--target standalone`, a message that is undefined only at RUNTIME rendered
`"Error: undefined"`:

```ts
let m: any;
String(new Error(m));   // was "Error: undefined", spec says "Error"
```

The guard at the Error-construction site was a bare `ref.is_null`. Under the
#2106 `undefinedSingleton` regime `undefined` in the externref plane is a
**tag-1 `$AnyValue` box** (`global.get $undefined; extern.convert_any`) — which
is **not null**, so the guard missed it.

#4035 fixed only the **static literal** (`new Error(undefined as any)`) and
deliberately left this residual documented, because the obvious runtime test —
the native `__extern_is_undefined` predicate — requires `ensureObjectRuntime`,
measured at **+3KB on every standalone Error-constructing module**. That
regressed #4035's own binary-size test (22,939 > 20,000), which is why the
static-only fix shipped.

# Fix

Inline the predicate instead of calling the helper: a `ref.test` against
`$AnyValue` plus one `struct.get` of the tag field, OR-ed with the existing
`ref.is_null`. No helper, no import, no object runtime
(`emitNullOrUndefinedMessageTest`, `src/codegen/expressions/new-builtin-globals.ts`).

It stays free because of the gate: emitted **only when the module already has
the `$AnyValue` machinery**. `ensureAnyValueType` is deliberately not called —
if the regime is inactive there is no undefined singleton in that module to
miss, so the bare `ref.is_null` is already complete and correct there.

# Measurements

Rendered message compared by **text**, not length (`"Error"` and any other
5-character string are not the same claim). A/B against the base commit:

| case | base | with fix |
| --- | --- | --- |
| `let m; new Error(m)` | **FAIL** (`"Error: undefined"`) | **PASS** (`"Error"`) |
| `new Error(undefined as any)` | PASS | PASS |
| `new Error()` | PASS | PASS |
| `new Error(42)` → `"Error: 42"` | PASS | PASS |
| `new Error(m)`, m = `"boom"` | PASS | PASS |
| `new Error("")` → `"Error"` | PASS | PASS |

Binary size — the justification for inlining over the helper call:

| module | base | with fix | delta |
| --- | --- | --- | --- |
| minimal Error-throwing | 50,953 | 50,981 | **+28 B** |
| Error + runtime message | 50,914 | 50,942 | **+28 B** |
| no Error at all | 21,257 | 21,257 | **+0 B** |

**+28 bytes against the +3,000 the `ensureObjectRuntime` approach cost** — ~107×
smaller, and nothing at all for modules that construct no Error.

# Known residual (pre-existing, NOT introduced here)

`new Error(null)` renders `"Error"` where the spec wants `"Error: null"` — step
3 exempts only `undefined`. The original `ref.is_null` guard conflated null with
undefined, and this change keeps that behaviour rather than silently widening
scope. **Verified failing on the base commit too**, so it is not a regression.
Pinned as current behaviour in `tests/issue-4100.test.ts` so the gap stays
visible and a future fix has to flip it deliberately.

# Acceptance

- [x] A runtime-undefined message renders the name alone, verified by message text.
- [x] The #4035 static-literal case and the argument-less case still pass.
- [x] Negative controls: string, numeric and empty-string messages are NOT suppressed.
- [x] Size delta measured and shown to avoid the +3KB regression.
- [x] The pre-existing `new Error(null)` residual documented and pinned.
- [x] No LOC/function budget allowance requested (predicate extracted to module scope).
