---
id: 2908
title: standalone obj[key] dynamic read leaks env::__extern_get (largest host-import leak class)
area: codegen-standalone
feasibility: hard
status: done
completed: 2026-07-01
assignee: ttraenkler/sdev-2908-externget-leak
related: [2748, 2879, 2372, 2572, 1472]
sprint: 69
priority: high
horizon: m
---

## Problem

`--target standalone` (pure-Wasm, no JS host) modules still emit an
unsatisfiable `env::__extern_get` HOST import for the ordinary dynamic
property-read pattern `obj[key]` / `obj.prop` on an `any`/externref receiver.
This is the **single largest standalone host-import leak class**
(`dynamic_object_property`): on the fresh merge_group standalone report at head
`20474543f` (run 28483020330, 2026-06-30), **4,514** tests import
`env::__extern_get`, of which **3,379** leak it as their _only_ `env::__*` host
import (1,733 pass, 1,636 fail). It is driven at scale by test262 harness code —
`propertyHelper.js`'s `verifyProperty` reads `obj[name]` on a generic `any`
receiver.

## Root cause (verified on current main, verdict (c))

`ensureLateImport(ctx, "__extern_get", …)` at every dynamic-read site _already_
routes `OBJECT_RUNTIME_HELPER_NAMES` (which includes `__extern_get`) to the
Wasm-NATIVE `ensureObjectRuntime` definition under `ctx.standalone || ctx.wasi`
(the #2748 WASI routing + the #1472 Phase B native `$Object` runtime). sr-dynobj's
native `$Object` reader is real and value-correct.

BUT the AST pre-scan `collectUsedExternImports` (`src/codegen/index.ts`, the
`ElementAccessExpression` arm ~line 13767) eagerly registered `env::__extern_get`
as a HOST import for **every** `obj[idx]` element-access on an externref-typed
receiver, with **no host-free-mode guard**. That seeded `__extern_get` into
`funcMap` BEFORE any read-site ran. `ensureLateImport` short-circuits on
`funcMap.has(name)` (returns the existing index without routing), so the
pre-seeded HOST import pre-empted the native routing and the module shipped the
unsatisfiable `env::__extern_get`.

So this is **distinct** from sr-dynobj's value-correctness fix (the native reader
exists and is correct) and from #2748 (which fixed the `ensureLateImport` WASI
routing but not the pre-scan). The pre-scan wins the race and the import leaks.
Confirmed by an `addImport` stack trace: the leak enters at
`collectUsedExternImports`'s element-access arm, with `ctx.standalone === true`
and `ctx.strictNoHostImports === false`.

## Fix

Guard the pre-scan host-import registration for `__extern_get` on
`ctx.standalone || ctx.wasi` — skip the eager `register("__extern_get", …)` in
host-free modes so the compile-path `ensureLateImport` binds the native
`ensureObjectRuntime` `__extern_get`. Host/gc mode is byte-identical (the guard
wraps the unchanged `register(...)` call).

`src/codegen/index.ts` — `collectUsedExternImports`, the `obj[idx]`-on-externref
arm.

## Verification (fresh data, head 20474543f)

- **GC/host byte-identity**: same input compiled `--target gc` is byte-identical
  pre/post fix (3919 == 3919 bytes) and still imports `env::__extern_get` there.
- **standalone**: the import is removed (main=leak, fix=host-free); the module
  grows (native `$Object` runtime now emitted inline) — the intended dual-mode
  tradeoff.
- **Corpus verify** (compile + instantiate + run `test()` via the runner's
  `buildImports`, fixed compiler):
  - 300 stratified baseline-pass leaky tests → 297 stay pass, **0** non-arguments
    fix-induced regressions (the 3 were `arguments-object`); all host-free.
  - 400 fresh non-arguments baseline-pass → 396 pass, **0 fix-induced
    regressions** (4 apparent CEs are pre-existing TS-level errors, byte-identical
    on main and fix — a local-harness artifact, not the fix).
  - 23 `arguments-object` leaky-pass → 14 stay pass, **9 flip pass→fail**: a
    pre-existing native mapped-arguments `[[DefineOwnProperty]]` descriptor gap
    the fully-native read path now _exposes_ (the old mixed host-read /
    native-descriptor path masked it). Tracked as follow-up **#2909**.
  - **0** tests still leaking `env::__extern_get` in any sample.

## Net accounting (standalone floor keys on host_free_pass, #2879 §4)

The floor gate (`scripts/check-standalone-highwater.mjs`) scores
`host_free_pass` (pass AND host-free), not raw pass. A leaky pass has
`host_free_pass = 0`. Therefore:

- ~1,710 non-arguments leaky-pass → host-free-pass ⇒ **Δhost_free_pass ≈ +1,710**
  (progress).
- ~9–13 `arguments-object` leaky-pass → host-free-fail ⇒ host_free_pass
  UNCHANGED (was 0, stays 0) — **does NOT breach the floor** (the exact
  "mid-flight carrier raw-pass dip" the #2879 §4 accounting anticipates).

Net: unambiguously NET-POSITIVE on the gated metric with zero floor breach.

## Reconciliation 2026-07-31 — CONFIRMED done; the "8,092 dynamic_object_property"
## figure was never evidence about this issue

This issue was re-opened for question after a report that the baseline still
showed **8,092/8,222 ES5-ish entries tagged `dynamic_object_property`**, raising
"read-path only / false-done". **Both are wrong, and the instrument was at
fault, not the record.** Two independent reasons:

**1. The tag cannot discriminate.** `classifyHostImportLeak`
(`tests/test262-shared.ts` L317-324) collapses **seven unrelated helper
families** into `dynamic_object_property` with one prefix regex:

```
/__extern_|__object_|__defineProperty|__get_builtin|__new_plain_object|__register_|__proto_method_call/
```

`__extern_` alone spans `get/set/has/call/method_call/length/delete/get_idx`, so
the tag's count is not a count of any one helper's leaks and could never be
evidence about a fix to `__extern_get` specifically.

**2. In the STANDALONE baseline the tag reads 14, not 8,092.** Measured over the
real artifact (`test262-standalone-current.jsonl`, 26.5 MB, **48,088 entries**,
fetched 2026-07-31):

| `host_import_leak_class` | entries |
| --- | ---: |
| `iterator_protocol` | 1,907 |
| `host_import` | 1,653 |
| `regexp` | 40 |
| **`dynamic_object_property`** | **14** |

The quoted 8,092 must have come from a different artifact — almost certainly the
**host** baseline, where `env::__extern_get` is a *legitimate, intended* import
that every dynamic read carries by design. Comparing a host-lane import count
against a standalone-lane fix is the category error.

**3. The fix itself was verified by reading the code, not the record.**
`register("__extern_get", …)` occurs **exactly once** in the whole pre-scan
(`src/codegen/registry/imports.ts` L2381) and is guarded by
`if (!(ctx.standalone || ctx.wasi))` (L2380). `grep -n 'register("__extern'
src/codegen/registry/imports.ts` returns that single line — no unguarded twin,
no write-path counterpart in that function. **Not read-path-only; there is no
second path in the pre-scan to be read-path-*of*.**

### The measurement that should have driven this lane

`metadataFromImports` persists the **actual import names** per entry, so the
real ranking needs no test262 re-run. Over the standalone baseline: **3,614 of
48,088 entries (7.5 %) leak ≥1 `env::` import, and every one of them is
`compile_error`** — in standalone a host import is a compile *refusal*, so the
test never runs and its `host_free_pass` is already 0 (the same pure-upside
accounting §"Net accounting" uses above).

> **3,614 IS A FLOOR, NOT A TOTAL — this filter is blind to other namespaces.**
> It strips `env::` and drops `wasi_snapshot_preview1`, and **never checks
> whether a third host namespace exists. One does.** `js2wasm:runtime-eval`
> accounts for **54 ES5-gap tests** that fail with
> `WebAssembly.instantiate(): Import #0 "js2wasm:runtime-eval": module is not an
> object or function` — an instantiation failure, invisible to every number in
> this section. Consequence: the ES5 gap's **refusal** share is understated
> (149 counted refusals + these 54). Group by **namespace first**; do not
> re-run the `env::`-only recipe.

Ranked by **distinct tests** (a test may span families; `sole` = tests whose
*only* leaks are in that family, i.e. fixing it alone unblocks them).

> **READ THIS BEFORE ROUTING WORK OFF THIS TABLE.** It ranks the largest
> standalone host-import **refusal** blocks **overall**. The top row —
> generators/async-generators, 1,877 tests / 1,618 sole — is **ES2015
> (`function*`/`yield`) and is OUT OF SCOPE for the standalone-ES5
> objective.** Restricted to the true ES5 population (see the edition note
> below) the generator family is **entirely absent**, and host-import leaks
> account for **41 rows, ~4 %** of the ES5 host-vs-standalone gap — a rounding
> error. The ES5 gap is **85.3 % wrong-answer, 14.7 % refusal**. So: use this
> table to size *standalone refusals in general*; do **not** read 1,618 as an
> ES5 opportunity.

| family | tests | sole | top categories |
| --- | ---: | ---: | --- |
| **generators / async-generators** | **1,877** | **1,618** | language/expressions 976, language/statements 709, arguments-object 95 |
| other (Temporal-adjacent, TypedArray) | 610 | 559 | Temporal 217, TypedArray 85 |
| promises / async | 480 | 134 | language/expressions 138, Promise 129 |
| array runtime | 377 | 205 | Array 105, TypedArray 97, Promise 79 |
| SharedArrayBuffer / Atomics | 317 | 306 | Atomics 150, SAB 58 |
| Temporal | 282 | 282 | Temporal 282 |
| BigInt | 60 | 59 | language/expressions 37 |
| RegExp | 28 | 26 | annexB 21 |
| WeakRef / FinalizationRegistry | 26 | 26 | FinalizationRegistry 23 |
| **dynamic object property (this issue's family)** | **14** | 14 | language/expressions 14 |

Top individual names: `__gen_next` 1,588 · `__gen_create_buffer` 1,537 ·
`__get_caught_exception` 1,537 · `__gen_result_value` 1,290 ·
`__create_generator` 1,271 · `__gen_result_done` 1,248 · `__gen_return` 859 ·
`Promise_then2` 378 · `__js_array_new` 377 · `__js_array_push` 349 ·
`SharedArrayBuffer_new` 317. 107 distinct `env::` names in total.

**Read this carefully before acting on it:**

- **1,618 tests unblocked ≠ 1,618 tests passing.** Implementing a family
  host-free removes the *compile refusal*; the semantics must then also be
  correct. This sizes the gate, not the win.
- **The top family is ES2015, not ES5** — see the boxed warning above.

### How to split an edition (the discriminator is NOT in the baseline)

`scope_official` in these artifacts is a **boolean**, not an edition string, so
no ES5 split is derivable from the JSONL at all. The canonical discriminator is
test262's own **`es5id:` frontmatter field**, read from the test *sources*:

```bash
grep -rl "^es5id:" test262/test/built-ins test262/test/language   # 8,088 files
```

Joined across both lane baselines, that gives a **true ES5 population of 8,087**:
pass-both 5,292 (65.4 %) · **host-pass / standalone-FAIL 1,015 (12.6 %)** ← the
real gap · standalone-pass / host-fail 329 · fail-both 1,451. The gap splits
**REFUSAL 149 (14.7 %) / WRONG ANSWER 866 (85.3 %)**, and host-import leaks
inside it are **41 rows (~4 %)**, topped by `env::__instanceof_check` at 27.
(Established by `dev-es5-coercion`; recorded here because this is where the
next person will come looking after reading the table above.)

Reproduce: `node scripts/fetch-baseline-jsonl.mjs` exports
`ensureStandaloneBaselineJsonl` (the standalone lane IS covered), then group
each entry's `imports` **by NAMESPACE first** (`env::`,
`js2wasm:runtime-eval`, `wasi_snapshot_preview1`, …) and only then by name
within each. **Do not strip `env::` and discard the rest** — that is the recipe
that produced the blind spot boxed above. Probe: `.tmp/leak-histogram2.mjs`
(gitignored; note it still carries the `env::`-only filter).

### Independent confirmation that the 54 are a distinct category

Bucketing the ES5 gap by error signature returns **96** tests matching
"invalid Wasm binary / instantiate / CompileError". Removing the 54
`js2wasm:runtime-eval` rows leaves **42** — which is *exactly* the
"`invalid Wasm binary`" count derived independently, by a different agent, from
a different cut of the same gap. Two derivations agreeing on 42 after the 54 are
separated is strong evidence the 54 really are a different failure class
(missing import at instantiation) rather than malformed output. They are eval
tests (`language/eval-code/indirect`, `language/statements/function/13.2-*-s.js`,
`language/directive-prologue`, `language/function-code`) and belong with the
runtime-eval cluster (#1066 / #2928), not with codegen.

**Corroborated from a third direction, and the cluster is bigger than 54.**
`dev-es5-coercion` finds the identical 54 as cluster #2 of their independent
866-row wrong-answer cut, *plus* a sibling — `dynamic eval is not supported in
standalone mode` at **16**. So it is **70 rows under one root cause**, not 54.
Route the whole 70. Gate on `pre-dispatch-gate.mjs` first: #1066 / #2928 have
prior art and eval-in-standalone may be a deliberate deferral rather than a bug.

## Tests

`tests/issue-2908-standalone-externget-elemaccess-leak.test.ts` — asserts
computed/named/verifyProperty-shaped/absent dynamic reads compile host-free
(`env` imports == []) and evaluate correctly in `--target standalone`.
