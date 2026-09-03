---
id: 5310
title: "for-in over a closed-struct receiver enumerates nothing in JS-host mode"
status: done
created: 2026-09-03
updated: 2026-09-03
completed: 2026-09-03
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: for-in, enumeration
goal: npm-library-support
sprint: current
horizon: s
related: [1243, 1271, 2572, 2575, 5311]
---

# #5310 — for-in over a closed-struct receiver enumerates nothing in JS-host mode

## Problem

```ts
export function keys(): string {
  const o = { a: 1, b: 2 };
  let out = "";
  for (const k in o) out += k + ",";
  return out;
}
```

Host mode returned `""`. Standalone returned `"a,b,"`. Same source, same
compiler, opposite answers — and the host answer is the wrong one.

## Root cause

`compileForInStatement` chose its enumeration strategy by asking whether the
`__for_in_*` host imports were **registered**, not by asking what the receiver
actually **lowers to**.

The standalone branch already carried the correct reasoning in a comment: a
closed WasmGC struct "does NOT lower to `$Object`", so `__object_keys` would
return empty, and such a receiver must keep the static-unroll path, "which is
exact for a non-mutated closed shape". But that reasoning only ever ran where
the host imports were absent. In JS-host mode they exist, so control never
reached it: the struct was wrapped with `extern.convert_any` and handed to a JS
function that receives an opaque WasmGC value and enumerates zero keys.

Emitted host WAT for the snippet above — `struct.new 6`, then straight into the
dynamic enumerators:

```wat
(local $o (ref null 6))
f64.const 1
f64.const 2
struct.new 6
local.set 0
...
local.get 0
extern.convert_any   ;; opaque to JS from here on
call 1               ;; __for_in_keys -> 0 keys
```

Standalone, same source, unrolls both keys inline.

The failure is silent: zero iterations is indistinguishable from "the object had
no keys", so the loop body simply never runs and the program carries on with a
default.

## Fix

Choose the strategy from the lowered representation. The two predicates that the
standalone branch already used — `isOpenForInReceiver` and
`forInReceiverIsDynamic` — are now evaluated for every target; a receiver that
is neither open nor dynamic clears the primitive indices so the existing
static-unroll fallback runs. Host and standalone now agree, with standalone as
the reference.

## Tests

`tests/issue-5310-forin-closed-struct-host.test.ts` — 5 cases (data properties,
string values, method values, mixed source order, and an iteration count that
distinguishes "zero iterations" from a formatting difference). **All five fail
on the parent commit and pass with the fix.**

No regressions across the 5 existing for-in suites (32 tests) or the 9
enumeration/object-literal suites (74 tests).

## Measured package impact: none yet

jest is 299/356 both before and after. This is a correctness fix that removes a
host/standalone divergence; it did not move any curated package on its own,
because the packages that walk an options bag reach it through an `any`
parameter, and a struct crossing that boundary is opaque for a separate reason —
see [#5311](5311-closed-struct-crossing-into-any-is-opaque.md), which is what
actually blocks marked.
