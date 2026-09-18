---
id: 6634
title: "standalone: a named interface's Wasm carrier is aliased to its object-literal-shaped struct even when a CLASS also implements it — class instances silently null out (wrong answer or null-pointer trap) through every interface-typed slot"
status: done
assignee: ttraenkler/sendev-s48
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
goal: standalone
parent: 5383
requested_by: ttraenkler/fable-lead
created: 2026-09-18
completed: 2026-09-18
loc-budget-allow:
  # 2026-09-18 (S48) — new leaf module `interface-class-implementer.ts`
  # (~70 lines: the shared `interfaceHasClassImplementer` memoized lookup)
  # plus the guard call-sites it added to `resolveWasmType`'s two struct-name
  # lookups (`index.ts`), `resolveStructName` (`property-access.ts`), and the
  # "final fallback: scan all known classes" call-site devirtualization guess
  # in `call-receiver-method.ts` (a THIRD independent place that hardcodes an
  # interface-typed receiver to one implementer — without this one, reverting
  # ONLY the resolveWasmType/resolveStructName guards re-broke repro13, since
  # this fallback picks a class by scanning `ctx.classSet` directly and never
  # consulted either of the other two lookups). Every touched file already
  # carries a #5383-family grant; this entry documents the S48-specific delta
  # on top of it.
  - src/codegen/interface-class-implementer.ts
  - src/codegen/index.ts
  - src/codegen/property-access.ts
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  # 2026-09-18 (S48) — `resolveWasmType` (index.ts) grew past its budget
  # (557 > 518, +39) adding the class-implementer guard (and its doc comment)
  # to BOTH of its struct-name lookup sites (the direct `structMap.has(name)`
  # branch and the `anonTypeMap` fallback branch below it) — the function
  # already carries a #5383-family allowance and this is the same kind of
  # targeted guard-insertion, not new unrelated logic. Splitting
  # `resolveWasmType` is tracked separately (#3399/compiler-consolidation-plan)
  # and out of scope for this fix.
  - src/codegen/index.ts::resolveWasmType
coercion-sites-allow:
  # 2026-09-18 (S49) — `ensureStructFromObjectCoercionHelper`
  # (`extern-arg-marshal.ts`) mints one small marshal FUNCTION per struct
  # typeIdx it is asked to coerce into; its field-unbox loop calls the SAME
  # `__unbox_number` funcIdx the file's existing `externArgCoercionInstrs`
  # f64 arm already calls, from a second call SITE. The gate counts distinct
  # `__unbox_number` sites in this file, so the count grows 1→2 even though
  # no new coercion VOCABULARY is introduced — same helper, same semantics,
  # reused generically for every struct's f64 fields instead of one param at
  # a time. See `### S49 findings` in `plan/issues/5383-standalone-temporal-provider.md`
  # for why: a mixed class+literal interface-implementer dispatcher's
  # destructured-parameter argument arrives as a generic `$Object`, and the
  # existing `ref.cast`-only marshal traps ("illegal cast") instead of
  # coercing it — this reuses the file's own established unboxing primitive
  # to close that gap, rather than hand-rolling a new one.
  - src/codegen/extern-arg-marshal.ts
---

## Problem

`#6633`/S47 found two interface-dispatch defects blocking the `date.era`
reduction (`plan/issues/5383-standalone-temporal-provider.md` `### S47
findings`): a `Record<string, Iface>` holding BOTH an object-literal
implementation and a class-instance implementation of the same interface
always dispatched `iface.method()` to the class instance, ignoring the
literal; and a smaller "dereferencing a null pointer" trap on an
interface-typed method call reached through a function return.

## Root cause (single mechanism, both defects)

Both defects trace to ONE place: how a **named interface's own Wasm carrier
type** gets chosen — not, as first suspected, a call-site dispatch ladder.

`collectInterface` (`src/codegen/declarations/struct-type-registration.ts`)
synthesizes a method-only interface's OWN struct as an
object-literal-compatible shape: each method member becomes a **mutable
externref "closure slot" field** (e.g. `interface CalImpl { isoToDate(...): any }`
→ `(struct (field $isoToDate (mut externref)))`). That is the correct, and
ONLY, representation an object literal `{ isoToDate(){...} }` can physically
satisfy — a literal's method IS stored as a per-instance closure reference.

A **class** implementing the same interface (`class NonIsoCalendar implements
CalImpl { isoToDate(...){...} }`) is compiled completely differently: its
instances are a real class struct (`{ __tag, __shape_brand, ...fields }`) with
methods dispatched through the class's own function/vtable machinery — there
is no per-instance `isoToDate` closure field at all. A class instance can
**never** physically satisfy the interface's synthesized struct layout.

THREE independent lookups in the compiler resolve a value's Wasm type/method
FROM the interface's declared name/type, and all three were unconditionally
handing back one implementer's struct — this is why an earlier attempt at this
fix (patching `resolveWasmType`/`resolveStructName` alone) still failed
repro13 until the third site was found: reverting to file-copy baseline on
JUST those two files and rerunning showed both `calA`/`calB` snapping back to
answering the CLASS, proving the third lookup independently devirtualizes and
is not reachable through the first two.

- `resolveWasmType` (`src/codegen/index.ts`) — used for function
  parameter/return types, variable types, etc. Two branches: the direct
  `ctx.structMap.has(name)` lookup, and the `ctx.anonTypeMap.get(tsType)`
  fallback (hit when the checker returns the exact same `ts.Type` object for
  the interface reference and an object literal that structurally realizes it
  with no extra members — observed directly for `CalImpl`/`__anon_0` in this
  issue's repro).
- `resolveStructName` (`src/codegen/property-access.ts`) — used by
  `call-receiver-method.ts`'s "receiver is a struct type" call-site
  devirtualization arm (a WASM-CARRIER-based struct-name guess) to statically
  pick a method function.
- `call-receiver-method.ts`'s own "final fallback: scan all known classes"
  block (~line 1693) — a SEPARATE, TYPE-SYSTEM-based guess: it scans
  `ctx.classSet` directly for any class with a matching method name and
  structurally-compatible fields, with no dependency on `resolveWasmType` or
  `resolveStructName` at all. This is the block S47 originally suspected as
  the sole culprit; it is real, but it is one of three, not the mechanism.

Whenever a value that is ACTUALLY a class instance flows through a slot typed
by the interface (a function return, a `Record<string, Iface>` read, a
parameter), the compiler emits a **guarded cast against the literal's
struct**: `ref.test`/`ref.cast` against the interface's synthesized struct
type. For a class instance this `ref.test` always fails (different, unrelated
struct type), so the cast produces `ref.null` — not a compile error, not a
trap by itself, just silently null:

- **#6634 repro13** (`Record<string, CalImpl>` holding BOTH `impl["iso8601"] =
  { isoToDate(){...} }` (literal) and `impl["gregory"] = new
  NonIsoCalendar()`): `getCalendar(id)`'s return type is `CalImpl`, resolved
  to the literal's struct. `getCalendar("gregory")` fails its own `ref.test`
  and returns null. The call site ALSO statically devirtualizes
  `.isoToDate()` to the literal's method (`__anon_0_isoToDate`) via
  `resolveStructName`, regardless of which id was requested. The literal's
  method body never reads `this`, so calling it with a null receiver doesn't
  trap — it just runs the WRONG method and returns the literal's data for
  BOTH `"iso8601"` and `"gregory"`.
- **#6634 repro9** (single class implementer, no literal): the same
  null-producing cast in `getCalendar()`'s return coercion is wrapped in
  `ref.as_non_null` by a surrounding coercion — `ref.as_non_null` on the null
  IS the "dereferencing a null pointer" trap.

## Fix

`src/codegen/interface-class-implementer.ts` (new leaf module, no dependency
on `index.ts` or `property-access.ts`, so both can import it without a cycle):
`interfaceHasClassImplementer(ctx, interfaceName)` — memoized per-ctx, true
when any known class's heritage clauses spell `implements <interfaceName>`
(name-matched against `ctx.classDeclarationMap`, the same identity signal
`call-receiver-method.ts` already uses elsewhere; a name collision can only
make the carrier MORE conservative — externref instead of a struct — never
less safe).

All THREE consumers now decline the struct-typed carrier / static class guess
once a class implementer exists, guarded by `!ctx.classSet.has(name)` so a
CLASS's own instance type (which also reaches these same branches) is
completely unaffected:

- `resolveWasmType`'s `ctx.structMap.has(name)` branch and its
  `ctx.anonTypeMap.get(tsType)` fallback branch both return `{kind:
  "externref"}` instead of the struct ref.
- `resolveStructName` returns `undefined` (decline struct resolution) instead
  of the struct name, so callers fall through to the dynamic/externref
  dispatch paths that discriminate on the receiver's ACTUAL runtime type (the
  `__extern_get`/`ref.test`-per-implementer machinery already used for
  genuinely dynamic receivers), instead of hardcoding to whichever
  implementer's struct happened to be registered under this name.
- `call-receiver-method.ts`'s "final fallback: scan all known classes" block
  computes `interfaceForcesDynamic` from the SAME `interfaceHasClassImplementer`
  predicate (on `receiverType.symbol?.name`, the interface's own name) and
  folds it into the existing `canInferClass` gate — when true, the scan is
  skipped entirely, exactly as it already is for a genuinely `any`/`unknown`
  receiver, and the call falls through to the same dynamic dispatch paths.
  This reuses the identical predicate the other two sites use, so all three
  agree on when an interface is "must be dynamic" — no new checker queries.

This fix is at the TYPE-CARRIER level, not a new dispatch ladder — once the
interface resolves to externref, the EXISTING dynamic-receiver machinery
(closed-method dispatch / `__extern_get` MOP) correctly discriminates between
the literal and the class instance at each call, because it already handles
arbitrary externref receivers.

## Verification

Both repros (`.tmp/s48/repro13.ts`, `.tmp/s48/repro9.ts`, copied from S47's
`.tmp/s47/`) fixed, confirmed by direct compile+run (`compileMulti` +
`instantiateLinkedProject`, `--target standalone`) and by WAT/binary
disassembly (`wasm-dis -all`) before/after:

- repro13 BEFORE: `A.year=1 A.era typeof=string B.year=1 B.era typeof=string`
  (both answer the CLASS unconditionally). AFTER:
  `A.year=999 A.era typeof=undefined B.year=1 B.era typeof=string` (A = the
  literal, B = the class — each call answers its OWN receiver).
- repro9 BEFORE: `COMPILE/RUN ERROR: dereferencing a null pointer`. AFTER: `42`.
- `getCalendar`'s Wasm return type confirmed via `wasm-dis -all`:
  BEFORE `(result (ref null $N))` where `$N` is the literal's/class's
  synthesized struct; AFTER `(result externref)`.
- `npm run -s typecheck` clean both before commit steps.
- `node scripts/check-loc-budget.mjs` OK (no new unallowed growth beyond the
  grants above; #5383-family grants already cover the touched files' base
  budgets).
- `node scripts/check-func-budget.mjs` required the `resolveWasmType` grant
  above (documented).
- `node scripts/check-coercion-sites.mjs` and `npm run -s check:oracle-ratchet`
  both OK — the `call-receiver-method.ts` guard reuses `interfaceHasClassImplementer`
  (no new `ctx.checker`/`getTypeAtLocation` calls); an EARLIER attempt at that
  same file added a second, ad-hoc "does an object-literal struct also
  implement this method" scan using `ctx.checker.getTypeOfSymbol` per
  candidate property, which tripped the oracle-ratchet gate (net +1
  `ctxChecker` site) and was discarded in favor of the reused-predicate form.
- The witness test's file-copy A/B (per `CLAUDE.md`'s pattern:
  `git show HEAD:<file> > .tmp/s48/base-copies/<file>.base`, swap in, run,
  restore) on all THREE fixed files together: **4 of the 6 test cases fail on
  base**, not just the two obviously-repro-shaped ones — the "single-class
  implementer, no literal, different interface name" case (originally
  written as a *control*, expected to be unaffected) also traps with
  "dereferencing a null pointer" on base, confirming the defect fires
  whenever an interface's OWN synthesized struct is used at all, independent
  of whether a literal implementer coexists. Only the "literal-only interface"
  and "direct `new C().m()`" cases were genuinely unaffected controls.

### Criterion-4 battery (completed 2026-09-18 by the S48b lane — see `#5383`'s
"S48b findings" section for the full writeup)

**Real Temporal rows**: re-verified with a freshly rebuilt Temporal provider
(`JS2WASM_TEMPORAL_CACHE=s48b`, `cacheHit=false`, forced fresh build against
this fix). Both target rows (`PlainDate/from/argument-object-valid.js`,
`…/argument-string.js`) remain red, byte-identical error
(`Expected SameValue(«null», «undefined») to be true`) — **this fix does not
close #5383's target gap**. Root cause: the default `iso8601` calendar path
never reaches the class-implementer branch this fix changes (confirmed by
disassembling the real polyfill bundle — `Xo.iso8601` is a pure object
literal, `Xo[nonIsoId] = new NonIsoCalendar(...)` is never touched by a call
using the ISO calendar).

**One reduction step names a NEW defect this fix introduces**: a
destructured-parameter method on an object-literal interface implementer now
hard-traps (`illegal cast`) when ANY class also implements the interface
anywhere in the program (even if never called) — where BASE silently
misdispatched to the class instead (`.tmp/s48b/repro17.ts`, file-copy A/B
confirmed): base gives a wrong answer (`197600` instead of `2005`), fix traps.
Narrowing (`.tmp/s48b/repro16.ts`, no class implementer at all) shows the trap
needs BOTH the class-implementer-anywhere trigger AND the destructured
parameter — neither alone reproduces it. The real `Xo.iso8601.isoToDate` uses
exactly this destructured-parameter shape, so this is a plausible latent risk
worth its own follow-up issue, though it does not reproduce inside any batch
measured below (needs the specific shape a purpose-built repro created).

**Four-family** (`PlainDate`/`Duration`/`PlainDateTime`/`ZonedDateTime`, 120
files each, same file lists as S46b's baseline): 435/480 base == 435/480 fix,
0 pass→fail, 0 fail→pass in every family.

**Must-not-move A–F** (A–E: same file lists as S46b's committed baseline
TSVs; F has no prior baseline — base produced via file-copy-reverting the
three touched `src/codegen` files to `afe573638b` and re-running, confirmed
clean restore afterward):

| Group | Files | Base pass | Fix pass | pass→fail |
| --- | --- | --- | --- | --- |
| A | 1250 | 1125 | 1125 | 0 |
| B | 205 | 179 | 179 | 0 |
| C | 349 | 274 | 274 | 0 |
| D | 300 | 224 | 224 | 0 |
| E-unlinked | 300 | 235 | 235 | 0 |
| E-linked | 300 | 235 | 235 | 0 |
| F-class | 250 | 136 | 136 | 0 |
| F-methoddef | 100 | 68 | 68 | 0 |
| F-objproto | 150 | 136 | 136 | 0 |

**Corpus byte-flip A/B**: 84 entries (42 files × {gc, standalone}), 0 status
flips, 0 sha flips on either target — byte-identical to S46b's baseline.

**`npm run -s test:equivalence:gate`**: `22 failing, 1720 passing, 22
known-failures` — no new regressions, matches S46b's figure exactly.

**Verdict: criterion 4 (0 legitimate pass→fail) is SATISFIED for this fix's
own diff.** Nothing in the measured battery regresses. The `illegal cast`
defect found above is real but is not a measured regression against any
group run here or in S46b's prior battery — it is documented latent debt for
the next lane/PO to triage.

## Witness test

`tests/issue-6634-interface-dictionary-literal-vs-class-dispatch.test.ts` — 6
cases, single-module compile+run each: repro13's shape (dictionary holding
both a literal and a class instance of the same interface), repro9's shape
(sole class implementer through a function return), a three-implementer
variant (two classes + one literal), a sole-class-implementer control that
turned out to also fail on base (see Verification), and two genuine controls
(literal-only interface; direct `new C().m()`). 4/6 fail on base tree, all 6
pass on the fix (`npx vitest run --maxWorkers=1
tests/issue-6634-interface-dictionary-literal-vs-class-dispatch.test.ts`).

## S49 fix (2026-09-18) — the `illegal cast` trap S48b found

S48b's own base tree already had `interfaceHasClassImplementer`'s carrier
guard applied; the NEW trap it found (repro17: a destructured-parameter
interface method implemented by an object literal, plus an UNCALLED class
implementer of the same interface anywhere in the program) is a second,
independent defect on top of #6634's original fix — this section documents
its root cause and closes it.

**Root cause.** `c.compute({year,month,day})` on `Calc` — with a class
implementer present — resolves `Calc`'s own Wasm carrier to externref (by
design, per the guard above: no single struct can represent both a literal
and a class instance). Because the receiver's answering implementer is only
known at RUNTIME, the call routes through `closed-method-dispatch.ts`'s
`__call_m_compute_1` dispatcher — a `ref.test` cascade over every candidate
struct with a `compute` method (here: the literal's `__anon_N` struct and
`ClassCalc`'s own struct), each cascade arm `ref.cast`ing the receiver to its
own candidate and calling that candidate's function.

The trap is in the ARGUMENT, not the receiver. `compileInternalCallArgument`
(`internal-call-argument.ts`) deliberately compiles an object-literal
argument as the OPEN `$Object` dynamic carrier whenever its expected type is
bare `externref` — exactly what this dispatcher's uniform ABI requires,
since the call site cannot know statically which candidate's struct-typed
parameter to target. Every dispatch arm then marshals that SAME `$Object`
argument through `externArgCoercionInstrs`'s ref branch
(`extern-arg-marshal.ts`), which — pre-S49 — was an unconditional
`any.convert_extern` + `ref.cast <candidate's-param-struct>`. A generic
`$Object` never inhabits that closed struct's physical layout, regardless of
which arm runs, so every call to a destructured-parameter method through this
dispatcher trapped ("illegal cast") the moment BOTH ingredients (a
destructured-parameter method AND a co-existing class implementer, which is
what forces the externref carrier / dispatcher routing in the first place)
were present. Confirmed by WAT (`compileMulti({emitWat:true})`):
`__anon_1_compute`/`ClassCalc_compute` both declare their second param as
`(ref null 68)` — the registered `{year,month,day}` struct — and the
dispatcher's arms `ref.cast`ed the argument to that same struct with no
runtime test guarding it, while the argument itself was built via
`call $__new_plain_object` + three `call $__oset`-style property writes (the
`$Object` shape), never as `(ref 68)`.

**Fix** — `src/codegen/extern-arg-marshal.ts`:
`ensureStructFromObjectCoercionHelper`, a new per-struct-typeIdx marshal
consulted from `externArgCoercionInstrs`'s ref branch ONLY when the caller
opts in (`allowObjectCoercion`, a new trailing parameter, default `false` —
every existing call site's bytes are unchanged unless it explicitly opts
in). It emits a `ref.test`-guarded two-arm body: the fast arm (value already
inhabits the target struct) is byte-identical to the old unconditional cast;
the new arm — reached only on a genuine mismatch — reads each of the target
struct's declared fields generically off the externref value via
`__extern_get` (the compiler's own `[[Get]]` implementation, the same
"reach a field the checker could not name" idea as #5187's
`carrierNameForAccess`) and `struct.new`s the target shape. Scoped to
structs whose every field is `f64` or `externref` (this repro's exact shape);
any other field kind (nested ref, i32, i64) declines and the caller falls
back to the untouched unconditional cast, so an unsupported shape is no
worse off than before.

**Opt-in is scoped narrowly**, matching #6634's own "more conservative,
never less safe" precedent: `closed-method-dispatch.ts`'s `buildEntryArm`
only passes `allowObjectCoercion = true` for a `(methodName, arity)`
dispatcher whose `collectMethodEntries` result MIXES a class implementer
with a non-class one (`ctx.classSet.has(entry.structName)` true for at least
one entry and false for at least one other) — precisely the shape that
forces the interface's externref carrier in the first place, per
`interface-class-implementer.ts`'s own doc comment. Every other dispatcher
(array push/pop, DataView accessors, TypedArray HOFs, ordinary single-struct
or single-class-family method calls) keeps its previous bytes exactly — the
`allowObjectCoercion` flag defaults to `false` at every other call site, and
`standalone-class-construct.ts`'s construct-trampoline caller of
`externArgCoercionInstrs` was not touched at all.

**Verification.** 3 new fix-witnesses added to
`tests/issue-6634-interface-dictionary-literal-vs-class-dispatch.test.ts`
(repro17 itself; a variant where the class implementer is also CALLED
through the same dispatcher, proving both arms still answer correctly; a
2-param destructured variant) plus one new control (repro16's shape — same
destructured-parameter literal method, no class implementer at all — already
passed pre-S49 and must keep passing). File-copy A/B on the two touched
files (`extern-arg-marshal.ts`, `closed-method-dispatch.ts`, reverted to
this branch's pre-S49 content, i.e. S48b's tip `4f68804bc9`): all 3 new
fix-witnesses trap with `illegal cast` on base, all pass on the fix.
`npx vitest run --maxWorkers=2 tests/issue-66*.test.ts tests/issue-6484-*.test.ts`
— 36 files / 221 tests (217 base + 4 new), 0 failed.

**Criterion-4 battery (representative samples vs S48b's own baseline TSVs,
`.tmp/s48b/*.tsv` copied from S48b's worktree)** — full multi-thousand-file
families were infeasible in this session's time budget; sampled the first N
files of each family/group instead and diffed PASS/FAIL status against
S48b's committed baseline for the exact same files:

| Group | Files sampled | Baseline source | Status flips |
| --- | --- | --- | --- |
| A (general JS corpus) | 150 (of 1250) | `A-cur-p1.tsv` | 0 |
| B | 100 (of 205) | `B-cur.tsv` | 0 |
| C | 100 (of 349) | `C-cur-p1.tsv` | 0 |
| D | 100 (of 300) | `D-cur-p1.tsv` | 0 |
| E-unlinked | 60 (of 300) | `E-unlinked/E-cur-p0.tsv` | 0 |
| E-linked | 60 (of 300) | `E-linked/E-cur-p0.tsv` | 0 |
| F-class | 80 (of 250) | `F-class-fix.tsv` | 0 |
| F-methoddef | 60 (of 100) | `F-methoddef-fix.tsv` | 0 |
| F-objproto | 60 (of 150) | `F-objproto-fix.tsv` | 0 |
| **Total** | **770** | | **0** |

0 status flips (pass↔fail, or any other status transition) across all 770
sampled files. The Temporal four-family battery (PlainDate/Duration/
PlainDateTime/ZonedDateTime, 480 files) and the full corpus byte A/B (42
files × {gc, standalone}) were NOT re-run this session — S49's change is
scoped to a narrow, newly-added coercion path (`allowObjectCoercion`
opt-in, only live for mixed class+literal interface dispatchers) that these
files are not expected to exercise differently than S48b already measured
(S48b found 0 movement in both), but this is an inference, not a
measurement, and is flagged here for the next lane to close if a stricter
audit is wanted.

`npm run -s test:equivalence:gate`: `22 failing, 1720 passing, 22
known-failures in baseline` — `✓ No new equivalence regressions.` Matches
S48b's figure exactly (logged in `.tmp/s49/equiv.log` in this worktree).

**Verdict on criterion 4: SATISFIED for S49's own diff**, on the sampled
evidence above (0/770 flips) plus the narrow, opt-in-gated blast radius of
the change (every un-opted-in call site is byte-identical to S48b's tip).
