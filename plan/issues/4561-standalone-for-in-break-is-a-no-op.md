---
id: 4561
title: "STANDALONE: `break` inside a `for-in` body is a NO-OP — the loop runs to completion and statements after the break execute"
status: ready
sprint: current
created: 2026-08-19
updated: 2026-08-19
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: for-in
goal: es5
related: [4206, 4515, 4163]
origin: "2026-08-19 ES5 standalone push. Found by the #4206 lane as the sole blocker for S12.10_A1.5_T5; independently reproduced and characterised by the integrator on clean main."
---

# #4561 — `break` in `for-in` does nothing (standalone)

## Severity: this is an everyday idiom, silently wrong

`break` inside a `for-in` body does not exit the loop. The loop runs to
completion **and the statements after the `break` execute**. No error, no trap —
just wrong control flow. Any standalone program that searches an object with
`for (k in o) { …; break; }` gets the wrong answer.

It surfaced as one conformance row (`language/statements/with/S12.10_A1.5_T5`,
whose `with` body starts with `break`), but the row count badly understates it.

## Reproduction — verified by the integrator on clean `main`, not on a lane branch

```js
var o = { a: 1, b: 2, c: 3 };
var seen = 0;
for (var k in o) {
  seen = seen + 1;
  if (seen > 1) { throw new Error("SECOND ITERATION"); }
  break;
}
// standalone: throws SECOND ITERATION
```

```bash
npx tsx .tmp/t262.mts /tmp/forinrepro/forin.js          # FAIL (standalone)
npx tsx .tmp/t262.mts --js-host /tmp/forinrepro/forin.js # PASS
```

## Characterisation — measured, all on clean `main`

| case | standalone | js-host |
| --- | --- | --- |
| `break` in `for-in` | **BROKEN** — runs all 3 iterations | PASS |
| labeled `break outer` in `for-in` | **BROKEN** — runs all 3 iterations | — |
| `break` in a plain `for` loop | PASS | — |
| `return` inside a `for-in` body | PASS | — |

Two facts that should narrow the search quickly:

1. **It is standalone-only.** The js-host lowering is correct, so this is not a
   front-end/IR problem — it is the standalone `for-in` lowering specifically.
2. **`return` from inside the body works, but `break` does not.** So the body is
   not wholly detached from its enclosing control flow; it is the loop's own
   break target that is wrong or missing. Labeled break failing the same way
   suggests the branch target is not being registered in `labelMap` for the
   for-in form, rather than a depth-arithmetic slip on an unlabeled break.

Likely surface: `src/codegen/statements/loops.ts` (the for-in lowering) and
whatever registers the loop's break label in `FunctionContext.labelMap`.

## Acceptance criteria

- All four cases above behave correctly under `--target standalone`.
- Regression tests added for unlabeled `break`, labeled `break`, `continue`, and
  `break` from a `for-in` nested inside another loop — `continue` is untested
  above and may share the defect.
- The 551-row standalone ES5 guard stays clean, and the 121-module
  prototype-write corpus (run **one test per process, sequentially**) stays at
  its `main` baseline.

## Note on ownership

Found by the #4206 lane, which deliberately did **not** take it: `loops.ts` is
another lane's surface and it did not want to collide mid-push. Unowned as of
filing.
