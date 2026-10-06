---
id: 6880
title: "S3-j: the 62 ES5 rows the host lane passes and the native regime fails (per-row list, grouped by cause)"
status: ready
created: 2026-10-06
updated: 2026-10-06
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
