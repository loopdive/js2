---
id: 3642
title: "Instance member value-read of a builtin prototype method reads as null — UNCONDITIONAL on standalone, SHAPE-DEPENDENT on host (`var a: any[]` and cast-at-use)"
status: ready
sprint: current
created: 2026-07-26
priority: high
horizon: m
feasibility: hard
task_type: bug
area: codegen
language_feature: function-dispatch
goal: core-semantics
related: [3638, 3571, 3603, 2984, 2773]
origin: "measured while fixing #3638 (opus-loop-c, 2026-07-25)"
---

# Instance member value-read of a builtin method is `null`

> **RESOLVED 2026-07-26 — two harnesses now agree exactly.** This issue was
> filed as an unqualified "BOTH lanes" claim; opus-loop-a measured the host half
> the other way; both of us ran positive controls. The variable turned out to be
> neither lane nor compile mode but the **declaration shape of the receiver**.
> Settled by running loop-a's repro verbatim under a corrected host import
> object — every row matches its numbers.
>
> - **Standalone: UNCONDITIONAL.** `a.fill` reads null in every shape tried.
> - **Host: REAL but SHAPE-DEPENDENT.** `var a: any[]` (and an `as any`
>   cast at the use site) read null; `const a: any` and untyped shapes are fine.
>
> So the original "BOTH lanes" headline was an **overstatement, not an error** —
> and my host harness *was* broken, yet the finding survived the fix. Both facts
> are recorded below because each is a separate lesson.

## Measured (2026-07-25, `upstream/main`)

> **The `host` column below is the CONTESTED one** — it comes from the harness
> whose own first positive control failed on host. Read the standalone column as
> the finding; read the host column only alongside "Reconciliation".

Same source, same harness, only the compile target differs:

| expression                          | standalone | host  |
| ----------------------------------- | ---------- | ----- |
| `var a=[1]; var f=a.fill; f ? 1 : 0`   | **0**      | **0** |
| `… (f === null \|\| f === undefined)`  | **1**      | **1** |
| `var f=Array.prototype.fill; f ? 1:0`  | 1          | 1     |
| `var a=[1]; a.fill === Array.prototype.fill` | 0    | 0     |
| `var a=[1,2]; a.fill(9); a[0]` (direct call) | 9    | 9     |

So, **on standalone**: the **direct call** `a.fill(9)` works, and the
`.prototype` **value read** works — but the **instance value read** `a.fill` is
null, and
`a.fill !== Array.prototype.fill` where §23.1.3 requires identity (an instance
has no own `fill`; the read must reach `Array.prototype.fill` through the
prototype chain and yield the same function object).

## Why it matters beyond one method

Any idiom shaped `<instance>.<method>.call(…)` / `.apply(…)` / `.bind(…)` is
built on this. That includes the reflective-call family (#3571, #3603 S1) and
ordinary user code (`var m = arr.map; m.call(arr, f)`).

It also caused a **trap** until #3638: the reflective `.call` lowering cast that
null receiver unconditionally, producing an uncatchable `illegal cast`. #3638
compensated **at the call site** by resolving the instance spelling to the same
singleton the `.prototype` spelling reads. **That is a compensation, not a fix
— this issue is the fix.** With it closed, #3638's `isInstanceMemberProtoRead`
special case can be reconsidered, and its pinned KNOWN GAP
(`var f = [].fill; f.call(o, 1)` still traps) closes for free, because the
identifier would then hold a real function value.

## Where it is

`tryCompileStandaloneBuiltinProtoMemberRead`
(`src/codegen/builtin-value-read.ts`) requires the base to be literally
`<Ident>.prototype`:

```ts
if (!ts.isPropertyAccessExpression(inner)) return undefined;
if (inner.name.text !== "prototype") return undefined;
```

There is no instance-receiver counterpart, so the read falls through to the
dynamic member path (`__extern_get(vec, "fill")`), which has no entry for a
prototype method on a vec receiver and yields null. **This locates the
STANDALONE defect only.** Whether the host lane has any counterpart is exactly
what is contested — do not design a shared fix off this paragraph.

## Acceptance criteria

- `var a=[1]; a.fill` is a callable function value on **standalone** (add a
  host arm only if the host claim survives the shared repro).
- `a.fill === Array.prototype.fill` (§23.1.3 identity — the singleton, not a
  fresh wrapper per read; `pushBuiltinFnSingletonValueInstrs` is the existing
  mechanism, cf. #2175 V2-S2).
- `var f = arr.map; f.call(arr, fn)` works.
- The #3638 KNOWN-GAP test flips (it is written to fail loudly when this lands).

## Method notes for whoever takes this

- **Assert identity, not truthiness.** "It returns something callable" is the
  weaker claim and would be satisfied by a fresh `struct.new` per read, which
  breaks `===` and was already rejected once (#2175 V2-S2).
- **Do NOT verify with a `typeof x === "function"` string compare on
  standalone** — dynamic-string `===` false-positives there (measured; see the
  #2984 handoff). Use a numeric discriminant.
- The host lane must be measured separately, not assumed to share the cause.

---

## Reconciliation — the host half is contested, and my harness is the suspect

Two agents measured the same fact with positive controls and disagreed, so one
harness is lying. Recording the state honestly rather than defending the
original claim.

### What I re-measured (4-mode matrix, stock `upstream/main`)

Built specifically to test the hypothesis that the disagreement was a
JS-mode-vs-TS-mode artifact. **That hypothesis is dead** — all four modes agree:

| probe                                   | host TS | host JS | sa TS | sa JS |
| --------------------------------------- | ------- | ------- | ----- | ----- |
| `a.fill === null \|\| === undefined`    | 1       | 1       | 1     | 1     |
| `a.fill ? 1 : 0` (truthiness, not `===`) | 0       | 0       | 0     | 0     |
| `a.fill.call(a,9)` on `[1,1]`           | THROW `Cannot read properties of null (reading 'call')` | same | illegal cast | illegal cast |
| `Array.prototype.fill.call(a,9)`        | **18**  | **18**  | **18** | **18** |

### Why I do not trust my own host rows

**My first positive control FAILED on host.** `export function test(){return 7;}`
threw `WebAssembly.instantiate(): Import #0 "string…"` on the host lane while
passing on standalone. Two later controls passed on host (`a[0]+a[1]` → 9,
direct `a.fill(9)` → 18) and I routed around the failure. That was wrong: a
failing control says the **host instantiation path used here**
(`compile()` + `WebAssembly.instantiate(binary, r.importObject)` + `__setExports`)
does **not** supply a complete host import object. Host-lane probes need the real
import object via `runTest262File`.

**The distinction that matters, and that this issue exists to record:** a
positive control proves the detector **FIRES**. It does not prove the **CHANNEL
carries the value faithfully**. Those are different guarantees. "Reads as null on
host" is precisely the artifact a thin host import object manufactures. Two
sibling traps found the same day on these exact channels: the standalone
string-return channel reads back `undefined` in a naive harness, and
`typeof X === "function"` evaluates false on host even when `typeof X` renders as
`"function"`.

### Contested in the other direction too

opus-loop-a reports `Array.prototype.fill.call(a, 9)` **throws on standalone**.
I measure **18** there, in all four modes, and separately `27` for the
three-element version in an earlier run. So that row may be its artifact the way
the host rows may be mine. Both halves need the same reconciliation: run one
agreed repro verbatim, in one process, with controls on both sides.

### Status of each claim

| claim                                                     | status                          |
| --------------------------------------------------------- | ------------------------------- |
| standalone: `a.fill` reads null                            | **CONFIRMED, unconditional**    |
| standalone: instance `.call` traps `illegal cast`          | **CONFIRMED** (fixed at the call site by #3638) |
| host: `a.fill` reads null                                  | **CONFIRMED for `var a: any[]` / cast-at-use; NOT for `const a: any` or untyped** |
| standalone: `Array.prototype.fill.call(a,9)` works         | measured 18 here; loop-a reports a throw — **CONTESTED** |

Until reconciled, treat this issue as **standalone-scoped**. The acceptance
criteria below still stand for standalone; re-add a host arm only if the host
claim survives a shared repro.

---

## RESOLUTION — shared repro, both harnesses agree

opus-loop-a's repro, run **verbatim** by opus-loop-c with a corrected host path
(`buildImports(r.imports, undefined, r.stringPool)` + `setExports`), numeric
channel only. Every row matches loop-a's independently-observed numbers.

| # | source                                                    | host                              | standalone                        |
| - | --------------------------------------------------------- | --------------------------------- | --------------------------------- |
| A | `const a: any = [1,1]; a.fill == null`                    | **0**                             | **1**                             |
| B | `var a: any[] = [1,1]; a.fill == null`                    | **1**                             | **1**                             |
| C | `const a: any = [1,1]; a.fill.call(a,9)`                  | **18** (works)                    | **2** (silent no-op)              |
| D | `var a: any[] = [1,1]; a.fill.call(a,9)`                  | **THREW** `Cannot read properties of null (reading 'call')` | **THREW** `illegal cast` |
| E | `const a: any; (Array.prototype.fill as any).call(a,9)`   | **18**                            | **THREW** non-stringifiable `WebAssembly.Exception` |
| F | `var a = [1,1]; Array.prototype.fill.call(a,9)` (untyped) | **18**                            | **18**                            |
| G | `var a = [1,1]; a.fill.call(a,9)` (untyped)               | **THREW** (same V8 message)       | **THREW** `illegal cast`          |
| — | `CTRL return 7`                                            | **7**                             | **7**                             |

### The three things this settles

1. **The variable is the declaration shape, not the lane and not the compile
   mode.** A 4-mode matrix (host/standalone × TS/JS) had already agreed with
   itself, which killed the mode hypothesis; the shape axis is what neither of
   us had varied.
2. **My earlier "contested" row is explained, and both of us were right.** Row E
   (`as any` cast at the use site) throws on standalone; row F (untyped, my
   original spelling) returns 18. Same method, same lane, different lowering —
   so `Array.prototype.fill.call` is *also* shape-dependent. Neither number was
   an artifact.
3. **`CTRL return 7` now passes on host** (it failed in my earlier harness).
   That confirms the harness bug I diagnosed — and note the punchline: with a
   correct import object the host null **still reproduces** for shapes B, D, G.
   The conclusion survived the broken harness.

### Two lessons, and they are different lessons

- **A positive control proves the detector FIRES; it does not prove the CHANNEL
  carries the value faithfully.** My control failed on host and I routed around
  it. Never do that: a failing control is a finding.
- **A control passing does not license an unqualified claim.** My host rows were
  reproducible and still the headline was wrong, because I varied lane and mode
  but never varied **shape**. Before writing "on BOTH lanes", ask which axes were
  actually varied — an unvaried axis is an assumption, not a measurement.

### Consequence for the fix

The acceptance criteria must hold **across shapes**, not just for the spelling a
test happens to use. Any fix should be verified against all of A–G on both
lanes; `const a: any` passing tells you nothing about `var a: any[]`.

Probe kept at `.tmp/shared-repro.mts`; loop-a's originals at
`.tmp/3603/shape-matrix.mts` and `.tmp/3603/proto-call-row.mts` in its worktree.
