---
id: 4774
title: "invalid module: mixed boolean/number prototype method + string concat emits a binary WebAssembly.compile rejects"
status: ready
sprint: current
created: 2026-08-27
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
related: [4406, 4414, 3754]
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
