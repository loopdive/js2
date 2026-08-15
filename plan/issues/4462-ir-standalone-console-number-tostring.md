---
id: 4462
title: "IR: standalone console.log sink + native number_toString, so console-using units claim host-free"
status: ready
sprint: current
created: 2026-08-15
priority: medium
horizon: l
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir
goal: ir-full-coverage
related: [4457, 3518, 2856, 3469, 3912]
---

# #4462 — IR knows only the host-import form of `console.*` and number `.toString()`

Spun out of **#4457** (standalone-lane `body-shape-rejected` attribution). This
is the second of the two chains that issue measured but deliberately did not
attempt. It is the more tractable of the two — and it is a **chain**, which is
the single most important thing to know before starting.

## Problem

Two units of the `check:ir-only` **standalone** reference corpus reject at
`console`:

| unit | reject arm |
|------|-----------|
| `website/playground/examples/js/algorithms.ts::main` | `expr-ident-host-surface-deferred` (`console`) |
| `website/playground/examples/js/classes.ts::main` | `expr-ident-host-surface-deferred` (`console`) |

Both are `host-surface-unavailable` as of #4457. That reason is a **mixed
bucket by design**: DOM members of it are permanent, but `console` is *not* —
standalone has a fully host-free console path that legacy already uses, so
these two are fixable and this issue is the tracked owner.

## Root cause, and the chain behind it

`console` is only the **first-wins** reject arm. #4457 probed past it by
temporarily opening the selector, and found three layers:

1. **`console.log` lowering.** Standalone has a host-free sink —
   `ensureStandaloneStdoutSink` / `__stdout_append` +
   `emitStandaloneStdoutAppendValue` (`src/codegen/native-strings.ts:2203`,
   #3469), which routes through the import-free `__any_to_string`. The IR's
   console arm (`src/ir/from-ast.ts:6644`) knows only the host-import form,
   `irImportFuncRef("env", "console_log_<variant>")`, which does not exist in a
   standalone module. Verified: `classes.ts` at `--target standalone` compiles
   to a binary with **zero imports**, so the sink genuinely works today.

2. **Number `.toString()`.** Behind console, both units hit
   `primitive-method-unsupported`. `selectorSupportsNumberToString()`
   (`src/ir/select.ts`) is satisfied only by
   `currentSelectionOptions.supportsNumberToString` (set today only by the
   **linear** backend, `src/ir/backend/linear-integration.ts:429`, when a
   `number_toString` function exists) or by
   `currentModuleBindingResolver.supportsHostNumberToString`, which is
   `options.allowHostExterns` (`src/ir/module-bindings.ts:2049`) — false in
   standalone. Yet standalone **does** have a native `number_toString`
   (`emitNativeNumberFormat`; #3912 made it native precisely so it stops being
   a host import). So the wasmgc standalone lane needs the same treatment the
   linear lane already got.

3. **What is left after both.** With console and number-toString both opened,
   `algorithms.ts::main` moves to `call-graph-closure` — it is blocked on
   `joinNums`, which itself fails at `build/method-call-unsupported` (an
   array `.join()` surface). `classes.ts::main` becomes claimable but then
   **fails the build**.

### The failure, verbatim (evidence — do not discard)

Opening the selector arm without flipping the capability table and adding the
lowering produces, for `classes.ts::main` in the standalone lane:

```
OUTCOME function::main invariant/build/unexpected-internal-throw
  detail: ir/from-ast: internal capability violation — console.log is
  capability-deferred (see src/ir/capability.ts) yet reached the builder
  post-claim in main. The selector and the capability table disagree; this is
  a compiler bug, not a fallback.
```

This is `assertNotDeferred` working **exactly as designed** (#2135): the
capability table says `hostExternCapability(jsHost=false) === "defer"`, so a
`console.log` node arriving post-claim is a selector/table disagreement, not a
fallback. Read it as the guardrail that tells you the correct order of work —
capability row and lowering FIRST, selector arm LAST — not as a bug to route
around.

## Acceptance criteria

1. `console.<m>(arg)` lowers in the IR to the standalone host-free sink
   (`__stdout_append` path) when the target has no ambient JS host, reusing the
   existing helpers rather than minting parallel ones.
2. The selector admits number `.toString()` in the wasmgc standalone lane on
   the strength of the **native** `number_toString`, not a host extern.
3. `classes.ts::main` is `emitted` in the standalone lane of
   `pnpm run check:ir-only` with **zero** `irPostClaimErrors` and no
   `invariant` outcome; ratchet the standalone lane only (host lane stays
   37/37 READY).
4. Runtime parity: compile `classes.ts` standalone, run, compare printed output
   with node. The binary must still have **zero imports** (#2961).
5. `algorithms.ts::main` is expected to remain blocked on `joinNums`
   (`call-graph-closure`) — state that residual honestly rather than widening
   scope to the array `.join()` surface.

## Implementation Plan (sketch)

Order matters; each step is separately verifiable.

1. **Capability row first.** `hostExternCapability(jsHost)` is currently a flat
   `jsHost ? "claim-partial" : "defer"` (`src/ir/capability.ts`). `console` now
   has a host-free lowering in standalone while `document` does not, so the
   single boolean can no longer speak for the whole host surface. Split the
   console surface out (a `standalone-console-sink` capability alongside the
   existing `standalone-*` family in `src/ir/backend/legality.ts` is the
   in-idiom move) so the builder's `assertNotDeferred` and the selector read
   one table.
2. **Lowering.** In `src/ir/from-ast.ts:6644`, branch the console arm on that
   capability: host → the existing `console_<m>_<variant>` import; host-free →
   the `__stdout_append` sink. Keep the statement-position and single-arg
   restrictions; the sink's own dispatch is on the **compiled ValType**
   (deliberately, per #3469 — the TS static type is both wrong here and would
   trip the oracle-ratchet gate).
3. **Number toString.** Give the wasmgc standalone lane the same
   `supportsNumberToString` signal the linear lane derives, sourced from the
   native `number_toString` availability. Prefer routing it through the
   existing selection-options field over adding a second predicate.
4. **Selector arm LAST.** Only once 1–3 are in place, let
   `isPhase1Expr`'s identifier arm accept `console` in the host-free lane —
   i.e. narrow the `host-surface-unavailable` arm added by #4457 so it stops
   catching `console` while still catching `document`. #4457's union comment
   and the `gen-ir-adoption.mjs` bucket note both flag `console` as the fixable
   member; update both when it lands.
5. **Ratchet** `scripts/ir-only-baseline.json` standalone-lane-only
   (`host-surface-unavailable` 6 → 4, `emittedFloor`/`irBodyEmittedFloor` +1),
   and re-run `node scripts/gen-ir-adoption.mjs --check`.
