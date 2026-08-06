# W13 — `Function.prototype` / `String.prototype` residue: measured census + PR body

Branch: `issue-4191-runner-runtime-eval-seam` (pushed to `origin`).
Agent: `ttraenkler/W13-builtin-proto-residue`, 2026-08-06.

## PR body (for whoever opens it — I have no `gh`)

**Title:** `fix(#4191): test262 in-process runner now links the standalone runtime-eval provider`

`tests/test262-shared.ts` (sharded CI) and `scripts/test262-worker.mjs` both
attach the cached `js2wasm:runtime-eval` namespace before instantiating a
`--target standalone` module. `tests/test262-runner.ts` — the runner every
triage lane uses in-process — did not.

The compiler's pre-scan (`sourceUsesRuntimeEvalBoundary`) emits that import for
**any value-position mention** of `Function`/`eval`, not just `new Function(src)`:
`var g = Function;`, `for (var p in Function)`,
`Function.propertyIsEnumerable('prototype')` all qualify. Every such standalone
module therefore died at `WebAssembly.instantiate` with
`Import #0 module="js2wasm:runtime-eval": module is not an object` — **and that
link error overwrote the test's real failure signature.**

Measured on ES5-label `built-ins/Function/prototype`, `--target standalone`:
before, **46 of 95 failures** collapsed onto that one bogus bucket; after, the
bucket disappears and the real distribution is `bind` 34, apply/call `this` 19,
misc. Three lanes in a row were pointed at that phantom.

New shared seam `attachRuntimeEvalProvider(binary, imports, target)`, applied at
both standalone instantiate sites. Mints a **fresh** provider namespace per
module (interpreter globals never leak — same policy as `test262-shared.ts`) and
only when the module actually asks for the carrier. Host lane and non-asking
standalone modules untouched.

Covered by `tests/issue-4191-runner-runtime-eval-seam.test.ts` (6 cases:
premise, defect, fix, per-module provider identity, host-lane no-op,
no-carrier no-op). `tsc --noEmit` clean; all four ratchets clean (0 changed
`src/` files — this is a `tests/` + `plan/` change).

Also in the PR: `plan/issues/4191`, `4192`, `4193` (new), and a re-measure
section appended to `plan/issues/2875`.

## Measurement setup others should reuse

```bash
ln -s <repo>/node_modules node_modules            # if your worktree lacks it
# test262 is a submodule dir git keeps recreating EMPTY — symlink the two
# subdirs INSIDE it, not the dir itself:
mkdir -p test262
ln -s <checkout-with-test262>/test262/test    test262/test
ln -s <checkout-with-test262>/test262/harness test262/harness

node --import tsx scripts/build-runtime-eval-provider.mjs   # ~100 s, once
TEST262_FULL_RUNTIME_EVAL=1 <sweep>                         # CI-comparable tier
```

Without the env var you get the **REFUSAL** tier, which links but throws on any
real dynamic-code call — CI standalone uses **INTERPRETER**
(`test262-sharded.yml`). The tier is printed on first use; read that line.

Sweep with **one child process per chunk** — the in-process runner executes test
code in the caller's realm and later tests poison earlier ones.

## The census (2026-08-06 main, ES5 label, `--target standalone`)

### `built-ins/Function/prototype` — 189 files, 94 pass, **95 fail**

| n | mechanism | lane |
| ---: | --- | --- |
| 42 | test source drives `Function(…)` / `eval` — the interpreter's `this`/global handling, not builtin-proto glue | #2928 |
| **34** | **`Function.prototype.bind`** | see below |
| 19 | rest (`apply`/`call` `this`, `__get_builtin` CE, proto identity) | #4192 + misc |

`bind` sub-buckets: 13 × `new (bound)()` [[Construct]]; 8 × `<Builtin>.bind(null)`
then call → `__module_init` null deref; 5 × "expected TypeError, none thrown";
3 × `this` not applied (**that is #4192**); 3 × null deref; 1 × `bind is not yet
implemented in --target standalone`; 1 CE.

### `built-ins/String/prototype` — 630 files, 528 pass, **102 fail**

67 of 102 are the borrowed-method idiom, and it decomposes into **three
different defects** — see the appended section in `plan/issues/2875`:
~23 = **#4193** (builtin-proto write is a no-op), ~19 = unwired reflective glue
(`split` 10, `concat` 3, `search` 2, `replace` 2, `match` 2 — genuinely #2875's),
~6 = exotic-receiver `__any_to_string`. Remainder: ~16 RegExp-engine-gated
(#4016/#4065 — refuted lever, do not re-litigate), plus a long tail.

**`split` is 23 ES5 failures, not the 11 recorded in #2875** — the old number
came through the broken runner.

## The two strategy-changing findings

### #4193 — 112 ES5 files on one mechanism (the biggest thing here)

Writing a **named** property onto **any** builtin `.prototype` is a silent
no-op in standalone. `$NativeProto` has no own-property store. Of the 139 ES5
files that use the idiom, **112 fail**; 63 of them are in
`built-ins/Object/defineProperty`, i.e. inside #4163's #1 lever (857 reachable)
but **not** the descriptor MOP — they are attributes bags inheriting from a
patched `Array.prototype` / `Function.prototype`.

#4160 already built the exact substrate for **integer-index** keys on
`Object.prototype`/`Array.prototype`. #4193 is that generalised to named keys
and all brands. XL. `proto-index-store.ts` had unmerged PRs against it on
2026-08-06 — check before starting.

### #4192 — `this` is dead in a variable-held function expression, in BOTH lanes

```js
var fe = function () { this.touched = true; };
var o = {}; fe.call(o);   // undefined  (want true) — .apply/.bind/o.m() all the same
function fd() { this.touched = true; }
var p = {}; fd.call(p);   // true  ✓ — a DECLARATION works
```

`resolveDeclaration` (`named-this-call.ts:94`) demands `ts.isFunctionDeclaration`,
and the call site (`calls.ts:~7005`) additionally gates on `!closureInfo` — a
`var f = function(){}` has a `closureMap` entry, so it takes the legacy
evaluate-`thisArg`-and-**drop** path. Same defect class #4025/#3983 fixed for
declarations, left standing for the dominant shape. This is a **host-lane bug
too**, so it is not an es5-standalone-only lever.

## Verdict on the original framing

The 197-file "`Function.prototype` + `String.prototype` residue" is **not one
residue and is not mostly builtin-proto glue.** After correcting the
instrumentation it is: 42 interpreter (#2928), ~34 `bind`, ~23 + ~63 elsewhere
builtin-proto named expando (#4193), ~19 String glue (#2875), ~20 `this`-binding
(#4192), ~16 RegExp (#4016/#4065), long tail. **No mechanism inside the original
197 exceeds ~34 files** — but #4193, found from inside it, is 112 and reaches
into the campaign's largest lever. That is where the next max-effort slice
belongs.
