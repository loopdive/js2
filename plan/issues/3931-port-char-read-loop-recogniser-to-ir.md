---
id: 3931
title: "Port detectCanonicalCharReadLoop into the IR front-end — the #2682 charCodeAt hoist has been dead for standalone and wasi all along, and #3907 removed its last hiding place"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: high
feasibility: medium
reasoning_effort: high
task_type: optimization
area: codegen
language_feature: string-methods
goal: backend-agnostic-ir
sprint: current
horizon: l
es_edition: multi
related: [2682, 3907, 3521]
---

# #3931 — port the canonical char-read-loop recogniser into the IR front-end

## Status: open — a pre-existing IR-adoption gap, exposed by #3907

## Problem

`detectCanonicalCharReadLoop` (`src/codegen/statements/loops.ts`) recognises the
canonical `charCodeAt` read loop — the shape `(h * 31 + s.charCodeAt(i)) | 0`
over a string — and hoists the bounds/flatten work out of the loop. It is the
#2682 optimisation, and it is a real win on string-hash-shaped code.

It lives on the **legacy AST path**. The IR overlay has since taken ownership of
those function bodies in most configurations, so the recogniser **never fires**
there. Probed on the pre-#3907 base branch, the hoist was already dead for:

- `nativeStrings` alone
- `target: "standalone"`
- `target: "wasi"`

It survived in **exactly one** configuration — `fast + nativeStrings` — and only
because fast mode's i32 grounding created an ABI drift that kept the IR selector
out of those bodies. #3907 removed that drift (it *was* the bug: fast mode was
lowering every `number` to i32), so the recogniser now has nowhere left to fire.

**This is not a capability #3907 destroyed. It is a gap that existed for
standalone and wasi all along, hidden in one configuration by a correctness
bug.** Standalone and wasi have been missing this optimisation independently of
#3907 the whole time.

## Why re-keying it on `type i32 = number` does NOT work

The obvious cheap fix — re-key the recogniser on the explicit `i32` annotation
(#3673) so it survives without fast mode's implicit i32 — was considered and
rejected on evidence. The loop is `(h * 31 + s.charCodeAt(i)) | 0` over plain
`number`; the blocker is **body ownership** (which front-end compiles the
function), not the i32 proof. An annotation cannot hand the body back to the
legacy path.

## Scope

1. Port `detectCanonicalCharReadLoop` into the IR front-end so the hoist fires
   wherever the IR owns the body — which is now effectively everywhere.
2. Verify it fires for `fast`, `standalone`, `wasi` and plain host mode. The
   standalone/wasi cases are **new capability**, not restoration.
3. Re-point `tests/issue-2682.test.ts`. That file currently carries a
   prominent `⚠️ KNOWN CAPABILITY GAP` block and a **pinned owner assertion**
   deliberately added by #3907, so that whoever ports the recogniser sees the
   test flip and must update it consciously rather than by accident. Remove the
   gap block as part of this work.
4. Re-measure the string-hash-shaped workloads. #1746 and the string-hash epic
   are the natural beneficiaries.

## Acceptance criteria

1. The hoist fires under the IR front-end in all four configurations above.
2. `tests/issue-2682.test.ts`'s gap block and owner pin are removed, and its
   shape assertions re-point to the IR-emitted output.
3. A measured before/after on a string-hash workload, in standalone or wasi —
   those are where the gap has been silently costing us.

## Notes

`tests/issue-2682.test.ts` kept **every result assertion** through #3907 — all
still byte-faithful and passing. Only the emitted-shape expectations changed.
So this is a performance gap, not a correctness one, and nothing about the
observable behaviour of the affected programs is wrong today.

Filed at the request of `issue-3907-i32-wrap`, which made the judgement call to
accept the loss rather than prop it up, and documented the reasoning rather than
silently weakening the test. That call looks right: propping it up would have
preserved a single-configuration accident while leaving standalone and wasi
uncovered.
