---
id: 3931
title: "Port detectCanonicalCharReadLoop into the IR front-end — the #2682 charCodeAt hoist has been dead for standalone and wasi all along, and #3907 removed its last hiding place"
status: done
completed: 2026-08-15
created: 2026-07-31
updated: 2026-08-18
assignee: ttraenkler/dev-3931
loc-budget-allow:
  # The recogniser itself is a NEW module (src/ir/char-read-loop.ts). What
  # lands in these two is the half that structurally cannot leave them: the
  # preheader/read-site EMISSION needs `LowerCtx` + the IR builder + `lowerExpr`
  # (from-ast), and the backend plan needs the string-mode discriminator
  # (integration's resolver, per the #2955 discipline).
  - src/ir/from-ast.ts
  - src/ir/integration.ts
func-budget-allow:
  # One interception each, at the only points where they can go: before the
  # receiver is lowered (lowerMethodCall) and alongside the other string-mode
  # plans (makeFromAstResolver).
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/integration.ts::makeFromAstResolver
priority: high
feasibility: medium
reasoning_effort: high
task_type: optimization
area: codegen
language_feature: string-methods
goal: backend-agnostic-ir
sprint: 78
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

## Resolution (2026-08-15)

### What landed

- **`src/ir/char-read-loop.ts`** (new) — the recogniser and the read-site
  matcher, the IR twins of `detectCanonicalCharReadLoop` /
  `matchHoistedCharRead`. It discharges legacy's proof using legacy's OWN
  predicates, re-imported from `src/codegen/statements/loop-analysis.ts`
  (`detectI32LoopVar`, `isIncreasingStep`,
  `loopBodyMutatesStringReadInvariants`, `bodyHasMatchingCharRead`), so the two
  front-ends cannot drift apart on what "canonical" means.
- **`src/ir/from-ast.ts`** — the emission half: `lowerForStatement` installs the
  proof (and the preheader hoist) on a body-scoped `LowerCtx.provenCharReads`,
  exactly like #2766's `safeIndexedArrays`; `lowerMethodCall` intercepts a
  proven `recv.charCodeAt(i)` before the receiver is lowered; `emitI32PureExpr`
  takes the i32 code unit directly.
- **`src/ir/i32-pure-bitwise.ts`** — a proven char read is now the ONE admitted
  call leaf for #3758's native-i32 composition. This is the half that actually
  moves the clock: it turns `(h * 31 + c) | 0` from ~30 `i64.*` ToInt32
  bit-decomposition ops into `i32.mul` + `i32.add`.
- **`src/codegen/char-code-at-helpers.ts` + `src/ir/integration.ts`** — the
  unguarded runtime halves (`__str_flat_charCodeAt`,
  `__jsstr_charCodeAt_trusted`) and the `charReadPlan()` resolver callback that
  selects between them, keeping from-ast free of any `nativeStrings` read.
- **Tests** — `tests/issue-3931.test.ts` (new, 19 cases) and the re-pointed
  `tests/issue-2682.test.ts`.

### Deviation from legacy, and why

Legacy hoists `flat`, `.data` AND `.off` into three locals, so its read is a
bare `array.get_u`. The IR hoists only the **flatten**; `.data`/`.off` stay
inside `__str_flat_charCodeAt` (two `struct.get`s per read).

That is not an oversight, it is the ABI boundary. An IR value typed with a raw
backend `ref N` has no symbolic Program ABI type identity, and
`ir/prepared-component-dependencies.ts` REFUSES a prepared component that
carries one (`implicit-support-reference-unavailable: raw IR reference type
ref:7 …`). The first cut of this work did hoist the descriptor that way, and
the result was measured: `nativeStrings`, `standalone` and `wasi` all demoted
the whole function back to legacy — i.e. a "faster" hoist that silently turned
the optimisation OFF in three of the five configurations. Everything the IR
touches here is therefore typed `string` (carrier-backed) or `i32`. Recovering
the last two `struct.get`s means giving `$NativeString`/`$StrData` symbolic ABI
identities, which is a separate change with its own ordering risk.

### Measured before/after (AC 3)

`.tmp/bench-3931b.mts`, 400 hashes of a 2200-code-unit string, median of 7,
same box, base = this branch's parent (file-copy A/B, both sides re-run twice):

| lane            | before   | after   | speed-up |
| --------------- | -------- | ------- | -------- |
| **standalone**  | 22.26 ms | 1.12 ms | **19.9x** |
| **wasi**        | 19.72 ms | 1.09 ms | **18.1x** |
| `nativeStrings` | 18.14 ms | 1.09 ms | 16.6x    |
| host            | 16.17 ms | 1.61 ms | 10.0x    |

All four lanes return the byte-identical hash the JS reference does, before and
after. Repeat run: 18.46 / 19.11 / 18.05 / 17.83 ms before, 1.43 / 1.10 / 1.11 /
1.63 ms after.

**Shape matters for anyone re-measuring this.** The subject string has to reach
the loop as a value the IR front-end owns the body for. A same-function string
LITERAL demotes to legacy — where #2682's own hoist has always fired — so the
obvious `const TEXT = "…"` benchmark measures **nothing** and reports a flat 0%.
The benchmark above therefore builds its subject through a call
(`let text = mk(); …`), which keeps the body IR-owned in every lane and takes
numbers in / numbers out so standalone and wasi can run it unchanged.

Emitted `hashStr` in `nativeStrings`: 152 → 63 WAT lines, all 26 `i64.*` ops
gone, one flatten in the preheader instead of one per iteration.

### Acceptance criteria

1. **Met.** The hoist fires under the IR front-end in `fast+nativeStrings`,
   `nativeStrings`, `standalone`, `wasi` and host — asserted per configuration
   in `tests/issue-3931.test.ts`. Host has no flattenable descriptor, so there
   the proof buys the dropped bounds/NaN guard rather than a hoist; that
   difference is asserted explicitly rather than papered over.
2. **Met.** The `⚠️ KNOWN CAPABILITY GAP` block and the owner pin are gone from
   `tests/issue-2682.test.ts`; its shape assertions now pin the IR-emitted form
   (`$$slot___cca_flat`, `array.get_u`, no `f64.const nan`), and the negative
   cases assert on `__cca_` so they stay meaningful for BOTH front-ends.
3. **Met.** Table above.

### Validation

- `tests/issue-3931.test.ts` 19/19, `tests/issue-2682.test.ts` 12/12 (every
  pre-existing result assertion unchanged and still passing).
- `pnpm run check:ir-fallbacks` OK (no unintended/post-claim/module-level
  growth), `check:oracle-ratchet`, `check:pushraw`, `check:ir-only`,
  `check:ir-adoption`, `check:stack-balance`, `npm run lint` all OK.
- `npx tsc --noEmit`: 486 pre-existing `@types/node` resolution errors on this
  container, identical count on the unmodified base — none from these files.
- `tests/issue-325.test.ts` fails 6/6 on this branch AND on its unmodified
  parent (`LinkError: env.__throw_type_error`) — pre-existing, not this change.

### Follow-ups worth filing

- The loop CONDITION still round-trips through f64 (`i < s.length` emits
  `f64.convert_i32_s` on both sides then `f64.lt`) even though both operands are
  i32. Cheap next win on the same loops.
- Give `$NativeString` / `$StrData` symbolic Program ABI type identities so the
  `.data`/`.off` descriptor can be hoisted too (see "Deviation" above).
