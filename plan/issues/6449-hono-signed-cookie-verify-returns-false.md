---
id: 6449
title: "hono `getSignedCookie` answers `false` for a VALID signature — the eight remaining `cookie.test.ts` parse rows, now that signing itself is correct"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: high
horizon: m
feasibility: medium
task_type: bug
area: runtime
goal: dogfood
---

## Problem

Eight rows of hono `src/utils/cookie.test.ts` fail identically — the parse
returns the boolean `false` where a cookie VALUE was expected:

```
Should parse signed cookies                                    false != "choco"
Should parse signed cookies with binary secret                 false != "choco"
Should parse signed cookies containing the signature separator false != "choco.chip"
Should parse signed cookies and return "false" for wrong signature   false != "choco"
Should parse signed cookies and return "false" for corrupt signature false != "strawberry"
Should parse one signed cookie specified by name               false != "strawberry"
Should parse signed cookies and ignore regular cookies         false != "strawberry"
Should ignore NBSP-prefixed signed cookie names …              false != "choco"
```

Measured on `699df289e1` + the
[#6421](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6421-spread-into-static-builtin-drops-arguments)
fix (hono 262/324, `cookie.test.ts` 25/35).

## Why this is a SEPARATE defect from #6421

#6421 attributed all nine signed-cookie failures to
`String.fromCharCode(...new Uint8Array(signature))` collapsing to one byte, on
the theory that `verifySignature` cannot match a signature produced from a
truncated buffer. The first half of that is confirmed and fixed; the second
half is **not** what is happening.

The proof is in the two serialize rows, on the same run:

| row | base | with #6421 |
| --- | --- | --- |
| `Should serialize signed cookie with all options` | `banana.AA%3D%3D` — the `AA==` symptom | **passes** |
| `Should serialize a signed cookie` | — | `macha.diubJPY8O7hI1pLa42QSfkPiyDWQ0I4DnlACH%2FN2HaA%3D`, the real 44-char digest; fails only on a spurious `Max-Age=0` ([#6423](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6423-absent-number-property-stringifies-as-nan)) |

So the SIGNING side now produces the correct digest, and the eight parse rows
still answer `false`. Verification has its own defect. #6421 moved hono
261 → 262, not the predicted 261 → ~270; these eight are the gap.

## Lead

`verifySignature` (`src/utils/cookie.ts:58-62`) wraps its whole body in
`try { … } catch { return false }`, so ANY exception on that path becomes
exactly the observed `false` — it cannot be told apart from a genuine
signature mismatch by the test. On the same build, hono's own
`src/utils/crypto.test.ts` is 0/4 with **`TextEncoder is not a constructor`**
(and one `update is not a function`), and `verifySignature` calls
`new TextEncoder().encode(value)`. That is a plausible cause and the first
thing to check — but it is a lead, not a measurement: it does not explain by
itself why the signing path, which also encodes, produces a correct digest.
Instrument the catch (or run the body without it) before assuming.

## Acceptance criteria

1. Name the actual exception (or genuine mismatch) behind each of the eight
   rows — measured, not inferred from the catch.
2. All eight pass, including the two that legitimately expect `false`
   (wrong signature, corrupt signature) — those must answer `false` for the
   RIGHT reason, so a fix that merely stops throwing must still reject a bad
   signature.
3. Regression test under `tests/`, failing on the parent, exact counts both ways.
4. A/B over the 17 dogfood suites at one HEAD. Expected mover: hono
   `src/utils/cookie.test.ts` 25/35 → 33/35.
5. If `TextEncoder is not a constructor` is the cause, say whether hono's
   `crypto.test.ts` (0/4) is the same defect or a separate one.

## Dispatch

Model: **opus**. The swallowing `catch` means the symptom carries no
information, so the work is in getting the real error out before anything can
be diagnosed.
