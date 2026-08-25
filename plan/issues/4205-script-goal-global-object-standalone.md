---
id: 4205
title: "Script-goal global object: the pre-scan must track the lowering — nested / aliased `this.x = v` and `this.x++` (the filed 137-file / `with`-masking framing is RETRACTED, see the implementation record)"
status: done
assignee: ttraenkler/sendev-w25
sprint: 78
created: 2026-08-07
updated: 2026-08-18
completed: 2026-08-07
loc-budget-allow:
  - src/codegen/expressions/unary-updates.ts
func-budget-allow:
  - src/codegen/expressions/unary-updates.ts::compileMemberIncDec
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: global-object, script-goal-this
goal: es5
related: [2727, 4202, 4206, 1472, 3365]
origin: "2026-08-07 W23 census of the ES5 standalone failing residue (published standalone baseline 20260807, oracle v13). Ranked #1 by file count among unfiled levers, and #1 by unmasking value."
---

# #4205 — the script-goal global object

## The lever

**137 of the 1,365 failing ES5 standalone files** contain a script top-level
`this.<name> = …`, a top-level `var x = this;`, or a `fnGlobalObject()` call.
178 ES5 files with the same shape already pass, so the shape is not
automatically fatal — the failures are the ones that then **read the binding
back as a bare identifier**.

| | files |
| --- | --- |
| ES5 standalone failures using script top-level `this.x=` / `fnGlobalObject()` | **137** |
| …of which are also `with` tests (see #4206) | **96** |
| …not `with` (`Object/getOwnPropertyDescriptor` 8, `annexB/global-code` 8, misc 25) | **41** |
| ES5 files with the same shape that PASS (two-sided control) | 178 |

## Symptom

```js
this.p1 = 1;            // script goal, sloppy: creates a global binding "p1"
// …
if (!(p1 === 1)) { … }  // standalone: p1 reads `null`
```

`test/language/statements/with/S12.10_A1.1_T1.js` fails on **line 61** with
`p1 === 1. Actual: p1 ===null`. Its `with` block is on line 42. The `with`
semantics under test are never reached.

## Root cause

Standalone has no realm global object, and the one place that acknowledges
script-goal `this` is explicitly gated OFF for it. `src/codegen/expressions/call-builtin-static.ts:2315`:

```ts
const isScriptGlobalThisReceiver =
  arg0.kind === ts.SyntaxKind.ThisKeyword &&
  fctx.name === "__module_init" &&
  !ts.isExternalModule(arg0.getSourceFile()) &&
  !ctx.standalone &&
  !ctx.wasi;
```

The comment there is explicit that this is deliberately gOPD-local and that
"general Script `this` lowering belongs to the source-goal implementation".
Nothing else in the standalone lane turns a top-level `this.x = v` into a
binding that bare-identifier resolution can find, so the write lands nowhere
and the read answers `null`.

## Why this is the FIRST thing to fix in the ES5 push

It is the **masking head** of the `with` cluster. 96 of the 118 `with`-using ES5
standalone failures carry a top-level `this.x=`, and in the ones inspected the
global-`this` assertion fires *before* any `with` assertion. Landing #4206
(`with`) without this one moves far fewer files than its headline count
suggests; landing this one first converts those 96 from "fails for two reasons"
into "fails for one reason you can then measure".

Corollary from `[[reference_error_signature_is_not_a_bucket_boundary]]`: do
**not** count the 96 toward either issue's expected yield. They belong to
neither until both land.

## Acceptance criteria

- [ ] In script goal (non-module) standalone/WASI, a top-level `this.<name> = v`
      creates a binding readable as the bare identifier `<name>`, and
      `delete this.<name>` / `this.<name>` read-back agree with it.
- [ ] `typeof this === "object"` at script top level (this subsumes the narrower
      #2727 — close it as superseded or re-scope it to the `typeof` slice).
- [ ] A/B over the 137-file set with a pass-side control drawn from the 178
      currently-passing same-shape files; report both numbers.
- [ ] State the residual on the 96 `with`-overlap files separately from the 41
      non-`with` files — they are the two independent halves of the yield.

## Measurement provenance

Population: `classifyEdition() === 5` over the **standalone** baseline
(`ensureStandaloneBaselineJsonl`, 48,619 rows, oracle v13, 2026-08-07) —
8,931 files, 7,566 pass. Not a local run, so the provider-tier trap in
`[[reference_standalone_eval_instrument_reports_unmeasured_failures]]` does not
apply to these counts; anyone re-measuring locally must delete the provider
cache first (byte-size comparison is NOT a sufficient control — the cache key
tracks neither input nor output).

---

# Implementation record (W25, 2026-08-07) — the root cause is NOT the one filed

## Correction: the filed mechanism does not reproduce

The issue names `!ctx.standalone` in `isScriptGlobalThisReceiver`
(`call-builtin-static.ts:2315`) as the root cause. **That predicate is
gOPD-local — it only gates `Object.getOwnPropertyDescriptor(this, k)` — and it
is not on the path the symptom takes.** Compiled and run locally,
`--target standalone`, script goal:

```js
this.p1 = 1;
if (!(p1 === 1)) throw new Error("FAIL");   // PASSES on main, 0 imports
```

The filed symptom shape **already works**. #3956 (`collectGlobalObjectPropertyNames`
→ `sloppyImplicitGlobals` → `emitImplicitGlobalRead`), #3365 (script-goal `this`
lowers to `globalThis`) and #2996 (`emitNativeGlobalThisObject` — a real,
identity-stable `$Object` singleton) already compose into a working standalone
script-goal global object. So does `typeof this === "object"`, `this === globalThis`,
`delete this.p1`, `'p1' in this`, `gOPD(this, 'p1').writable`, and — with its
`includes:` supplied — `fnGlobalObject() === this`. All measured, all green on
unmodified main; see the AC probe table below.

**"Standalone has no realm global object" is false as of #2996.**

### What the canonical file actually fails on

`with/S12.10_A1.1_T1.js` (`p1 ===null`) delta-debugged down to, with the
runner's own message as the invariant:

```js
this.p1 = 1;
var myObj = { p1: 'a', valueOf: function () { return 'obj_valueOf'; } };
with (myObj) { p1 = 'x1'; del = delete p3; }
if (!(p1 === 1)) throw new Test262Error('p1 ===' + p1);
```

Drop the `valueOf` member and the same file fails **differently** —
`p1 === 'x1'`, i.e. the `with`-scoped assignment wrote the GLOBAL instead of
`myObj`. Both outcomes are `with` lowering, and `this.p1 = 1` is load-bearing
only as the thing that gives `p1` a value to be wrong about. **This is #4206,
not #4205.**

Mechanism split of the 160 shape-matching ES5 standalone failures (my scan is
slightly wider than the census's 137; same population):

| family | files | of which `with` |
| --- | --- | --- |
| other `Test262Error` | 60 | 31 |
| `with` refusal (`#1387 requires a proven closed object-literal shape`) | 31 | 31 |
| assertion got `null` | 23 | 21 |
| null-deref trap | 17 | 13 |
| runtime error | 11 | 0 |
| illegal-cast trap | 7 | 0 |
| host-import leak | 5 | 0 |
| `ReferenceError: … is not defined` | 4 | 3 |
| standalone RegExp codegen | 2 | 0 |

21 of the 23 `p1 ===null` files are `with/S12.10_A1.*`. **The lever is a shape,
and the shape is not the mechanism** — the same trap
`[[reference_error_signature_is_not_a_bucket_boundary]]` warns about, one level
up: bucketing by *syntax* is no better than bucketing by *error string* when
neither was A/B'd.

## Design decision — static correspondence, not a reified global object

The issue asks whether to introduce a realm global object in standalone. **The
answer is no, and it is already moot**: `emitNativeGlobalThisObject` (#2996) is
one. The real question is the *correspondence* between the two halves of the
Global Environment Record — the object half (properties on that singleton) and
the declarative half (script `var`s / functions, which are Wasm module globals).

Two candidate architectures:

- **Reify** — make the object the storage: every global read/write becomes a
  dynamic property lookup on the singleton. Spec-shaped, and wrong here: it
  converts every one of the ~8,900 ES5 files' global accesses from a
  `global.get` into an `__extern_get` + string key, for a defect surface
  measured below at tens of files. Rejected on cost and blast radius.
- **Static correspondence (chosen)** — keep module globals as storage, and keep
  a compile-time set of names the object half owns, so a bare-identifier read
  and a `this.<name>` write agree. This is exactly what #3956 built; the defects
  below are all places where the *scan* and the *lowering* had drifted apart, so
  the fix is to bring the scan back into step with the lowering rather than to
  add a mechanism.

The invariant this establishes, and that any future change here must keep:
**`collectGlobalObjectPropertyNames` must recognise exactly the receivers that
`thisBelongsToTopLevelCode` / the #3365 `ThisKeyword` arm lowers to the global
object.** Narrower ⇒ a write happens with no name registered (silent `0` on the
read — the bug fixed here). Wider ⇒ a name registered for a receiver that is not
the global object (a spurious `ReferenceError`). One deliberate exception is
retained: the walk stops at arrow functions, where the lowering is transparent.
That is the *safe* side of the invariant (registers no name), and it is called
out at the walk so a later widening is a decision, not an accident.

## The defects, decomposed

Each was isolated to the half that is actually broken. In G1/G3/G4 **the write
already lands on the realm global object** — verified by reading it back through
`globalThis.<n>`, which passes on unmodified main. Only the read side, or the
update lowering, was wrong.

| id | shape | main | expected | fixed here |
| --- | --- | --- | --- | --- |
| G1 | `var g = this; g.q = 7; q` | `q` reads `0` | `7` | yes |
| G3 | `this.n = 1; this.n++` | `f64.const NaN`, **write dropped** | `n === 2` | yes |
| G4 | `if (c) { this.r = 2; } r` | `r` reads `0` | `2` | yes |
| G2 | `var v = 1; this.v` | `undefined` | `1` (CreateGlobalVarBinding) | no — see below |
| G5 | `var k='p'; this[k]=1; p` | `ReferenceError` | `1` | no — key not static |
| G8 | `function f(){this.z=3} f(); z` | `ReferenceError` | `3` | no — see below |
| — | `function f(){'use strict'; this.z=3} f()` | no throw | `TypeError` | no — #4190 lane |

G3's wat is the clearest of the three: `globalThis.n = 1; globalThis.n++`
emitted `call $__extern_set` and then, for the whole `++`,
`f64.const NaN` `drop`. The checker types both `this` and `globalThis` as
`typeof globalThis`, `resolveStructName` resolves that to the large static
global-interface struct, the struct has no field `n` (it was created at
runtime), and the missing-field arm is a graceful NaN. The new shared
`receiverIsRealmGlobalObject` predicate is the generalisation of the
gOPD-local warning already written on `isScriptGlobalThisReceiver`: *the realm
global object is not that struct.* Other member paths keyed on
`resolveStructName` are candidates for the same treatment.

### Deferred, with measured reasons

- **G2** (script `var` visible as a global-object property) is the one genuinely
  structural item left. Doing it right means the `var` and the property are the
  SAME cell, which the static-correspondence design supports — compile
  `this.<n>` / `globalThis.<n>` to the module global when `n ∈
  globalObjectVarBindings` and the goal is Script, and answer `false` for
  `delete this.<n>` (var bindings are non-configurable). Honest AST-based
  sizing: **10 failing ES5 standalone files, 0 passing** (four of them —
  `S11.3.1/11.3.2/11.4.4/11.4.5_A2.1_T1` — are also G3 and may move on G3 alone).
  Left out of this PR to keep the change to read-side/lowering fixes whose write
  side was already proven correct; G2 changes where a *write* goes.
- **G8** (`this.<n> = v` inside a sloppy function, read as bare `n`) sizes at
  **26 failing / 4 passing**, but the failing set is dominated by the same
  `with/S12.10_A1.*` family (writes to `p2` from inside a `with`), so its
  independent yield is entangled with #4206. Widening the scan into function
  bodies also has the largest blast radius of any option here: every
  `function C(){ this.x = 1 }` constructor matches syntactically.
- **G5** needs a dynamic global-object read fallback for an unresolvable name,
  not a static name set.

### Not a defect (retracted)

`fnGlobalObject()` was in the census's shape predicate as a symptom. It is
**correct on main**: with `includes: [fnGlobalObject.js]` supplied,
`this.p1 = 1; var g = fnGlobalObject(); g.p1 === 1 && g === this` passes in
standalone. An earlier probe of mine that showed it returning `null` was invalid
— it omitted the `includes`, so `fnGlobalObject` was simply undefined. Recorded
because the invalid probe is the more believable of the two results.

## Instrument

- `bash scripts/provision-worktree-deps.sh`; standalone baseline via
  `ensureStandaloneBaselineJsonl({force:true})` (48,619 rows, oracle v13) — NOT
  the default host jsonl.
- Provider cache **deleted** per arm, rebuilt with
  `node --import tsx scripts/build-runtime-eval-provider.mjs`, run with
  `TEST262_FULL_RUNTIME_EVAL=1`. Confirmed live: the runner announced
  `runtime-eval tier: INTERPRETER`. The cache key was `854c120ce015d507` on
  **both** arms across a real `src/` edit — the key tracks neither input nor
  output, exactly as
  `[[reference_standalone_eval_instrument_reports_unmeasured_failures]]` says;
  deleting the `.wasm` is the only control.
- Base re-cut on `origin/main` @ `24e956cb55` (fetched at measurement time), by
  file-copy A/B — never `git stash`.
- My ES5 population reproduces the baseline: 8,931 files, 7,562 pass (84.67 %)
  against the census's 7,566.

## Budget allowances

`compileMemberIncDec` (`src/codegen/expressions/unary-updates.ts`) grows by 6
lines: the receiver test plus its comment. Both budgets are granted for this
change-set rather than worked around, because the alternative — a new
`tryEmitGlobalObjectIncDec` seam in a separate module — costs MORE lines in the
god-file (the call site plus its early-return) than the three-line predicate
call it would replace, so it would make the file the rule protects bigger, not
smaller. The rationale itself lives on `receiverIsRealmGlobalObject`
(`helpers/sloppy-this-global.ts`), outside the god-file, which is where the next
member path that needs the same treatment will look for it.

## AC probe table — `--target standalone`, script goal, run locally

Every row was compiled and executed; "main" is `origin/main` @ `24e956cb55`,
"this PR" is that plus the three-file change. Probes that need a decoded
assertion message were run through `runTest262File(..., "standalone")` at the
INTERPRETER provider tier so the strings are the CI ones; the rest through
`compile({target:"standalone"})` + instantiate, asserting 0 imports.

| probe | main | this PR |
| --- | --- | --- |
| `this.p1=1; p1===1` | pass | pass |
| `this['p1']=1; p1===1` | pass | pass |
| `this.p1=1; this.p1===1` | pass | pass |
| `this.p1=1; delete this.p1; typeof p1==='undefined'` | pass | pass |
| `this.p1=1; delete this.p1; p1` throws `ReferenceError` | pass | pass |
| `typeof this === 'object'` | pass | pass |
| `this !== null` | pass | pass |
| `this === globalThis` | pass | pass |
| `q1=5; this.q1===5` | pass | pass |
| `function f(){return this.p1} f()===1` | pass | pass |
| `this.o={}; typeof o==='object'` | pass | pass |
| `'p1' in this` | pass | pass |
| `this.nope === undefined` | pass | pass |
| `gOPD(this,'p1').value===1` | pass | pass |
| `gOPD(this,'p1').writable===true` | pass | pass |
| `fnGlobalObject().p1===1 && ===this` (with `includes:`) | pass | pass |
| `if(true){this.r=2} globalThis.r===2` | pass | pass |
| `if(true){this.r=2} r===2` | **fail** `r=0` | pass |
| `for(...){this.r=2} r===2` | **fail** `r=0` | pass |
| `try{this.r=2}catch{} r===2` | **fail** `r=0` | pass |
| `var g=this; g.q=7; globalThis.q===7` | pass | pass |
| `var g=this; g.q=7; q===7` | **fail** `q=0` | pass |
| `var g=globalThis; g.q=7; q===7` | **fail** `ReferenceError` | pass |
| `this.n=1; this.n++; n===2` | **fail** `illegal cast` | pass |
| `globalThis.n=1; globalThis.n++; ===2` | **fail** `illegal cast` | pass |
| `this.n=1; this.n+=1; n===2` | pass | pass |
| `var o={n:1}; o.n++` (control) | pass | pass |
| `function C(){this.x=1} new C(); no globalThis.x leak` | pass | pass |
| `var v1=1; this.v1===1` | **fail** `undefined` | **fail** — G2, deferred |
| `var v1=1; globalThis.v1===1` | **fail** `undefined` | **fail** — G2 |
| `var v1=1; gOPD(this,'v1')` | **fail** no descriptor | **fail** — G2 |
| `var k='p'; this[k]=1; p===1` | **fail** `ReferenceError` | **fail** — G5 |
| `function f(){this.z=3} f(); globalThis.z===3` | pass | pass |
| `function f(){this.z=3} f(); z===3` | **fail** `ReferenceError` | **fail** — G8 |
| `function f(){'use strict'; this.z=3} f()` throws `TypeError` | **fail** no throw | **fail** — #4190 lane |

Note the pattern in the fixed rows: the `globalThis.<n>` read-back passes on
**main**, so the write was never the problem.

## A/B result

Population = the 160 shape-matching ES5 standalone **failures** (the census's
137, my slightly wider scan) + the full 224-file **pass-side control** (the
census's 178) + the 4 exposed files not already in either = **388 files**, every
one run on both arms, no sampling.

| arm | n | base pass | head pass |
| --- | --- | --- | --- |
| lever (baseline FAIL) | 160 | 0 | **5** |
| control (baseline PASS) | 224 | **224** | **224** |
| exposure (not in either) | 4 | 0 | 2 |

**FIXED 7 · BROKE 0 · same-verdict-different-error 0.**

Instrument validity, stated before the result rather than after: the base arm
**reproduces the standalone baseline on 388 of 388 files** (0 disagreements),
and the control shows the runner can see a pass (224/224). A lever-only run
cannot tell "my fix did nothing" from "my runner cannot see a pass"; both read
as 0.

The 7:

```
test/language/comments/S7.4_A1_T1.js
test/language/comments/S7.4_A2_T1.js
test/language/punctuators/S7.7_A1.js
test/language/expressions/postfix-increment/S11.3.1_A2.1_T1.js
test/language/expressions/postfix-decrement/S11.3.2_A2.1_T1.js
test/language/expressions/prefix-increment/S11.4.4_A2.1_T1.js
test/language/expressions/prefix-decrement/S11.4.5_A2.1_T1.js
```

All seven are the **G3** slice (`this.n++` / `globalThis.n++`). The G1 and G4
slices fixed real defects — every probe in the table above flips — but no ES5
test262 file in the corpus exercises them, which the exposure sizing predicted
before the run and the run confirmed.

### Exposure — the honest denominator

Sized from the change's own reachability, by running the compiler's OWN
predicates (`collectGlobalObjectPropertyNames` new-vs-old, and a
`thisBelongsToTopLevelCode`-gated inc/dec scan) over each file's effective
source (`assert.js` + `sta.js` + `includes:` + body), not by grepping error
strings. Over **all 48,619 baseline rows**:

| | files |
| --- | --- |
| exposed, baseline FAIL | **12** |
| exposed, baseline PASS | **0** |

Zero exposed passing files in the entire corpus is the regression argument:
there is no test the change can reach that is currently green. 10 of the 12 are
ES5 and were in the A/B above; the 2 non-ES5 ones were run separately on both
arms —

- `built-ins/Object/getOwnPropertyDescriptors/tamper-with-global-object.js` —
  fail → fail, but the signature **advances**: base dies at
  "Sanity check failed: could not modify the global Object", head gets past it
  to "Expected string primitive to have 2 descriptors". Not a regression; a
  partial unblock.
- `language/identifier-resolution/assign-to-global-undefined.js` — `expected
  ReferenceError` on both arms, unchanged.

### Reclassification into #4206: ZERO — and that is the finding

The issue predicted that landing this would convert ~96 `with` files from
"fails on `this.p1`" to "fails on `with`", and asked for that list. **It does
not happen. Not one file changed its error signature** (`same verdict,
different error: 0` across all 388, and 99 of the 160 are `with` tests).

That is the direct, per-file confirmation of the correction at the top: the
`with` files were never masked by a script-goal-global defect, because there was
no script-goal-global defect on their path. They fail on `with`, they failed on
`with` before, and they will keep failing on `with` until #4206 lands. **#4206's
yield should therefore be estimated from its own mechanism, unmasked and
undiscounted — the "sequence #4205 first" dependency does not exist.**

### Hand-off to #4206 — a minimal repro found on the way

Delta-debugged from `with/S12.10_A1.1_T1.js`; both variants are pure `with`
lowering, no `this`-global involvement:

```js
// (1) writes the GLOBAL instead of the with-object
this.p1 = 1; var myObj = { p1: 'a' };
with (myObj) { p1 = 'x1'; del = delete p3; }
p1  // 'x1'  — spec: 1, and myObj.p1 === 'x1'

// (2) add a prototype-named member and the same file fails DIFFERENTLY
var myObj = { p1: 'a', valueOf: function () { return 'v'; } };
// … same body …
p1  // null
```

31 of the 160 carry the compiler's own `#1387 with statement requires a proven
closed object-literal shape` refusal, so `proveObjectLiteralWithTarget` /
`OBJECT_PROTOTYPE_KEYS` in `src/codegen/with-scope.ts` is the first place to
look.

## Status

Acceptance criteria, re-stated against what was measured:

- [x] top-level `this.<name> = v` readable as bare `<name>`; `delete this.<name>`
      and the `this.<name>` read-back agree — **already true on main**, verified
      not assumed, and extended here to nested and aliased writes.
- [x] `typeof this === "object"` at script top level — **already true on main**.
      #2727 is superseded; recommend closing it as such.
- [x] A/B over the lever set with the full pass-side control — 160 + 224 + 4,
      every file, both arms.
- [x] Residual stated separately for the `with` overlap (99 files, unchanged,
      → #4206) and the non-`with` remainder (7 fixed here).

Deferred with sizing, not dropped: **G2** (10 files) is the one remaining
structural slice and has a design above; **G5** and **G8** need mechanisms this
PR deliberately does not add. Recommend a follow-up issue for G2 rather than
holding this one open.
