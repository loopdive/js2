# Handover — standalone Temporal (#5383), sessions of 2026-09-08 → 2026-09-12

Final handover for the S1→S5 arc. Supersedes
`temporal-standalone-handover-2026-09-08.md` and its 09-07 predecessor.

**Scope, unchanged from the owner directive of 2026-09-07:** a real `Temporal`
global for `--target standalone`, **standalone only**. The host-lane Temporal
work is finished and landed; do not open host-lane work here.

## The one-paragraph state

A real `Temporal` global exists under `--target standalone`, host-free: the
`@js-temporal/polyfill` compiles, links as a separate provider module, and
answers correctly for the constructor path. Wiring into every test262 lane is
complete. **The artifact is still opt-in and the linked lane still scores 0
pass on the sampled families**, because of one defect in the link boundary
(#5406) that fails 352 of 360 measured rows and hides every other cause behind
a misleading error message, plus a compile-cost residual (#5407) that makes
default-on unsafe. Three successor issues carry the remaining work.

## What works today, host-free (the proof, not the claim)

`tests/issue-5383-standalone-temporal-provider.test.ts`, the
`#5383 S2 smoke — the real standalone Temporal provider` block, driven by
`tests/dogfood/temporal-s2-smoke-harness.mjs` (a child process — the 3.3 MB
provider compile OOMs a vitest worker in-process). Compile options
`{ target: "standalone", hostBridge: "off" }`, instantiated with
`instantiateLinkedProject(result, {})` — **an empty import object**, which is
the host-free contract itself. All assert:

| probe | value |
| --- | --- |
| `Object.keys(Temporal).length` | 9 |
| `"PlainDate" in Temporal` | 1 |
| `new Temporal.PlainDate(2024,1,1).day` | 1 |
| `Temporal.Duration.from({hours:1}).hours` | 1 |
| `Temporal.Duration.from({hours:1}).total("minutes")` | 60 |
| the same through a bound local | 60 |

Additionally measured in S5 and not yet in the harness: `.calendarId` answers
`"iso8601"`, `PlainDate.compare(d, d)` answers 0, and `String(<a PlainDate>)`
returns a string.

One `it.todo` stands in that block and is deliberately **not** an S2 assertion:
`typeof d.total === "function"` read through a CHAINED receiver answers 0 while
the bound-local spelling answers 1 — #2984's path-dependent member read, not a
Temporal or boundary defect.

## The slice table

| slice | what it did | PR |
| --- | --- | --- |
| S1 | the polyfill compiles under standalone to a binary the engine accepts (ToBoolean `anyref` row; `recv.m?.(args)` host/native split) | #5721 |
| S2b | the externref-backed subclass family (own-field r/w, dynamic dispatch on `class B extends Array`) | #5761 |
| S2c | the `Intl` refusal shim; `__module_init` returns | #5762 |
| S2d | the getter boundary — a provider-minted object arrived empty | #5767 |
| S2e | `invalid calendar identifier` — a scope-blind `defineProperty` sidecar key | #5773 |
| S2f | `$__ta_ctor` identity by brand; a class value is `typeof "function"` | #5777 |
| S2g | `new K(…)` on a class VALUE runs the constructor body | #5780 |
| S2h/S2i/S2j | prototype-member and static reads through a runtime key, in-module and across the boundary; the `method_call` terminal | #5820 |
| S2k | one `final` bit on one rec-group member had killed the whole wasm↔wasm value ABI | #5822 |
| S2l | `Object.fromEntries` over a computed pair list (tuple carriers; an accidental content-decided refusal) | #5824 |
| S2i fix | a computed static FIELD shadowed by the class-value call arm | #5831 |
| S3 | runner + CI wiring, per TARGET, fail-soft; the opt-in decision | #5827 |
| S2m | the JSBI guard was never our coercion; a graph shares ONE exception tag | #5829 |
| S2n | `.pop()` on an `any`-shaped vec receiver was a silent no-op in every MULTI-MODULE compile — the last blocker to assertion 3 | #5835 |
| S2o | linking costs ~2 %; a WasmGC struct for `typeof globalThis` cost 1,942 dead accessors (2,766 → 929 functions) | #5841 |
| S2p | the `globalThis` lazy-init seed outlined into one helper (−43 % linked row cost) | #5847 |
| **S5** | measurement + close-out; three successor issues; this handover | **this branch** (`issue-5383-standalone-temporal-s5`, stacked on S2p) |

## The S5 measurement

Three non-Intl families, first 120 rows in path order each, standalone lane,
fresh `JS2WASM_TEMPORAL_CACHE` per side, pairs run two-at-a-time so the ms
column is comparable across sides.

| | PlainDate base → linked | Duration base → linked | ZDT/prototype base → linked |
| --- | --- | --- | --- |
| pass | 3 → **0** | 3 → **0** | 4 → **0** |
| compile_error | 48 → 2 | 26 → 3 | 0 → 3 |
| — timeouts | 0 → 2 | 0 → 3 | 0 → 3 |
| `Temporal is not defined` | 33 → **0** | 56 → **0** | 34 → **0** |
| `__temporal_*` leak | 48 → **0** | 26 → **0** | 0 → **0** |
| median row ms | 1378 → 3126 | 1372 → 3275 | 1205 → 2886 |

Pass→fail: **10 flips, 6 false passes, 4 legitimate losses.** The bar was 0
legitimate, so criterion 4 of #5383 is not met. All 10 fail linked with the same
reported text, so the loss is a function of one defect, not of provider
semantics.

## The filed issues

- **#5406 — the link boundary, and the highest-value fix by a wide margin.** A
  value that crosses a `link:` boundary is not an ordinary object in the
  consumer: `Object.prototype.toString` refuses it (while answering fine for a
  consumer-owned object), and a provider-thrown error's `constructor` is not the
  consumer's constructor and its `.name` is `undefined`. `assert.throws`
  compares constructors by identity, so **136 of the 360 rows cannot pass
  however correct Temporal is**, and the same chain produces the misleading
  message on all 352.
- **#5408 — two real Temporal-lane value defects.**
  `Temporal.PlainDate.from("1976-11-18")` throws and
  `PlainDate.from(d, {overflow:"constrain"}).year` is not a number, while the
  constructor, `.calendarId`, `compare` and `String()` are all correct.
- **#5407 — the compile-cost residual**, and the only thing standing between
  the artifact and default-on: 1.76–1.83× linked-vs-unlinked, +214 functions,
  the WAT doubled, 8 of 360 rows converted into timeouts, and the 60 KB row
  sitting exactly on the 15 s in-process limit.

## The opt-in decision, and what flips it

`JS2WASM_TEST262_TEMPORAL_STANDALONE=1` locally, the `standalone_temporal`
`workflow_dispatch` input in CI. The **wiring is unconditional**; the flag
decides only whether the artifact exists, and the per-target pre-warm stamp
turns that into the lane's answer (missing / truncated / key-less stamp → the
lane is unlinked, pre-S3 behaviour, no throw). With it off the default path is
byte-identical to pre-S3.

Two independent conditions must both hold before flipping it on, and neither is
met:

1. **#5407** — linked-vs-unlinked ≤1.3× and 0 compile timeouts on the S5
   sample. Otherwise the Temporal bucket converts honest failures into a
   per-row timeout storm.
2. **#5406** — otherwise the lane is flipped to a state that scores *worse*
   on the sampled families (0 pass against 10) while costing 2.3× the compile.

## Operational lessons worth carrying

- **Diagnose a merge-queue park before touching the `hold`.** Compile the named
  row on the PR head and on the park comment's exact baseline compiler sha and
  compare the runner's `wasm_sha`. Identical bytes ⇒ collateral. Two minutes,
  and it settled three parks in this arc.
- **The multi-module finalize order is different from the single-module one,
  and that is a whole CLASS of bug** (S2n, S2i, S2o). `generateModule` and
  `generateMultiModule` call the same fills in different orders, so a mechanism
  that resolves a handle at finalize can be correct in one lane and silently
  wrong in the other — `.pop()` was a no-op in every multi-module compile for
  that reason, and the failure was a wrong VALUE, not an error. Prefer
  resolve-or-RESERVE at the use site over a finalize-pass rewrite, and prefer a
  stable `mintDefinedFunc` handle over a baked index.
- **A "pass" is not evidence until its shape is checked.** A row whose only
  assertions are `assert.throws(TypeError, …)` passes when the feature is
  ABSENT, because `undefined.m()` throws exactly the expected error. Six of the
  ten losses here are that. The cheap discriminator is the row's assertion
  shape; the expensive one, which settled the other four, is compiling the row
  and reading `WebAssembly.Module.imports` — zero imports plus value assertions
  means the pass was real.
- **Never report the error text a runner hands you as the cause.** 352 rows
  said `Object.prototype.toString is not yet implemented`; the method works
  fine, the row had already failed two steps earlier, and the real cause was in
  neither Temporal nor that method. Grep the harness for where the message can
  physically be raised before attributing anything to it.
- **Profile before believing a slice's premise.** S2o was dispatched to make
  linking cheaper and found that linking costs 2 % — the 3.3× was
  `compileMulti`. S2p then found the multi-source penalty was a per-call-site
  splice, not the linker. Two slices in a row had the wrong target named in
  their brief; both were cheap to correct only because the first thing each did
  was measure.
- **Build the QuickJS eval provider before any test262 measurement**
  (`npx tsx scripts/build-quickjs-eval-provider.mjs`). Without it every row
  fails with a provider-missing error and the table is void — this has now
  voided a table twice.

## Reproducing the S5 run

```bash
npx tsx scripts/build-quickjs-eval-provider.mjs
JS2WASM_TEMPORAL_CACHE=<linkdir> npx tsx .tmp/s2p-prewarm.mts       # linked side only
JS2WASM_TEMPORAL_CACHE=<basedir> npx tsx .tmp/s2p-family.mts built-ins/Temporal/PlainDate 120 .tmp/pd-base.tsv
JS2WASM_TEMPORAL_CACHE=<linkdir> npx tsx .tmp/s2p-family.mts built-ins/Temporal/PlainDate 120 .tmp/pd-link.tsv
node .tmp/s2p-table.mjs PlainDate .tmp/pd-base.tsv .tmp/pd-link.tsv
node .tmp/s5-subbuckets.mjs PlainDate .tmp/pd-link.tsv
```

The two diagnosis probes are `.tmp/s5-firstfail.mts` (what actually fails) and
`.tmp/s5-throwshape.mts` (error identity across the boundary); both take a
warm `JS2WASM_TEMPORAL_CACHE` and need no test262 checkout.
