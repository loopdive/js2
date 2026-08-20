---
id: 4561
title: "STANDALONE: `break` inside a `for-in` body is a NO-OP — the loop runs to completion and statements after the break execute"
status: done
sprint: current
created: 2026-08-19
updated: 2026-08-19
completed: 2026-08-19
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

## FIXED — `44208e0`, and it was worse than the report

**Root cause: the standalone for-in STATIC-UNROLL path emitted the bodies as a
bare straight-line sequence** — no enclosing `block`, and no
`breakStack`/`continueStack` entry at all (`src/codegen/statements/loops.ts:3511`
pre-fix).

That path is taken when the receiver is a **closed WasmGC struct**: the
`__for_in_*` host imports are absent in standalone (#2572), and a closed shape
cannot gain or lose keys, so the static key set is exact. Host mode has the
imports and takes the real loop — which is exactly the standalone-only column in
the table above.

All the observed behaviours are that one omission:

- **Unlabeled `break`** takes `breakStack.length - 1`; with nothing pushed that
  is `-1` at top level, so `compileBreakStatement` reads `undefined` and returns
  silently. **Inside an enclosing loop it is worse than a no-op — it resolves to
  the OUTER loop's depth and breaks the wrong loop.** The original repro was
  top-level, which is why it merely read as inert.
- **Labeled `break outer`** fails for a *different* reason:
  `compileLabeledStatement` reserves `breakIdx = breakStack.length` for the loop
  it expects to push. Nothing is pushed, so the lookup misses.
- **`continue` was broken too** (it was untested at filing): same two causes.
  `for (k in o) { if (k === "b") continue; n++ }` counted 3 of 3.
- **`return` worked** because an unrolled body is still inside the enclosing
  function and needs no loop target — which is precisely what made the defect
  look break-specific.

**Fix:** the unroll now carries `block $break { block $continue { … } … }`.
`continue` is `br 0` and falls into the next iteration's block, which
materialises its own key, so enumeration still advances; `break` is `br 1` past
every remaining iteration. Two nesting levels where the real-loop paths use three
(there is no `loop`). Extracted to
`src/codegen/statements/for-in-static-unroll.ts`; `loops.ts` shrinks 3782 → 3769.
The extraction is deliberately **not** verbatim and rides in the same commit,
because the scaffolding *is* the change.

## Verification

- **Conformance row: `language/statements/labeled/S12.12_A1_T1.js`.** Sweep of
  `language/statements/{for-in,break,continue,labeled}`: **122/154 → 123/154, 0
  newly failing.** The four `for-in/cptn-*` completion-value rows there are
  QuickJS-blocked locally, so CI may show more.
- **New suite `tests/issue-4561-forin-break-continue.test.ts`, 12 cases: 8 fail
  without the fix, 12/12 with.** The 4 that pass either way are negative controls
  (dynamic receiver, array receiver, plain full enumeration). Covers labeled
  break/continue on the for-in itself, labeled break out of an enclosing loop,
  for-in nested in a plain `for` (the break-the-wrong-loop case), and for-in in
  for-in.
- **Loop/control-flow suites base vs branch: 17 failing → 17 failing, 0 newly
  failing, 0 newly passing** — which is *why* the new suite was needed: nothing
  existing covered this.
- Standalone now matches the JS-host lane exactly on all 13 probed shapes.
- Guard **551/551**; independently re-verified by the integrator (unlabeled
  break, labeled break, plain-`for` break, and `return`-from-for-in all pass on
  the integration branch).
