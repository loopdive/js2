---
id: 6880
title: "S3-j: the 62 ES5 rows the host lane passes and the native regime fails (per-row list, grouped by cause)"
status: in-progress
assignee: ttraenkler/opus-6880
created: 2026-10-06
updated: 2026-10-07
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime
language_feature: es5
goal: architecture
sprint: current
parent: 5385
related: [6750, 6708, 5385]
# 2026-10-07 (group 1): one ctx field (`evalOnlyLiveFuncBindings`, 7 lines with its
# doc) and the one line in registerReassignedFunctionGlobals that fills it.
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/index.ts
# 2026-10-07 (group 3): the filter receiver import + the two-line identity call in
# setupArrayLoop; the arm itself lives in src/codegen/array/vec-receiver-identity.ts.
loc-budget-allow:
  - src/codegen/array-methods.ts
---

# #6880 — ES5 on the native regime: 62 rows, nine causes

ES5 is a `completed` edition in `scripts/test262-edition-ratchet-baseline.json`:
a single failing row parks a PR, so the regime cannot become the default
(S6, #6708) while any of these fail. Measured 2026-10-06 (nightly
37440804249 regime artifact vs the host baseline of the same day, join on
`file`; the ratchet reports −95 because it also counts rows missing from the
regime run). None is a regression of something standalone had: these are
rows V8 passes for the host lane. Work them in this order; each group is one
PR with a focused test, byte-identical for default gc.

| # | rows | cause (first example) | where to look |
| --- | --- | --- | --- |
| 1 | 9 + 3 + 6 | **non-strict `this` in function code**: `'this' had incorrect value!` (`language/function-code/10.4.3-1-{69,70,74,88,93,98}gs.js`), `Expected true but got false` (`…-{88,93,98}-s.js`), `foo.call(true)` → `"undefined"` not `"boolean"` (`10.4.3-1-{1,4}-s.js`), `f.apply(o)`/`f.bind(o)()`/`f.call(o) !== true` (`-69-s`, `-79-s`, `-74-s`, `-70-s`). §10.4.3: a sloppy function called with `undefined`/primitive `this` must see the global object / wrapper; the regime's call path hands the raw value. The `gs` rows are global-code scripts: `this` at script top level must be the global object. | `src/codegen/expressions/call-identifier.ts` sloppy-`this` arm; `__call_fn_*` dispatchers (`closure-exports.ts`) for `.call/.apply/.bind` with a primitive receiver |
| 2 | 5 | `TypeError: called value is not a function` (`S13.2.1_A6_T3`, `harness/deepEqual-{object,primitives,circular,mapset}.js`): a function VALUE read back from a dynamic container is not recognised as callable | `__apply_closure` / callable-kind check on the regime (the `boundary ?? peer` residue noted in #6748 — see #6882) |
| 3 | 4 | `Array.prototype.filter` 15.4.4.20-9-{1..4}: `resArr.length` wrong — the callback mutates/deletes elements of the array being filtered; spec reads `len` once and `HasProperty` per index | `__hof_filter` loop in `array-like-hof-arms.ts` / `hof-native.ts`: must not re-read length, must skip holes created during iteration |
| 4 | 2 + 2 + 1 + 1 + 1 + 1 | array exotic `length`/index semantics: `z["1.1"]` not an index (`S15.4_A1.1_T7/T8`); `x[4294967295]` not an element (`S15.4.5.1_A2.1_T1`, `15.4.5.1-5-1`); `x.length = n` truncation (`S15.4.5.2_A3_T4`); `[,,]` holes in `toString` (`S15.4.4.2_A1_T2`); `verifyWritable(obj, "length")` (`harness/propertyhelper-verifywritable-array-length.js`) | `__extern_get`/`__extern_set` vec arms (`vec-numeric-key-presence.ts`, `object-runtime.ts` ≈ L10223): the canonical-array-index test (ToString(ToUint32(k)) === k and k ≠ 2^32−1) |
| 5 | 2 + 1 + 1 | `Object.defineProperties` 15.2.3.7-5-b-{125,204,72}, -6-a-17: descriptor read through a host-admitted or proxied object yields `undefined` / wrong `hasProperty` | descriptor marshal in `object-runtime-descriptors.ts` on the regime |
| 6 | 2 + 1 | `with` statement: `S12.10_A3.7_T2/T3` invalid Wasm in `__module_init_chunk` (compile error), `S12.2_A3` `__var === "OUT"` | `with-scope.ts` under the regime (chunked init) |
| 7 | 2 | `throw`/`try` `S12.13_A2_T6`, `S12.14_A18_T6`: `Cannot access property on null or undefined` — a thrown primitive wrapper | exception value marshal on the regime (`__exn` payload for primitives) |
| 8 | 1 + 1 + 1 | `typeof this["Function"]` (`S11.2.1_A4_T1`), `S11.2.1_A4_T5` null deref in init, `Function.prototype.bind` 15.3.4.5-2-9 `typeof(s)` `"object"` vs `"string"` | global-object property read of an intrinsic by string key; bound-function `this` boxing |
| 9 | 1 + 1 + 1 | `S11.10.3_A2.2_T1` `valueOf` in `|`; `S8.12.5_A2` numeric-string keys on an object literal (`_map[1]`, `_map["1"]`); `15.2.3.4-4-2` illegal cast in init; `harness/compare-array-arguments.js` `arguments` with a trailing hole | ToPrimitive on a boxed object in bitwise ops; object literal numeric key canonicalisation; `arguments` object materialisation |

## Acceptance

- [ ] Each group's rows pass on the regime lane (scoped run
      `TEST262_SEMANTIC_PROVIDERS=native-first TEST262_PATH_FILTER=<paths>`), and still pass on
      `--target standalone` where standalone passed them before.
- [ ] Default gc byte-identical per PR (sha256 on a probe).
- [ ] After the last group: `check:edition-ratchet --results <regime.jsonl> --compare <host.jsonl>`
      reports ES5 with no `pass → not-pass` rows.

## Progress

Measurement lane for every group: `scripts/run-test262-paths.mts` (in-process,
`JS2WASM_EVAL_ENGINE=interpreter TEST262_SEMANTIC_PROVIDERS=native-first
JS2WASM_NATIVE_REGIME_JS=1`, refusal eval provider prebuilt for the tree under
test, 120 s per row). The sharded `pnpm run test:262` lane was unusable on the
shared box (load 180–400: 61 of 200 group-1 rows hit the 10 s compile timeout).
The in-process lane did not hand `semanticProviders` to
`instantiateTest262Module`, so every eval-mentioning regime row failed at
link time; group 1's PR fixes that one line in `tests/test262-runner.ts`.

### Group 1 — receiver of `.call` / `.apply` / `.bind` (2026-10-07, PR pending)

**Root cause.** Not the sloppy-`this` arm. Every row carries the harness
`$262.evalScript` shim, whose direct `eval` puts the module into runtime-eval
mode on the regime: the #3418 dead-binding elision that removes the unused shim
runs only for host-free environments (`compiler.ts`, environment `none`/`wasi`).
In runtime-eval mode `registerReassignedFunctionGlobals` marks every top-level
function declaration live (eval could rebind it). The named `.call` receiver
trampoline (`resolveNamedThisCallTarget`, also reached by the `.apply` and
`.bind` reshapes) refused live bindings, and the fallback calls the SAME static
function with the receiver dropped — so `f.apply(o)` saw `this === undefined`
and `foo.call(1)` reported `typeof this === "undefined"`. Standalone has the
identical defect whenever the eval stays reachable (it passes the test262 rows
only because the elision removes the shim there).

**Fix.** `ctx.evalOnlyLiveFuncBindings` records the names that are live only
because eval could rebind them (no source assignment). The trampoline admits
those; a statically reassigned function keeps its live-value lowering. Default
gc never populates the set (`runtimeEvalConsumer` requires the native regime),
so it is byte-identical (sha256 on three probes unchanged).

| lane (200 rows `language/function-code/10.4.3-1-*`) | before | after |
| --- | ---: | ---: |
| regime | 156 | 184 |
| standalone | 184 | 184 (same 16 non-pass) |

The 16 left on both lanes are `eval`-dependent rows that the refusal provider
fails by construction (`10.4.3-1-{13,14,15,16,19,20,83,84}{-s,gs}`); the
QuickJS provider in CI is the lane that measures them.

Residual, not fixed here: a `.call` on an eval-only live binding still targets
the static function, so a runtime `eval("f = …")` followed by `f.call(o)` calls
the original `f` (unchanged from before; the dropped receiver was the only
difference). Statically reassigned functions (`f = …` in source) also drop the
receiver on the live-value path on every lane, including host.

**Lever noted for later groups.** Most of this issue's groups reproduce only
with the shim's `eval` live (group 3's `filter` rows too: the eval-widened
`srcArr` global is copied into a fresh vec before the loop). Running the #3418
elision for the regime (gate on the implementation, not the environment) would
make the regime see the same module standalone sees for shim-only tests. That
is a separate, broader change; the per-group fixes repair the eval-live shapes
on both lanes.
## Progress — group 3 (filter over a mutated array, 2026-10-07)

Measured with the in-process lane (`scripts/run-test262-paths.mts`, refusal
eval provider, `TEST262_SEMANTIC_PROVIDERS=native-first`); see the group 1 PR
for why the sharded lane was not usable on the shared box.

**Root cause.** Like group 1, the rows fail only with the harness shim's
direct `eval` live. In that mode the regime widens script globals to
externref, so `srcArr.filter(cb)` reaches `setupArrayLoop` with an externref
receiver. `buildVecFromExternref` always materializes a FRESH vec, so the
loop walked a snapshot, and the callback's writes, deletes and truncations
to `srcArr` were invisible.

**Fix.** `src/codegen/array/vec-receiver-identity.ts`: when the externref
already is the target vec (`ref.test`), `filter` uses it directly. This
applies only to `filter` (loop tag `flt`), whose loop reads every element
through HasProperty/Get on the receiver (`array-filter-spec-access.ts`).
The other HOF loops read the backing array directly, and for them the copy
is what makes an index accessor visible. A first cut that also gave
`reduceRight` identity lost 9 `15.4.4.22-*` accessor rows, so `reduceRight`
keeps the copy. The arm exists only on the native regime (`ctx.standalone`),
so default gc is byte-identical (sha256 on four probes unchanged).

| rows | lane | before | after |
| --- | --- | ---: | ---: |
| `filter/*` (242) | regime | 210 | 227 |
| `filter/*` (242) | standalone | 230 | 230 (same 12 non-pass) |
| `reduceRight/*` (260) | both | — | codegen unchanged (non-`flt` loops return the base materialization) |

The four issue rows `15.4.4.20-9-{1,2,3,4}` all pass. The other 13 rows that
flipped share the shape (`9-5`, `9-6`, `9-b-*`, `9-c-i-*`).

**Pattern across the remaining groups.** Groups 4, 6 and 7 also reproduce
only with the shim's `eval` live. A minimal group 4 script prints correct
values without `eval` and wrong ones with it: `a[4294967295]`, `z["1.1"]`,
the `length` truncation of index 4294967294, and holes in `toString`
(printed as `null`). The eval-widened externref global routes every access
through the dynamic `__extern_get`/`__extern_set` arms.
