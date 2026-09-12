---
id: 6432
title: "standalone: a module that contains `eval` AND links a provider throws `Object.prototype.toString is not yet implemented` at MODULE INIT — every test262 row in the linked Temporal lane fails before any test code runs (360 of 360 measured)"
status: ready
sprint: current
priority: high
horizon: l
goal: standalone
reasoning_effort: high
requested_by: ttraenkler/senior-dev-5406
created: 2026-09-12
---

## Problem

Measured in #5406 S6 (2026-09-12), reduced to **six lines**:

```js
var obj = { evalScript: function (sourceText) { return eval(sourceText); } };
var n = typeof obj;
```

compiled `--target standalone`, `hostBridge: "always"`, `deferTopLevelInit: true`:

| configuration | `__module_init()` |
| --- | --- |
| no linked provider | **OK** |
| one linked standalone provider (the compiled Temporal polyfill) | **throws `TypeError: Object.prototype.toString is not yet implemented in --target standalone`** |

Nothing in that source calls `Object.prototype.toString`. The throw happens in
compiler-generated init code, and it happens **before any test statement runs**.

Reproduce (`.tmp/s6-init.mts` in the S6 worktree, which uses the runner's own
seams — `assembleOriginalHarness`, `buildImports`, `instantiateTest262Module` —
so the result is the runner's, not a probe's):

```
S6_RAW=1 JS2WASM_TEMPORAL_CACHE=<dir> npx tsx .tmp/s6-init.mts .tmp/s6-e3.js       # throws
S6_RAW=1 S6_NOLINK=1 … npx tsx .tmp/s6-init.mts .tmp/s6-e3.js                      # init OK
```

Both answers are identical on the pre-#5406 tree and on the S6 tree, so this is
**not** caused by #5406's fix and #5406 does not repair it.

## Why this is the biggest thing in the standalone Temporal lane

The test262 harness prelude that is prepended to **every** row defines
`$262.evalScript`, whose body is exactly the shape above. So every linked row's
module init throws this TypeError, the row fails, and the runner reports the
TypeError as the row's error text.

That is the real explanation of the #5383 S5 measurement:

- **352 of 360 linked rows reported this one text.** It was read as
  "`Object.prototype.toString` refuses a boundary carrier" (#5406). Re-measured
  in S6: the text is the *module-init* failure, present on rows that contain no
  assertion at all.
- **All 360 rows score 0 pass linked.** An EMPTY row (`var s6 = 1;` with
  `features: [Temporal]`) fails with the same text — measured through the real
  runner, `.tmp/s6probe-row5.js`.
- Therefore the S5 sub-bucket table (136 `assert.throws` / 124
  `assert.sameValue` / …) classifies rows by the `at L<n>` fragment of a
  failure that **never reached** that line. Those numbers are not a
  classification of Temporal defects.

Until this is fixed, the linked lane cannot measure anything: every row fails
identically before its first statement.

## What is already known

- It takes BOTH ingredients. `eval` alone (unlinked) is fine; a linked provider
  without `eval` in the consumer is fine (`.tmp/s6-e1.js`: the same function
  body WITHOUT the `eval(...)` fallback, linked, inits OK).
- Bisected down the real harness prelude: keeping `$262` through `createRealm`
  but dropping `evalScript` inits OK (`.tmp/s6-pB.js`); keeping `evalScript`
  and dropping everything else still throws (`.tmp/s6-pF.js`, `.tmp/s6-e2.js`,
  `.tmp/s6-e3.js`).
- The consumer imports BOTH `js2wasm:npm:@js-temporal/polyfill:…` and
  `js2wasm:runtime-eval`. Only the `js2wasm:npm:` namespace is a #5383 S2d
  boundary peer (`peerNamespaces` filters on that prefix), so the runtime-eval
  module is linked but is not a peer — a plausible place for the interaction.
- The message text is `emitThrowTypeError`'s; the call site is compiler
  generated, so the next step is to find WHICH generated body raises it (the
  candidates are the `Object.prototype.toString` glue emitters:
  `object-proto-tostring.ts` `emitObjectProtoOrRefusal` /
  `ensureObjectProtoToStringRuntimeHelper`, and `native-proto.ts`'s
  `refusalBodyFallback`). #5406's peer arm sits in the first of those and does
  NOT silence this throw, which is evidence the raising body is a different one
  (or that the receiver is a value the peer also declines).

## Acceptance criteria

1. The six-line reduction inits OK with a provider linked, host-free, as a test
   in `tests/`.
2. The runner's EMPTY Temporal row (`features: [Temporal]`, one `var`) does not
   fail.
3. Re-run #5383's S5/S6 three-family sample (120 rows each, linked) and report
   the new pass count and the new top error buckets — the first measurement of
   that lane that is about Temporal rather than about init.
4. `--target gc` and unlinked standalone bytes unchanged (byte A/B, ≥8 modules).

## Notes

- Found by #5406 S6. Artifacts in that worktree's `.tmp/`: `s6-init.mts`,
  `s6-e{1,2,3}.js`, `s6-p{A,B,D,F}.js`, `s6probe-row{3,4,5}.js`,
  `s6-{pd,du,zdt}-link.tsv`, `s6-table.out`.
- Related: #5383 (umbrella), #5406 (the boundary `Object.prototype.toString`
  answer, which is a real and separate fix), #5407 (link cost), #5408
  (`PlainDate.from`), #2860 (standalone gap umbrella).
