---
id: 7255
title: "IR claim-then-demote: a `s || \"d\"` function whose value is taken leaves dead string-carrier helpers in the binary"
status: ready
sprint: Backlog
created: 2026-11-06
updated: 2026-11-06
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7251, 7106, 1370]
---

# #7255: `s || "d"` value use claims, then demotes at the typeIdx parity guard

Found in the #7251 review (PR #7096, comment 6673471963; still present on
d1cc9912a0 per 6673554384).

```js
function f(s) { return s || "d"; }
var h = f;              // the function's VALUE is taken
export function test() { return h("x") + f(undefined); }
```

On gc, standalone and wasi the compile logs `IR path failed for f: function
typeIdx parity mismatch … [IR-FALLBACK]`. The result is correct (legacy body),
but the IR attempt leaves dead `__ir_string_carrier` / `__wrapper_string_value`
helpers in the binary.

**Cause:** #7251's `||`/`&&` left-operand projection (`collectIrImplicitParamProjectionCandidates`,
`src/codegen/index.ts`) admits the body, while the stored-value use of `f`
gives it a legacy slot whose typeIdx the IR signature cannot match; the
mismatch is only found after the claim (#1370 parity guard).

**Fix:** refuse before the claim — when the function has a stored VALUE use and
its projected signature would differ from the legacy slot type, the selector
must not claim it. Add a test that asserts no `[IR-FALLBACK]` diagnostic and
no dead helper for this shape on 3 lanes.
