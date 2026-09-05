---
id: 4774
title: "invalid module: mixed boolean/number prototype method + string concat emits a binary WebAssembly.compile rejects"
status: done
sprint: current
created: 2026-08-27
completed: 2026-08-27
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
related: [4406, 4414, 3754, 745]
# (2026-08-27) The fix is 2 lines of predicate at the #745 S3 gate in
# `compileBinaryExpression`; the rest of the +17 is the comment recording WHY
# the repair is on the PRODUCER and not on the `.length` consumer that reported
# the error. That gate has now silently mis-typed a `+` once; the next reader
# standing at it needs the invalid-module story in place, not a pointer. The
# predicate cannot move to a subsystem module — it is a routing decision that
# needs `leftTsType`/`rightTsType` and must sit between the any-dispatch limb
# and the string-concat arms it hands off to.
loc-budget-allow:
  - src/codegen/binary-ops.ts
func-budget-allow:
  - src/codegen/binary-ops.ts::compileBinaryExpression
# (2026-08-27) Reserved with `--allow-unscanned` because this container has no
# `gh`, so `claim-issue.mjs`'s open-PR id scan degrades unconditionally. The
# scan was NOT skipped — it was run directly against the REST API with curl:
# 5 open PRs on loopdive/js2 touch issue ids {2949, 4406, 4768, 4770, 4771,
# 4773}. 4774 is not among them.
---

# #4774 — `compile()` says success, `WebAssembly.compile()` rejects the binary

## Problem

A prototype method whose return set is **mixed** boolean/number, installed
directly on `P.prototype`, and whose result is consumed by **string
concatenation**, emits a module that fails wasm validation. The compiler
reports `success: true` and produces no diagnostic, so the failure surfaces
only when someone instantiates the binary.

Found while implementing
[#4406](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4406-return-type-unboxing-abi)
Phase 0+1 (PR #5061) — it broke a negative test written for that slice. It is
**not** caused by that work: it reproduces identically with
`JS2WASM_RET_UNBOX_ABI` set and unset, and on `origin/main` @ `7e0b03ebb7`
with every file that PR touches reverted to `HEAD`.

## Repro

`target: "standalone"`, `optimize: 0`, no flags set:

```js
function P(n) { this.n = n; }
P.prototype.eq   = function (x) { return this.n === x; };
P.prototype.pred = function (x) { if (x > 100) { return 7; } return this.eq(x) && this.eq(x); };
function inner() { var p = new P(5); return ("" + p.pred(5)).length; }
export function run() { return inner(); }
```

```
result.success === true            // no diagnostic at all
await WebAssembly.instantiate(result.binary, {})
  CompileError: Compiling function #63:"inner" failed:
    struct.get[0] expected type (ref null 6), found block of type (ref null 71)
```

With two concat sites (`… + ("" + p.pred(200)).length`) the same failure reads
`found call of type (ref null 71)` — same class, different producer instruction
under the `struct.get`.

## Bisect — all THREE ingredients are required

Measured 2026-08-27; change any one row's condition and the module is valid:

| variant | result |
| --- | --- |
| `P.prototype.pred = …` mixed return, 2 concat sites | **INVALID MODULE** |
| `P.prototype.pred = …` mixed return, 1 concat site | **INVALID MODULE** |
| same, consumed by a CONDITION instead of concat (`p.pred(5) ? 1 : 0`) | valid, `run = 8` |
| same, but the return set is PURE boolean | valid, `run = 9` (and correct) |
| same mixed return, installed as `var pp = P.prototype; pp.pred = …` | valid, `run = 2` |

So it needs all of: (1) the direct `P.prototype.<m> = …` install form, **not**
the aliased one; (2) a return set the whole-program fixpoint sees as mixed
boolean/number (`if (…) return 7;` plus a boolean tail); (3) a string-concat
consumer.

The `(ref null 71)` vs `(ref null 6)` mismatch says a `struct.get` is handed a
value of the wrong struct type — the shape of an ABI disagreement between the
producer of `p.pred(5)`'s result and the concat lowering that consumes it, not
of a stack-height bug.

## Why it matters

`compile()` returning `success: true` for a module no engine will accept is the
worst failure mode available: nothing in the compile-time diagnostics, the
equivalence suites, or a `--wat` inspection flags it. It is caught only by
instantiating, which a caller may do far from the compile.

The VALUE is also wrong in the neighbouring *valid* cases — `("" + p.pred(5))`
on a mixed-return method reads `"1"` where node says `"true"`. That is
[#4414](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4414-boolean-returns-minted-as-f64-numeric-twins)'s
residual (the f64 numeric twin for a method the boolean fixpoint withdrew), and
it is a **separate** defect: the wrong-value variants above still produce a
valid module. Do not conflate the two.

## Acceptance criteria

- The repro compiles to a module `WebAssembly.compile` accepts, or `compile()`
  reports a diagnostic instead of claiming success.
- An equivalence test covering the shape (mixed-return prototype method under
  string concatenation), oracled against plain JS — the js-host lane cannot run
  the prototype-method shape at all (#4227 family, see #4414's closing note).
- The bisect table above still discriminates. A "fix" that makes both install
  forms decline would hide the defect rather than close it.

## Pointers

- `refinedTwinReturnType` (`src/codegen/typed-this.ts`) is what gives the mixed
  method an `f64` twin — `Prover.isNumeric` answers true for booleans and the
  `numericFunctions` loop carries no `isBooleanish` filter (see #4414's Problem
  section and #4406's plan §1.2).
- `compileNativeConcatOperand` (`src/codegen/string-ops.ts`) is the standalone
  `+`-concat cascade #4414 already had to teach about the boolean brand; it is
  deliberately not routed through the coercion engine.
- The install-form sensitivity (`P.prototype.m =` vs `pp.m =`) points at
  `fnctorEscapeGate.protoMethodWriteOnce` / `writeOnceMethodKeyOf`: the two
  forms produce different write-once verdicts, which is why only one of them
  reaches the refinement at all.

## Resolution (2026-08-27)

### Root cause — the `+` producer, not the prototype

**None of the three "required ingredients" is actually required.** The
prototype, the install form and the method call are all one thing in disguise:
whether the CHECKER gives the right-hand operand of `+` the static type
`number | boolean`. Strip them all away and the defect is intact:

```js
function f(x) { if (x > 100) { return 7; } return x === 5; }
export function run() { return ("" + f(5)).length; }
```

`target: "standalone"`, `optimize: 0`, no flags — `success: true`, and
`WebAssembly.compile` rejects with the same
`struct.get[0] expected (ref null 6), found (ref null 71)`. It reproduces in
**TypeScript** too, with the union written out (`function f(x: number): number |
boolean`), so the "JS input" ingredient is not real either — a `.ts` file simply
types the *prototype* spelling differently. (The issue's own repro needs
`fileName: "…​.js"` to reproduce; with a `.ts` name the checker types
`p.pred(5)` as something other than the union and the gate never arms. That is
why a first reproduction attempt on `p.ts` came up green.)

The mechanism, in `src/codegen/binary-ops.ts::compileBinaryExpression`:

1. `unionRepEqInvolved` (the #745 S3 gate, ~L1207) is true whenever **either**
   operand's static type is a heterogeneous primitive union. `number | boolean`
   is exactly that.
2. The admission just below it takes `isPlusOp || isEqualityOp`, so the `+` is
   handed to `compileAnyBinaryDispatch` → `__any_add`, which returns
   `{kind:"ref", typeIdx: ctx.anyValueTypeIdx}` — the tagged **`$AnyValue`**
   carrier. (Traced: `anyDispatch "\"\" + f(5)" leftIsAny false rightIsAny false
   unionRepEqInvolved true -> {"kind":"ref","typeIdx":57}`.)
3. Every consumer of that expression lowers from its **static** type, which is
   `string`. `.length` reaches `property-access-dispatch.ts` ~L3634, which
   compiles the receiver and then pushes a bare
   `struct.get $AnyString 0`. Its only representation defence is an `externref`
   special case (#1797/#4607); `$AnyValue` is neither `externref` nor
   `$AnyString`, so nothing coerces.

That is the whole error: `(ref null 6)` is `$AnyString`, `(ref null 71)` is
`$AnyValue`, and no `struct.get` can bridge them.

**The gate's own name says it was built for equality** — `unionRepEqInvolved`,
and #745 S3's comment is about `__any_strict_eq`/`__any_eq`. `+` rode in on the
admission written for the *older* `leftIsAny && rightIsAny` limb, where the
runtime string-vs-number dispatch is genuinely needed because neither operand's
type is known.

### Divergence point

`src/codegen/binary-ops.ts`, the `if (isPlusOp || isEqualityOp)` admission
inside the `(leftIsAny && rightIsAny) || unionRepEqInvolved` block.

§13.15.3 step 7 concatenates whenever **either** ToPrimitive result is a String.
So a `+` with a statically-string operand is unconditionally a string
concatenation, and its result type is `string` regardless of what the other
operand holds at runtime. Producing a `$AnyValue` for it contradicts the type
every consumer will read.

### Why the fix is on the producer

The `.length` consumer merely reported the disagreement first. `charCodeAt`
carries the *same* disagreement through a **checked** cast and therefore
compiles fine and then **traps at runtime with `illegal cast`** — measured on
unmodified HEAD:

| consumer of `("" + f(5))` | HEAD | fixed |
| --- | --- | --- |
| `.length` | `WebAssembly.compile` rejects | `4` |
| `.charCodeAt(0)` | runtime trap `illegal cast` | `116` |

`__str_concat`, `===` and every other string consumer read the same static type.
Casting at `.length` would have moved the bug, not closed it.

Confirming A/B on **unmodified HEAD**: `JS2WASM_UNION_ANYREP=0` alone makes the
repro both valid and correct (`4`). The defect lives entirely inside the
`unionAnyRep` limb, and the fix reproduces the kill-switch's answer for this
shape without giving up the representation.

### Fix

Two lines: decline the any-dispatch for a `+` that is statically a string
concatenation, letting it fall through to the string-concat route that already
sits below (which returns a native `$AnyString` ref — the representation the
consumers assume).

```ts
const plusIsStaticallyStringConcat =
  isPlusOp && (isStringType(leftTsType) || (isStringType(rightTsType) && !isBigIntType(leftTsType)));
if ((isPlusOp && !plusIsStaticallyStringConcat) || isEqualityOp) {
```

Byte-neutral for the `leftIsAny && rightIsAny` limb: an `any` is not a string
type, so a both-`any` `+` cannot reach the new guard and keeps its runtime
dispatch. The two disjuncts mirror the two string-concat arms that receive the
hand-off (`isStringType(leftTsType)`, and `isStringType(rightTsType) &&
!isBigIntType(leftTsType)`), so declining always lands somewhere.

### Measured — before / after

Bisect table from the Problem section, re-measured (12-hex sha256 of the emitted
binary; `standalone`, `optimize: 0`, `.js`):

| variant | HEAD | fixed | digest |
| --- | --- | --- | --- |
| direct install, mixed, 1 concat | **INVALID MODULE** | `4` ✓ node | changed (repaired) |
| direct install, mixed, 2 concat | **INVALID MODULE** | `5` ✓ node | changed (repaired) |
| condition consumer | `1` | `1` | `0cd690f7db35` **byte-identical** |
| pure-boolean return set | `4` | `4` | `7d7999022064` **byte-identical** |
| alias install (`pp.pred = …`) | `1` | `1` | `727d8a15ba21` **byte-identical** |

The bisect table still discriminates, as the acceptance criteria require: the
alias form keeps its #4414 residual (`"1"` where node says `"true"`), so the
install-form difference is still visible and was not papered over.

The two repaired rows now match the node oracle exactly (`4` and `5`) — the
#4414 residual does **not** apply to the direct-install form once the concat
takes the native route.

Wider checks:

- 25-row `+`-shape matrix oracled against node (`.tmp/matrix.mjs`): HEAD had 4
  disagreements, 2 of them hard failures (`.length` invalid module,
  `charCodeAt` illegal-cast trap). Fixed: 2 disagreements remain, both the
  pre-existing #4414 union-carrier residual (`unionvar + str`, `str +
  unionvar`), and both **byte-identical** before/after (`1781f23a02cc`,
  `ad0137ab80d9`) — untouched, as intended.
- `website/playground/examples` corpus, 13 files × {standalone, gc} = 26
  binaries: **0 digest changes**.

### Tests

`tests/issue-4774-union-concat-anyvalue-carrier.test.ts` — 10 cases. On
unmodified HEAD **6 fail and 4 pass**, and the 4 that pass are exactly the
near-miss variants that must not move. Covers:

- the reported three-ingredient shape, both 1- and 2-concat, asserted through
  `WebAssembly.compile` (not `.validate`, so a rejection carries detail);
- the minimal no-prototype shape at both consumers (`.length` — validation;
  `.charCodeAt` — runtime trap) plus the union's numeric arm;
- `unionAnyRep: true` vs `false` answering the same value — the invariant the
  fix restores, stated without reference to any lowering;
- the three near-misses. The alias row is pinned at the **knowingly wrong** `1`
  with an explicit `not.toBe(4)` sanity assertion and a comment saying node
  answers `4` and that this expectation should become `4` when #4414's residual
  closes — deliberately not encoded as correct-forever.

Gates: `typecheck` ✓ · `lint` ✓ · `check:ir-fallbacks` unchanged ✓ ·
`check:ir-only` READY ✓ · `check:coercion-sites` ✓ · `check:oracle-ratchet` ✓ ·
`check:dead-exports` ✓ · loc/func budget granted in this file's frontmatter with
rationale · equivalence suite, 8 shards ✓.

### Follow-up — should `compile()` have caught this itself?

**A cheap post-emit check already exists and is opt-in: `CompileOptions.validate`
(#4420).** It runs `validateEmittedBinary` over the bytes, flips `success` to
`false` and pushes an error-severity `CompileError` carrying the engine's detail
string, while still returning the binary so the caller can dump it. Its doc
comment describes precisely this failure mode — "`success` alone means 'codegen
ran to completion', NOT 'the bytes are a module'".

So the silent-success half is **already solved mechanically and unsolved by
default**: nothing in the equivalence lane, the npm-compat lane or the CLI's own
path sets it (the CLI runs its own post-optimize check instead, #3338, so it
would double-report). #4774 was found by a human writing an instantiate by hand.
That gap is worth its own issue — *which internal lanes should default
`validate: true`, and what does the engine decode cost per compile* — and is
deliberately NOT changed here: turning it on for a lane is a decision about that
lane's budget, not a codegen fix, and this PR's bar was "no byte changes outside
the defect class".
