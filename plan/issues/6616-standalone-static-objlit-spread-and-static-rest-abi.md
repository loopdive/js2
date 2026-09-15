---
id: 6616
title: "A spread call into a STATIC or OBJECT-LITERAL method bound the spread source as one argument — and a static `...rest` formal arrived null"
status: done
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
completed: 2026-09-15
assignee: ttraenkler/senior-dev-s29
loc-budget-allow:
  # 2026-09-15 — inherited from #6612–#6615 (the S25–S28 stack this branch is
  # based on), restated here because the LOC gate reads the allowance from a
  # file the PR touches and those issue files are not in this slice's diff.
  # `src/runtime.ts` sits at 19,822 against a 19,601 ceiling on the stack tip;
  # this slice adds nothing to it.
  - src/runtime.ts
  # 2026-09-15 — #6616's own growth. `call-namespace-static.ts` is the arm that
  # CLAIMS a static call through a class-object identifier; the missing spread
  # + rest ABI has to go where the call is emitted, and the alternative (a new
  # module) would have to re-derive `paramTypes`/`funcIdx`/`memberDecl` from
  # the same local scope. +32 lines, over half of them the comment recording
  # why the rest half cannot be split from the spread half.
  - src/codegen/expressions/call-namespace-static.ts
func-budget-allow:
  # 2026-09-15 — same inheritance: `buildImports` is 308 against a 300 ceiling
  # on the stack tip. Untouched by this slice.
  - buildImports
  # 2026-09-15 — #6616's own growth, the same +29 lines as the LOC grant above,
  # in the one function that emits this call. Splitting it would have to carry
  # `paramTypes`/`funcIdx`/`memberDecl`/`calleeReadsArgsEarly` across the seam
  # for a branch that is four `const`s and one `if`.
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
---

# #6616 — a spread call into a static or object-literal method never flattened

S29 of the standalone Temporal provider run (#5383, criterion 4). Base:
`issue-5383-standalone-temporal-s28` @ `11fcafe07c`.

## The defect

Two halves of the known-callee argument ABI were missing from the arms that
claim a call whose callee is a **static method reached through a class object**
or an **object-literal method**. The instance-method arm has had both for a
long time; these two never did.

### (a) A spread argument was bound as ONE positional argument

```js
const H = { m2(a, b) { return a + "/" + b; } };
const xs = [1, 2];
H.m2(...xs);            // base: "1,2/undefined"  — the ARRAY landed in `a`
H.m2(...[1, 2]);        // base: wasm VALIDATION FAILURE (tuple struct in `a`)

class K { static s2(a, b) { return a + "/" + b; } }
K.s2(...xs);            // base: "1,2/undefined"
```

Nothing flattened the spread: each argument **node** was bound to one formal, so
the spread source arrived whole and every later formal got its default. When the
source was an inline array literal its carrier is a tuple struct rather than a
vec, and the resulting call did not even validate — the module failed to
instantiate.

The shape that matters for #5383 is the forwarding idiom, which test262's
`temporalHelpers.js` uses throughout:

```js
const H = {
  m2(a, b) { … },
  fwd(...args) { return this.m2(...args); },   // base: "1,2/undefined"
};
```

### (b) A `static f(...rest)` formal arrived `null`

Independent of any spread, and with a trap rather than a wrong value:

```js
class K { static f(...args) { return args === null ? "NULL" : "ok"; } }
K.f(1, 2);              // base: "NULL"
class K2 { static f(...args) { return args.length; } }
K2.f(1, 2);             // base: TRAP dereferencing a null pointer
```

The static-through-a-class-object arm in `call-namespace-static.ts` never called
`knownMethodRestInfo` / `emitKnownRestMethodArguments`, so the hidden rest vec
was never materialised. Every other callee shape — object-literal method, plain
function declaration, instance method — was already correct, which is what makes
this a missing arm rather than a missing mechanism.

**(b) had to be fixed together with (a).** Fixing (a) alone turned
`static fwd(...args) { return K.m2(...args); }` from a wrong value into an
**uncatchable trap**: the flattened path actually reads `args`, which was null.
A trap is worse in kind than a wrong value, so shipping (a) without (b) would
have been a regression in the failure mode even where the row failed either way.

## The fix

Four arms gain the spread handling the instance arm already had, and one of them
also gains the rest ABI:

| file | arm | `paramOffset` | added |
| --- | --- | --- | --- |
| `call-namespace-static.ts` | static through a class-object identifier | 0 | spread **+ rest** |
| `call-receiver-method.ts` | static (class arm) | 0 | spread |
| `call-receiver-method.ts` | struct receiver, nullable | 1 | spread |
| `call-receiver-method.ts` | struct receiver, non-nullable | 1 | spread |

Each follows the instance arm exactly: try `compileSpreadCallArgsWithArguments`
first when the callee reads `arguments` (#5093 — it publishes a RUNTIME `__argc`
and the extras split), otherwise `compileSpreadCallArgs`; and gate the extras
loop, the default padding and `maybeSetArgcForKnownCall` off when either the
spread or the rest path claimed the arguments.

## Why the change is bounded

The new code is reached **only** at a call site that has a `SpreadElement`
argument, or a static callee that declares `...rest`. Every such site was
previously miscompiled — wrong value, or a module that did not validate, or a
null-deref trap. There is no site where the old path was right and the new path
differs, so the change is monotone by construction, not by sampling.

## Result (measured, both labels, fresh cache per label)

| measurement | base | branch |
| --- | --- | --- |
| four families, 120 files each, standalone + provider linked | 423 (109/100/111/103) | **423**, 0 pass→fail, 0 fail→pass |
| the 57 residual rows' message buckets | — | **6 move**; `Cannot read properties of undefined (reading 'apply')` 2 → 0 |
| corpus-wide `subclassing-ignored.js` (45) + `constructor.js` (16) | 8 pass | **8 pass**, 0 flips; `reading 'apply'` **10 → 0** |
| must-not-move: `Object/keys`+`expressions/object`+`Reflect/{get,has}` (60) | 56 | 56, 0 flips |
| must-not-move: `Object/{entries,values,getOwnPropertyNames}`+`for-in` (60) | 50 | 50, 0 flips |
| must-not-move: `Function/prototype/{apply,call,bind}`+`Reflect/apply`+`class/subclass` (150) | 140 | 140, 0 flips |
| corpus byte A/B, 42 modules × {gc, standalone} | — | 84 artifacts, 0 move (a NULL control — nothing in it spreads into such a callee) |
| targeted byte A/B | — | the 3 armed sources move on BOTH lanes; the 5 unarmed ones byte-identical on both |
| Temporal provider artifact | `a7bd3c5f…` 3,308,117 B | identical — the defect is CONSUMER-side (the harness), not provider-side |
| equivalence gate | 22 / 1720 / 22 | identical |

**The headline is flat, and the reason is a second cause behind the first.** All
**45** `subclassing-ignored.js` files corpus-wide now fail on ONE assertion —
`assert.sameValue(Object.getPrototypeOf(result), construct.prototype)`, «null» vs
«undefined». `Object.getPrototypeOf` of an instance minted by a **linked provider
class** answers null, and `instanceof` across the link answers false for the same
instance, despite #5354. That is the next slice, and it is 45 files behind one
cause.

**The gc lane moves here, deliberately.** Every earlier slice in the #5383 stack
gated its change to standalone and pinned gc byte-identical. This defect is not
lane-specific — `H.m2(...xs)` bound the array into formal 0 on the WasmGC lane
too — so gating it would have left the same wrong answer in the default lane to
protect a control that measures lane-independence rather than safety. The five
unarmed byte controls, identical on both lanes, are what bounds the change.

## Residuals — reduced and sized here, NOT given their own ids

`claim-issue.mjs --allocate` exits **6** on this box (`the open-PR id scan
DEGRADED`; GitHub is 403 for every lane in this session), so no id could be
reserved against a complete universe. Reserving with `--allow-unscanned` would
hand out an id verified against neither in-flight PRs nor a second lane, and an
id reserved then abandoned leaves a permanent hole in the sequence (#3890/#3891
were burned that way). So the three residuals below are filed HERE, each with
its reduction and its corpus-wide count — enough for the next slice to open them
under real ids once `gh` is reachable.

### R1 — `Object.getPrototypeOf` of an instance minted by a LINKED provider class answers null (45 files)

**The largest single-cause block left in the Temporal corpus**, and the one that
now blocks every `subclassing-ignored.js`. Reduced in a synthetic linked pair
(`.tmp/s29/cases-j.mjs`):

| probe | answer |
| --- | --- |
| `typeof NS.PD.prototype` | `"object"` — the class object's `.prototype` IS there |
| `Object.getPrototypeOf(new NS.PD(1))` | **`null`** |
| `Object.getPrototypeOf(new NS.PD(1)) === NS.PD.prototype` | **`false`** |
| `new NS.PD(1) instanceof NS.PD` | **`"no"`** — despite #5354 |

Against the REAL polyfill the split differs and is worth carrying: there
`construct.prototype` itself reads `undefined`, so the assertion reports
«null» vs «undefined» rather than «null» vs «object».

### R2 — `typeof x` in RETURN position answers `null` inside the assembled test262 harness module

```js
function a1(x) { return typeof x; }
a1(7);   // "null" in the harness module; "number" in an ordinary module
         // and in a linked pair
function a3(x) { return typeof x.from; }
a3(Temporal.PlainDate);  // "number" — a wrong member of the union
```

Correct at top level in the same file, and correct in every ordinary module
tried. Cost two probe generations before being recognised as instrumentation
failure rather than signal. Reduced in `.tmp/s29/t/probe4.js` + `probe5.js`;
corpus-wide footprint unmeasured (a union-of-string-literals return type is
everywhere, so this is likely narrower than it looks — it did not reproduce
outside the harness assembly).

### R3 — several object literals with methods in ONE module interfere

The same `H.m2(...xs)` that compiles and runs clean in its own module fails wasm
validation (`call[0] expected type (ref null 51), found ref.as_non_null of type
(ref 125)`) when the module also carries `HF = { m2: function … }` and
`HA = { m2: (a, b) => … }`. Measured on the BRANCH tree, so it is not the defect
this issue fixes: `.tmp/s29/cases-f.mjs` (shared prelude, fails) vs
`.tmp/s29/cases-g.mjs` (one module per case, all pass), identical expressions.
Corpus-wide footprint unmeasured.

## Suspended / residual

Nothing is suspended. R1–R3 above are the open work this slice leaves behind.
