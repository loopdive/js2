---
id: 4462
title: "IR: standalone console.log sink + native number_toString, so console-using units claim host-free"
status: done
completed: 2026-08-16
sprint: 78
created: 2026-08-15
assignee: ttraenkler/opus-4462
priority: medium
horizon: l
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir
goal: ir-full-coverage
related: [4457, 3518, 2856, 3469, 3912]
loc-budget-allow:
  # The console capability row + the host-free lowering arm and its argument
  # renderer. Both sit in the existing console/method-call dispatch in
  # from-ast; splitting the arm out would separate it from the host arm it is
  # explicitly disjoint with (`jsHost` vs `!jsHost && sink`), which is the one
  # invariant a reader needs to check.
  - src/ir/from-ast.ts
  # Two callable-provider arms + two resolver capabilities, in the file that
  # already owns every other provider arm and every other resolver capability.
  - src/ir/integration.ts
  # `standaloneConsoleSinkAvailable` next to `ensureStandaloneStdoutSink`, the
  # sink it reports on — the #2135 one-table rule (claim and lowering read one
  # fact) requires the predicate to live with the thing it measures.
  - src/codegen/native-strings.ts
  # The two host-free capability signals threaded into the wasmgc lane's
  # selection options, at the single site that builds them.
  - src/codegen/index.ts
  # `namesHostFreeConsoleSurface` — the selector half of the same one table.
  - src/ir/select.ts
coercion-sites-allow:
  # +3 `number_toString` mentions, none of them a coercion: a `funcMap` lookup,
  # the on-demand `emitNativeNumberFormat` call the other lazy consumers already
  # make, and one doc reference. The adapter hand-rolls NO ToString matrix — it
  # calls the existing formatter and applies the SAME two-op ABI unwrap legacy
  # already performs at `call-receiver-method.ts::unwrapToNative` (#3912). It
  # lives here because this file owns `number_toString`'s emission and its
  # `(f64) -> externref` ABI; putting the adapter anywhere else would separate
  # the ABI from the code that chooses it.
  - src/codegen/number-format-native.ts
func-budget-allow:
  # +12: one host-free arm in the console dispatch and one in the toString
  # dispatch, each three lines of condition delegating to a named helper. The
  # arms must live beside the host arms they are disjoint with.
  - src/ir/from-ast.ts::lowerMethodCall
  # +13: two capability methods, in the object that holds every other one.
  - src/ir/integration.ts::makeFromAstResolver
  # +5: one callable-provider arm per new host-free symbol.
  - src/ir/integration.ts::compileIrPathFunctions
  # +6: the two capabilities threaded into the wasmgc selection options.
  - src/codegen/index.ts::planIrOverlay
  # +4: the console narrowing of the host-surface reject arm (#4457 already
  # holds a grant here for the arm this one narrows).
  - src/ir/select.ts::isPhase1Expr
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

## Test Results

### `pnpm run check:ir-only` — standalone lane (host lane unchanged, 37/37 READY)

Two runs are recorded. The **branch-alone** column is the slice measured against
its own base (`main` before #4583 landed native `$Map`). The **composed** column
is the same gate re-run on this branch merged with `main` at `fe8ab310`
(#4583 native `$Map` + #4592 query-purity + #4599 #4494 construction edges);
it is the column the committed baseline is ratcheted from.

| metric                             | base (pre-branch) | branch alone | composed with `main@fe8ab310` |
| ---------------------------------- | ----------------: | -----------: | ----------------------------: |
| emitted / IR bodies                |                17 |           19 |                        **20** |
| legacy bodies                      |                27 |           26 |                        **22** |
| unsupported                        |                20 |           18 |                        **17** |
| invariants                         |                 0 |            0 |                         **0** |
| `select/host-surface-unavailable`  |                 6 |            4 |                         **4** |
| `select/primitive-method-unsupported` |              1 |            0 |                         **0** |
| `select/body-shape-rejected`       |                 5 |            5 |                         **3** |
| `select/call-graph-closure`        |                 3 |            4 |                         **3** |
| `resolve/late-preparation-unsupported` |             0 |            0 |                         **2** |

`main@fe8ab310` alone measures emitted 19 / unsupported 18 / legacy 27
(its committed `scripts/ir-only-baseline.json` before this merge).

### Composition table — the five units this issue and #4583 touch

Measured on the merged tree by dumping every `IrObservedOutcome` from
`observeStandaloneLane()`:

| unit | `main@fe8ab310` alone | branch alone | **composed** |
| ---- | --------------------- | ------------ | ------------ |
| `classes.ts::main`               | `select/host-surface-unavailable` | emitted | **emitted** |
| `algorithms.ts::joinNums`        | `select/primitive-method-unsupported` | emitted | **emitted** |
| `algorithms.ts::<module-init>`   | emitted | emitted | **emitted** |
| `algorithms.ts::fibMemo`         | **emitted** (#4583's win) | `select/body-shape-rejected` | **`resolve/late-preparation-unsupported`** |
| `algorithms.ts::main`            | `select/host-surface-unavailable` | `select/call-graph-closure` | **`resolve/late-preparation-unsupported`** |

Net: **19 → 20 emitted**. Composition gains `classes.ts::main` and
`joinNums` (+2, this issue) and loses `fibMemo` (−1) relative to `main` alone.
`algorithms.ts::main` is unsupported in all three columns; only its *code*
moves.

#### The one composed loss, precisely

`fibMemo` emits on `main` alone and demotes to
`resolve/late-preparation-unsupported` once **this** issue makes
`algorithms.ts::main` a claim candidate. Verbatim dependency codes from
`irPostClaimErrors`:

- **`fibMemo`** — `source-global-outside-component`: the module TDZ global
  (`module-tdz:0`) and the module binding (`module-binding:0`) "belong to
  non-candidate storage terminal … `root:module-init:0`"; plus
  `unplanned-abi-binding` for `__new_ReferenceError`, `__ir_map_get_num`,
  `__ir_map_set_num`, `__unbox_number`, `__extern_is_undefined`, and
  `implicit-support-reference-unavailable` for `ref_null:65`.
- **`algorithms.ts::main`** — cascade: `foreign-source-unit` on the
  now-non-candidate `fibMemo`, plus `unplanned-abi-binding` for this issue's
  own `__ir_console_sink_append` / `__ir_number_to_string_native` and
  `__ir_string_concat`.

This is **not new and not this issue's to fix**: #4494 measured exactly this
composition as its *manifestation 2*, recorded it as
"**not fixed by this slice, and not regressed**", and named the general
statement — *a unit may only claim if its component seals* — as its
**Follow-up**, still unenforced for `source-global-outside-component`,
module-binding readers and host-provider bindings. #4599 landed #4494's
construction edge, which is a different edge kind and does not apply here
(`new Map(...)` is module-level and extern). The evidence above is the witness
that follow-up needs; `tests/issue-4462.test.ts` pins both codes so the fix
flips a test rather than going unnoticed.

The baseline is ratcheted to the **true composed** numbers — including the new
`resolve/late-preparation-unsupported: 2` bucket. Every aggregate improves
(emitted floor 19 → 20, legacy ceiling 27 → 22, unsupported ceiling 18 → 17);
the new bucket is the honest record of the one unit that moved backwards.

`pnpm run check:ir-fallbacks`: OK — no unintended / post-claim / module-level
growth. `node scripts/gen-ir-adoption.mjs --check`: up to date.
`scripts/ir-only-baseline.json` ratcheted standalone-lane-only; `single-host`
untouched and still 37/37 READY with 0 unsupported.

### Pins

`tests/issue-4462.test.ts` 15/15, `tests/issue-4461.test.ts` 5/5,
`tests/issue-4494.test.ts` 6/6 (26/26) on the merged tree. One 4462 assertion
was updated by the composition: `algorithms.ts::main`'s residual code moved
from `call-graph-closure` to `late-preparation-unsupported` per the table
above, and the test now also pins `fibMemo`'s code.

### Runtime parity (acceptance criterion 4)

`classes.ts` and `algorithms.ts` compiled `--target standalone`, instantiated,
`main()` run, output drained through `__stdout_prepare`/`__stdout_char`. Both
byte-identical to `node`, both binaries with **ZERO imports**.

Note for anyone reproducing this: the readout exports are stripped by #4035's
export-policy sink unless `hostBridge: "always"` is passed, so a bare
`compile(src, { target: "standalone" })` exposes only `main` and the output is
unobservable. That is by design (exports are GC roots), not a missing sink.

### The `classes.ts::main` internal throw — diagnosis

Root cause: exactly what `assertNotDeferred` says, and nothing behind it. The
probe that produced it opened the SELECTOR arm while the capability table still
read `hostExternCapability(jsHost=false) === "defer"` and no host-free lowering
existed — a selector↔table disagreement by construction. With the row split out
(`consoleSurfaceCapability`) and the lowering in place, the disagreement cannot
arise: `classes.ts::main` now emits with zero `irPostClaimErrors` and zero
`invariant` outcomes (asserted in `tests/issue-4462.test.ts`). There was no
second, hidden failure behind it.

### Residuals, stated honestly

- **`algorithms.ts::main` is blocked on `fibMemo`, not on `joinNums`.** The
  issue predicted `joinNums` (`call-graph-closure` via the array `.join()`
  surface); measurement disagrees. `joinNums`' blocker was
  `primitive-method-unsupported` — `arr[i].toString()` — which this issue's
  native formatter fixed, so `joinNums` now CLAIMS. `main`'s remaining unclaimed
  callee is `fibMemo`. It never touched the array `.join()` surface at all.
  On the branch alone `fibMemo` was `body-shape-rejected` (`Map`-typed body) and
  `main` cascaded as `call-graph-closure`; **composed with `main@fe8ab310` both
  are `resolve/late-preparation-unsupported`** — see the composition table
  above. #4583 made `fibMemo`'s body claimable, and this issue making
  `algorithms.ts::main` a candidate enlarges the prepared component past what
  can seal. That is #4494's open Follow-up, not this slice.
- **Numeric `console.log` arguments printed NOTHING in standalone before this**
  and print correctly after. Legacy's `emitStandaloneStdoutAppendValue` drops a
  bare scalar ("best-effort, never a marker", #3469), so `console.log(42)`
  silently produced empty output on the legacy path. The IR arm renders it. The
  legacy path is unchanged and still drops.
- **Legacy hijacks a shadowed `console` (pre-existing, out of scope).**
  `calls.ts` dispatches `console.<m>` on identifier TEXT with no shadow guard,
  so `const console = {...}; console.log(x)` still reaches the sink in a
  legacy-compiled body. The IR side is shadow-safe (checker-backed resolver);
  fixing legacy belongs to the #2855 retirement, not here.
- **Booleans have no host-free console rendering yet.** `console.log(flag)`
  demotes through the typed UNSUPPORTED channel rather than printing `1`/`0`.
  `"true"`/`"false"` needs a value-position string select the slice does not
  build; numbers and strings are covered.
