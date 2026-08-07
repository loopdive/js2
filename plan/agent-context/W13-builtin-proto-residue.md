# W13 — `Function.prototype` / `String.prototype` residue

Branch: `issue-4192-this-in-function-expression` (pushed to `origin`).
Agent: `ttraenkler/W13-builtin-proto-residue`, 2026-08-06. No `gh` in this lane —
someone else must open the PR.

## PR body

**Title:** `fix(#4192): install the receiver for .call/.apply on a variable-held function expression`

```js
var fe = function () { this.touched = true; };
var o = {}; fe.call(o);          // o.touched === undefined   (want true)
function fd() { this.touched = true; }
var p = {}; fd.call(p);          // true  ✓ — a DECLARATION already worked
```

A function **declaration** gets this right (#3796/#4025 `.call`, #3983 `.apply`
— `named-this-call.ts` reserves an exact-target trampoline that saves, installs
and restores `__current_this`). A function **expression** did not:
`resolveDeclaration` there demands `ts.isFunctionDeclaration`, and the call site
gates the whole named-`this` arm on `!closureInfo` — and `var f = function (){}`
registers a `closureMap` entry. So the dominant JS function shape fell into the
legacy arm, which evaluates `thisArg` and **drops** it. Same defect class, both
lanes: this is a JS-host bug too, not an es5-standalone one.

**The lifted body needed no change.** WAT for the repro shows it already opening
with `global.get $__current_this; ref.is_null; (if … $__undefined …)`; nothing in
the module ever *wrote* that global on this path. Only the writer was missing.

New leaf module `src/codegen/closure-receiver-install.ts`:
`planClosureReceiverInstall` (admission) + `emitClosureReceiverInstall` /
`finishClosureReceiverCall` (inline save/install/restore, mirroring
`__call_fn_method_N` and `fillDirectCallTrampolines` — including their
documented limitation that an exceptional unwind skips the restore). Admission
is narrow: a `VariableDeclaration` initialised with a `FunctionExpression`
(arrows excluded — their `this` is lexical), non-generator, non-`async`, no
explicit `this` parameter, body references its own `this`. A null receiver needs
no arm: the body's own `ref.is_null` guard already answers `undefined`, so
`f.call(null)` is unchanged.

**Measured** (base-vs-head, `--target standalone`, ES5, interpreter runtime-eval
tier): `built-ins/Function/prototype` 94 → **95**; a 148-file corpus (every ES5
file using `.call(`/`.apply(` *and* a function expression, ∪ the
`Array.prototype` HOF-`thisArg` family — the other `__current_this` consumer)
84 → **86**. **FIXED 2, BROKE 0**, no signature changes among the still-failing.
Two apparent regressions in the first sweep were parallel-run compile timeouts
and pass when re-run serially. All **8 equivalence shards** green, no new
regressions. Four ratchets green (`calls.ts` +31 LOC / `compileCallExpression`
+26 allowed in the issue frontmatter — the mechanism itself is in the new leaf
module; only the call-site wiring can live in the driver). `check:ir-fallbacks`
green. `tsc --noEmit` clean.

Covered by `tests/issue-4192-fn-expr-this-call-apply.test.ts` — 10 cases, each
on **both** lanes. Verify-first: **6 are RED on `origin/main`**; the 4 green on
both are the guards that must not move (null receiver, function declaration,
arrow, callee that never mentions `this`).

The ES5 delta is small because only 43 ES5 files use this shape at all. The
value is correctness in the dominant JS function form, in both lanes.

**Coordination:** W12 is concurrently implementing the 168-file 10.4.3
`this`-binding cluster in `src/codegen/expressions.ts`. Different mechanism,
adjacent territory. This PR touches neither `expressions.ts` nor the body's
`this` lowering — it only adds the missing *writer* of `__current_this` at one
call site. The two compose: W12 decides what a body reads when nothing is
installed; this decides what gets installed.

Also in the PR: `plan/issues/4192` (live), `4191` + `4193` as **superseded
stubs** (see below), and a re-measure section appended to `plan/issues/2875`.

## Superseded, deliberately not pursued

- **#4191** → PR **#4163**. Same defect (the in-process test262 runner never
  linked `js2wasm:runtime-eval`), but #4163 fixes it at a shared seam across all
  five instantiate sites with a structural guard, and carries a second vacuity
  fix. The stub keeps two things #4163 does not have: the measurement (**46 of
  95** ES5 `Function/prototype` standalone failures were that one phantom
  bucket) and a correction to its trigger analysis — the trigger is the
  compiler's `sourceUsesRuntimeEvalBoundary` pre-scan firing on **any
  value-position mention** of `Function`/`eval` (`var g = Function;` is enough),
  not only the `$262.evalScript` shim.
- **#4193** → **#4176 / PR #4155**, already implemented and measured **+76**.
  The stub keeps the independent census reached from the String side: of the 139
  ES5 files that assign a named property onto a builtin `.prototype`, **112
  fail**, and **63 of those are in `built-ins/Object/defineProperty`** — inside
  #4163's #1 lever but *not* behind the descriptor MOP.

## Census (2026-08-06 main, ES5 label, `--target standalone`, provider attached)

### `built-ins/Function/prototype` — 189 files, 94 pass, 95 fail

| n | mechanism | lane |
| ---: | --- | --- |
| 42 | source drives `Function(…)` / `eval` — the interpreter's `this`/global handling | #2928 |
| **34** | **`Function.prototype.bind`** | unowned, see below |
| 19 | rest (`apply`/`call` `this` → #4192, `__get_builtin` CE, proto identity) | mixed |

`bind` sub-buckets: 13 × `new (bound)()` [[Construct]]; 8 × `<Builtin>.bind(null)`
then call → `__module_init` null deref; 5 × "expected TypeError, none thrown";
3 × `this` not applied (#4192's remaining half); 3 × null deref; 1 × `bind is not
yet implemented in --target standalone`; 1 CE. **This is the largest unowned
mechanism I found inside the original brief and it still has no issue.**

### `built-ins/String/prototype` — 630 files, 528 pass, 102 fail

67 of 102 are the borrowed-method idiom, and it is **three** defects:
~23 = #4176/PR #4155 (the builtin-proto write is a no-op), ~19 = genuinely
#2875's unwired reflective glue (`split` 10, `concat` 3, `search` 2, `replace` 2,
`match` 2), ~6 = exotic-receiver `__any_to_string` answering `"[object Object]"`.
Remainder: ~16 RegExp-engine-gated (#4016/#4065 — refuted lever, do not
re-litigate), plus a long tail.

**`split` is 23 ES5 failures, not the 11 recorded in #2875** — the old number
came through the unlinked runner.

## Verdict on the original framing

**The 197-file "`Function.prototype` + `String.prototype` residue" is genuinely
fragmented — nothing inside it is above ~34 files.** After correcting the
instrumentation: 42 interpreter (#2928), ~34 `bind` (unowned), ~19 String glue
(#2875), ~20 `this`-binding (#4192), ~23 builtin-proto (#4176), ~16 RegExp
(#4016/#4065), long tail. Not worth staffing further as a unit.

## Measurement setup (reusable)

```bash
ln -s <repo>/node_modules node_modules
# test262 is a submodule dir git keeps recreating EMPTY — symlink the two
# subdirs INSIDE it, not the dir itself:
mkdir -p test262
ln -s <checkout>/test262/test    test262/test
ln -s <checkout>/test262/harness test262/harness

node --import tsx scripts/build-runtime-eval-provider.mjs   # ~100 s
TEST262_FULL_RUNTIME_EVAL=1 <sweep>                         # CI-comparable tier
```

Three traps, each of which cost time here:

1. Without `TEST262_FULL_RUNTIME_EVAL=1` you get the **REFUSAL** tier, which
   links but throws on any real dynamic-code call.
2. **Any `src/` edit invalidates the provider cache** (`computeCompilerBundleHash`)
   and silently drops you back to REFUSAL mid-A/B. That turned a clean
   `+2 / 0 regressions` into an apparent `-10` on the first run. Rebuild after
   changing the compiler and confirm the printed tier on **both** sides.
3. Sweep with **one child process per chunk** — the in-process runner executes
   test code in the caller's realm, so later tests poison earlier ones. And a
   parallel sweep produces spurious `compilation timeout` entries: re-run any
   apparent regression serially before believing it.
