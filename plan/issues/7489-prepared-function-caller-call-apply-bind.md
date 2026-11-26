---
id: 7489
title: "Prepared path: a function's `caller`, and Function.prototype.call / apply / bind"
status: in-progress
created: 2026-11-26
updated: 2026-11-26
priority: high
feasibility: medium
reasoning_effort: high
horizon: m
sprint: current
goal: ir-full-coverage
parent: 7354
related: [7354]
---

# Prepared path: a function's `caller`, and Function.prototype.call / apply / bind

## Problem

On the Prepared whole-program path (`TEST262_COMPILER_PATH=ir`) a member read of
`caller`, `call`, `apply` or `bind` on a function value refuses
(`dynamic-member-access.ts`, "needs Function.prototype's properties"), so the
function holding it becomes an abort body and the test traps.

Lane S9's census (2026-11-26) counts 70 files; re-measured on main `c3b7be66`
with the committed census (see Measurement):

| abort reason (read on a function) | files |
|---|---:|
| `caller` | 38 |
| `apply` | 12 |
| `call` | 10 |
| `bind` | 10 |
| write `caller` (G1's by-name refusal) | 2 |

All 72 are `built-ins/Function/15.3.5.4_2-*gs`, `15.3.5-*gs` and
`language/statements/function/13.2-*`. Every call site has no argument past
`this`: `f.call(o)`, `f.apply()`, `f.apply(null)`, `f.bind(o)()`.

## What JavaScript answers

- **`f.caller`, strict / arrow / method / built-in `f`.** No own `caller`, so
  [[Get]] reaches Function.prototype's accessor, whose getter is
  %ThrowTypeError% (§10.2.4 AddRestrictedFunctionProperties): TypeError. A
  write calls the same thrower as setter: TypeError in sloppy and strict code.
- **`f.caller`, sloppy plain function.** Implementation-defined (the `caller`
  test262 feature); §17.1 forbids only a strict function as the value. V8 has
  an own non-writable, non-enumerable, non-configurable data property whose
  value is `null`, or the active sloppy caller.
- **`f.call(t, …a)`** calls `f` with `this` = `t`. **`f.apply(t, x)`**: `x`
  absent, `undefined` or `null` is no arguments; a primitive is a TypeError
  (CreateListFromArrayLike); an object is its array-like list.
- **`f.bind(t, …a)`** is a bound function exotic object (§10.4.1).

Checked per file: an own `caller` that is always `null` gives every one of the
72 tests its expected verdict (the `x.caller || x.caller.throwTypeError` tests
all expect the TypeError; the plain reads expect no throw). The difference from
node, `null` where V8 returns a sloppy caller, is the implementation-defined
part; no test in the corpus compares a `caller` read with a function.

### Where an always-`null` `caller` differs from node

It differs in one case only: the read runs while a **sloppy** function is the
active caller (V8 answers that function; this plan answers `null`). The value
there is implementation-defined, so `null` is a conforming answer, but it is
not node's. Checked on the corpus (main `c3b7be66`):

- No test262 file compares a `caller` read with a function (`sameValue`,
  `===`, `==`); the forbidden-extension tests only require it not to be a
  strict function (`notSameValue`), which `null` meets.
- In the 72 cluster files the case occurs (e.g. `15.3.5.4_2-87gs`: sloppy `f`
  calls `gNonStrict`), and each such test only requires that the read does not
  throw; verdict unaffected.

Whether this case can be refused by name instead: not at select. The caller of
a function value is a run-time fact (calls through dynamic values, `call`,
`apply`), so a sound refusal would have to refuse every `caller` read of a
function that some sloppy function might call, which is every sloppy-callee
read in the cluster. The plan therefore takes `null` and asks the reviewer to
confirm; if the reviewer rejects it, slice A shrinks to the strict half
(TypeError arms, 17 + 1 files) and the sloppy read keeps its by-name refusal.

## Claim

`claim-issue.mjs 7489 ttraenkler/c-lead --branch claude/s20-fn-members`: OK on
`origin/issue-assignments`.

## Plan review r1 (PRV-7489 on c10afb88) and how this plan answers it

| finding | answer |
|---|---|
| Q1 null `caller` | accepted; full slice A kept |
| B1 strictness | `ProgramDynamicContracts.codeStrictness` via the resolver's `closureCodeStrictness`; codegen's `irFunctionCodeStrictness` untouched (A.1) |
| B2 generators / async | excluded from the own `caller` by name, pinned (A.1, A.4) |
| B3 census | abort rows are in `scripts/ir-census/prepared-census.mts`; file lists committed under `plan/log/7489-census/`; exact commands below |
| R1 accessors | lead's decision: the realm's Function.prototype holds the `caller` / `arguments` accessor pair, get = set = %ThrowTypeError% (A.2) |
| R2 primitives | the primitive arm stays Object.prototype-only; `(5).call` is `undefined`, pinned (B.4) |
| R3 raw `thisArg` | safe by `dynamicCurrentThis` C2-D3; sloppy `f.call(undefined)` / `f.call(1)` reading `this` abort, pinned (B.3, B.4) |
| R4 `apply` order | IsCallable first: a non-callable receiver throws its TypeError before `argArray` is looked at (B.3) |
| R5 partial population | `o.bind` on an object with a function on its chain still traps after call/apply are seeded, pinned (B.4) |
| nit FLAGS | the new operand is a Boolean (i32), not the f64 FLAGS type (A.1) |
| nit "duplicate" | the unpopulated-keys change is a parameterisation; the duplicate removed is the positional `METHOD_IDS` slice (B.2) |

## Implementation Plan

Two slices, one PR each, A then B; `bind` (C) gets its own plan once A and B
have landed. Each keeps JS-environment and ordinary-pipeline bytes identical:
every change is on the Prepared native dynamic lane (`createsFunctionObjects`),
in the Prepared realm, or in Prepared-only legalization.

### Slice A: `caller` reads and writes (estimate 38 + 2 files)

1. **A sloppy plain function's own `caller`** — `js.object.init-function`.
   - `src/ir/function-object-lowering.ts` `emitFunctionObjectInit` gains a
     fifth operand, a Boolean `ownCaller`: true for a function declaration or
     expression that is neither a generator nor async (§17.1 names exactly
     these as the functions an implementation may extend) and whose code is
     not strict.
   - Strictness: the caller passes
     `resolver.closureCodeStrictness(fn).functionCodeStrict`, i.e.
     `ProgramDynamicContracts.codeStrictness` (`source-dynamic-contracts.ts`,
     fed by `src/compiler/prepared-code-strictness.ts`, which takes any
     `FunctionLikeDeclaration`). Both callers (`from-ast.ts` closure literal,
     `function-declaration-values.ts`) already hold the resolver. On the lane
     that creates function objects the resolver always answers; no answer is
     not a case on that lane.
   - `isConstructor` (bit for MakeConstructor) also counts `function*` and
     `async function` today, a pre-existing hole; both still refuse before
     they reach this site. The new operand excludes them by name regardless,
     and a pin holds the refusal (A.4).
   - `src/runtime/wasmgc/values/source-function-object-bodies.ts`: with
     `ownCaller`, define `caller` = `null` with descriptor word 0
     (non-writable, non-enumerable, non-configurable, V8's shape) through the
     body's existing `define` helper, after `name` and before `prototype`.
   - `src/ir/runtime/ordinary-object-callables.ts`: the declaration gains the
     BOOLEAN parameter.
2. **The realm's Function.prototype holds the accessor pair** (lead's decision
   on R1).
   - `src/runtime/wasmgc/values/builtin-function-bodies.ts`, the realm seed:
     after the bootstrap pair exists, define `caller` and `arguments` on
     %Function.prototype% as accessors whose getter and setter are the
     %ThrowTypeError% singleton, `{ enumerable: false, configurable: true }`
     (§10.2.4 AddRestrictedFunctionProperties), through the kernel's accessor
     define (the `defineAccessor` operand `builtin-function-property-bodies.ts`
     already takes). The catalog already
     lists both rows (`accessor("caller", throwTypeError, throwTypeError)`).
   - The kernel's [[Get]] / [[Set]] then answer every function value: a sloppy
     plain function's own `caller` (A.1), and for every other function the
     accessor, whose call of %ThrowTypeError% is the built-in call body's
     existing TypeError (`builtinTypeError` via `builtinFailure(d, 2)`); the
     implementation confirms the call reaches it through [[Get]]'s accessor
     path, else the slice stops and reports. The getter's identity is the
     realm's one %ThrowTypeError% (§10.2.4.1).
3. **The IR stops refusing `caller`** — `builtin-prototype-keys.ts`,
   `dynamic-member-access.ts`.
   - The function arm of a read and of a write becomes the realm's plain
     [[Get]] / [[Set]] for `caller` (the write's existing `putValue`: a sloppy
     write to the non-writable own `caller` is ignored, a strict one throws;
     the accessor's setter throws in both). No has-then-branch, no new helper.
   - `arguments` keeps a by-name refusal for reads and writes: a sloppy
     function's V8 `arguments` is the live arguments object (Session B), and
     no own property is installed for it, so the accessor's TypeError would be
     the wrong answer for a sloppy function. The refusal text names the reason
     ("a function's own `arguments` needs arguments objects").
   - `FUNCTION_PROTOTYPE_ACCESSOR_KEYS` stays the catalog's; the read's and the
     write's `missing` name only `arguments` from it.
4. **Pins** (`tests/issue-7489-function-caller.test.ts`), each failing on main:
   - a sloppy function's `caller` reads `null`, while it runs and after;
   - a sloppy write `g.caller = 1` is ignored, a strict one throws TypeError;
   - a strict function's `caller` read and write throw TypeError, from sloppy
     and from strict code; an arrow's and a method's read throw;
   - the thrown error is a TypeError the program can catch;
   - `f.arguments` read and write still refuse by name;
   - `function*` and `async function` values still refuse before reaching the
     own-`caller` site (pins the B2 exclusion);
   - JS-environment and ordinary-pipeline output of the same sources is
     byte-identical to main.

### Slice B: `Function.prototype.call` and `apply` (estimate +10 and +12 files)

P1's shape (`dynamic-prototype-methods.ts`), extended in place.

1. **Catalog** — `native-realm-catalog.ts`:
   `NATIVE_MEMBERS["Function.prototype"] = ["apply", "call"]`; both ids join
   `NATIVE_VALUE_INTRINSICS`. The realm seeds them on %Function.prototype% as
   P1 seeds its methods on %Object.prototype% (`builtin-function-bodies.ts`:
   the same define with the parent as an operand, not a second branch).
2. **One table of populated prototype methods** —
   - `native-realm-requirements.ts`: `METHOD_IDS` (today the positional slice
     `NATIVE_VALUE_INTRINSICS.slice(0, NATIVE_OBJECT_PROTOTYPE_METHODS.length)`)
     and `readsPrototypeMethod` read one catalog table of native prototype
     methods by parent. This removes the positional coupling, the duplicate.
   - `builtin-prototype-keys.ts`: the unpopulated-key sets of Object.prototype
     and Function.prototype take one parameterised helper over that table
     (a parameterisation, not a duplicate removal).
3. **The call** — `dynamic-prototype-methods.ts`: `RealmMethod` gains
   `Function.prototype.call` / `.apply`; `prototypeMethodOfCall` recognises them
   from the same table. When the value read is the realm's built-in (the
   existing `strict_eq` branch):
   - **`call`**: the dispatcher call `js.closure.call:<n>` with
     `[thisArg ?? undefined, receiver, …rest]`, the call `dynamicConstruct`
     already writes. IsCallable is the dispatcher's TypeError for a value that
     is no source closure; a built-in receiver (`hasOwnProperty.call(o, k)`) is
     the dispatcher's run-time abort, as for any built-in called through a
     value. A raw `thisArg` is safe because the callee binds `this` through
     `dynamicCurrentThis` (C2-D3): strict code takes it as is, sloppy code
     takes an object as is and aborts on `undefined`, `null` or a primitive
     (no global object or wrapper on the realm).
   - **`apply`**: first IsCallable of the receiver, a kind test (`holds` over
     `function`): not a function → TypeError ("Function.prototype.apply was
     called on …, which is not a function") whatever `argArray` is (R4). Then
     `argArray`: absent → the 0-argument call; otherwise a kind chain:
     `undefined` / `null` → the 0-argument call; a primitive → TypeError
     ("CreateListFromArrayLike called on non-object"); an object or a function
     → the run-time abort (array-likes are Session B's arrays). A function
     receiver that is a built-in is again the dispatcher's abort.
4. **Pins** (`tests/issue-7489-function-call-apply.test.ts`), each failing on
   main unless marked:
   - `f.call(o)`, `f.apply(o)`, `f.apply(o, null)` bind `this`;
     `f.call(o, 1, 2)` passes arguments; a strict `f.call()` sees `undefined`;
   - sloppy `f.call(undefined)` and `f.call(1)` where `f` reads `this` abort
     (R3);
   - `f.apply(o, 1)` throws TypeError; `f.apply(o, [1])` aborts (expected
     limit);
   - `o.apply = f.apply; o.apply(t, {})` with a non-callable `o` throws
     TypeError, not the abort (R4);
   - an own `call` property and a function whose `call` was overwritten take
     the dispatcher; a detached `var c = f.call; c()` aborts;
   - `(5).call` and `"s".apply` read `undefined` (R2; passes on main, pins
     that seeding Function.prototype does not leak to primitives);
   - an object whose chain holds a function (`F.prototype = g; new F().bind`)
     still traps after Function.prototype is seeded with call/apply (R5): the
     realm's Function.prototype stays marked incompletely populated;
   - JS-environment and ordinary-pipeline bytes unchanged.

### Reuse and duplicates removed

- Reuses: `js.object.init-function` and its `define` helper; the realm seed and
  the %ThrowTypeError% singleton; the kernel's accessor define;
  `codeStrictness`; P1's built-in identity branch; `dynamicConstruct`'s
  dispatcher call; `holds`; `typeErrorThen`.
- Removes: the positional `METHOD_IDS` slice (B.2), and G1's special-cased
  `caller` refusal in the write's `missing` (the realm answers it now).

### Acceptance

- Correctness: each slice's pins fail on main (but the R2 pin) and pass; the
  committed census of `plan/log/7489-census/candidates.txt` moves no file from
  pass to fail, and the pass count of `cluster.txt` is reported with the main
  sha (estimate above, measured in the PR).
- Bytes: JS-environment and ordinary-pipeline output byte-identical to main on
  the equivalence corpus.
- Quality: no new module; each arm beside its siblings in the same shape; no
  function past its budget without a grant the review accepts; adversarial
  review verdict in the PR body.

## Measurement

Main `c3b7be66`. Commands (from the repository root, test262 submodule
checked out):

```bash
npx tsx scripts/ir-census/prepared-census.mts --files plan/log/7489-census/candidates.txt \
  --out .tmp/7489.jsonl --harness real --jobs 4
node -e '
const rows = require("fs").readFileSync(".tmp/7489.jsonl", "utf8").trim().split("\n").map(JSON.parse);
const re = /member (read|write) .(caller|apply|call|bind). of a function/;
const hit = rows.filter((r) => r.status === "fail" && re.test(r.abort ?? ""));
const by = {};
for (const r of hit) { const [, op, key] = r.abort.match(re); by[op + " " + key] = (by[op + " " + key] ?? 0) + 1; }
console.log(hit.length, by);'
```

- `candidates.txt`: the 552 ES5 files (`scripts/ir-census/es5-files.mts`)
  whose source contains `.caller`, `.apply`, `.call` or `.bind`.
- Result: 1 pass, 142 fail, 409 compile error. 72 fails trap in an abort body
  with this issue's refusal (`cluster.txt`): read `caller` 38, `apply` 12,
  `call` 10, `bind` 10, write `caller` 2.
- Estimate of the ceiling (not a pass count): of the 72, those whose other
  abort bodies are only the harness's (`formatIdentityFreeValue`, the computed
  key in `compareArray`, `Array` in the harness closures): `caller` only 38,
  `call`+`caller` 8, `call` 2, `apply`+`caller` 8, `apply` 4,
  `bind`+`caller` 8, `bind` 2, write `caller` 2.
- The reviewer's 132-file "family" set (89 fail, 41 CE, 2 pass) is a
  different selection; the 72 are the fails of `candidates.txt` whose trap
  frame is this refusal.

## Slice A result (2026-11-26)

Branch `claude/s20-fn-members`, measured against main `c3b7be66`.

- **Census** (the Measurement commands, `candidates.txt`): 1 pass / 142 fail /
  409 CE before, 43 pass / 100 fail / 409 CE after: 42 files fail → pass,
  none pass → fail. 40 of the 42 are in `cluster.txt` (all 38 `caller` reads and
  both `caller` writes; the estimate held). The 32 cluster files left fail on
  `call` 10, `apply` 12, `bind` 10, slice B's and C's.
- **Bytes**: ordinary-pipeline output (JS target and `--target standalone`) of
  the 13 playground examples and the 72 cluster files, 170 compiles, hashes to
  the same digest on the branch and on main.
- **Tests**: `tests/issue-7489-function-caller.test.ts` (11; the node-agreement
  and `arguments` pins fail on main, the generator / async pins pass there and
  hold the §17.1 exclusion); G1's `caller`-write pin moved to `arguments`.
  `tests/issue-7354-*`, `issue-7106-function-object*`, `issue-3518-native-realm*`:
  2167 pass; the 4 failures (`issue-3518-native-realm-object-layouts` ×4 …
  `issue-7354-o-objects` "refuses what the later steps build") fail identically
  on main `c3b7be66`.
- **One step beyond the plan**: the kernel's [[Set]] trapped on any setter when
  the program holds no source accessor (`source-object-bodies.ts`, "a setter
  call traps"), so `strictFn.caller = 1` hit `unreachable`. It now calls a
  built-in setter the way [[Get]] already called a built-in getter: the
  getter's helper became `builtinAccessorCall`, shared by both halves, and a
  setter that is not a built-in still traps.
- **Where the plan's A.2 landed**: no Function.prototype-specific seeding code.
  `familyProperties` (`native-realm-families.ts`) seeds every catalog property
  of a held row whose intrinsics the realm holds, accessors included, so
  %Function.prototype%'s `caller` / `arguments` come from its catalog rows; the
  Error family rows reference only held intrinsics, so their seeding is
  unchanged.

## Slice A review r1 (RV7449 on 4a1d7bd0) and fixes

- **B1, the generator / async exclusion was unpinned.** Both programs refuse
  before `js.object.init-function` for unrelated reasons, so removing the
  exclusion left every test green. `tests/issue-7489-function-caller.test.ts`
  now drives `emitFunctionObjectInit` directly with a recording builder and
  pins its own-caller operand: sloppy declaration true; strict, `function*`
  and `async function` false. The two program-level pins stay, reworded to
  claim only that those programs still refuse.
- **A missing strictness answer gave a wrong value.** It now refuses by name
  ("a function object's own caller needs its code's strictness",
  `functionCodeStrict` in `function-object-lowering.ts`). The resolver type is
  `Pick<IrFromAstResolver, "closureCodeStrictness">`, dropping the inline copy
  of `CodeStrictness`. Production always answers (`compiler.ts` passes
  `preparedCodeStrictness`); three test fixtures that built a Prepared input
  without it now pass the same function (`typed-program-fixtures.ts`,
  `native-getter-invocation-fixture.ts`, one inline input in
  `issue-3518-closure-parameter-projections.test.ts`). Making the field
  required on `IrProgramSourceInput` was tried and rejected: 92 fixture call
  sites build that input.
- **Every Prepared program grew by the two accessor defines (+66 B).** The
  accessors are now seeded only where the program can reach them:
  `restrictedFunctionAccessors` (`native-realm-requirements.ts`) is true where
  some `js.object.get` / `set` / `has` use has the key `caller` or `arguments`
  or a key not known at compile time. Nothing else reaches them, since no
  Prepared program obtains %Function.prototype%.
  - `var o = { a: 1 }; var b = o.a;` is now 24003 B, as on main.
  - A program with a function value grows 29 B: the own-`caller` define in
    the `js.object.init-function` body.
- **Nits**: `includes` for the bootstrap test, the [[Set]] body's local is
  named `vector`, and the over-long comment is wrapped.
- **Re-measured**: the census of `candidates.txt` is unchanged (43 / 100 /
  409, zero row differences). The 87 test files that use the Prepared fixtures
  fail exactly main's set (93 tests, same names).

## Slice B result (2026-11-26)

Branch `claude/s20-fn-call-apply` (stacked on slice A), measured against main
`c3b7be66`.

- **Census** (`candidates.txt`): slice A's 43 pass / 100 fail / 409 CE becomes
  92 pass / 94 fail / 366 CE: +49 passes over slice A (27 CE → pass, 22 fail →
  pass), none pass → fail. Cluster: 60 of 72 pass (slice B's 22 `call` /
  `apply` files: 20 pass). The 2 left, `10.4.3-1-85-s` and `-85gs`, call a
  sloppy `f` through `f.apply()` with no `this`, which needs the global object:
  the C2-D3 run-time abort. The other 10 are `bind` (slice C).
- 16 files go from compile error to a run-time fail. 10 trap in the kind abort
  `js.value.unsupported` (`10.4.3-1-1…4-s`, `14.1-3…7,17-s`): after the strict
  half passes, a sloppy function is called through `call` with `undefined` or a
  primitive `this` (`bar.call(1)` needs a Number wrapper), the same C2-D3 abort
  (read on `10.4.3-1-1-s`, `10.4.3-1-4-s`, `14.1-3-s`, `14.1-17-s`). The other 6
  reach an abort body refused for another reason (`for-in` tail ×2,
  `instanceof Boolean` / `String` / `Number`, an empty statement before a
  tail). None answers a wrong value.
- **Bytes**: the 170 ordinary-pipeline compiles hash to main's digest.
- **Tests**: `tests/issue-7489-function-call-apply.test.ts` (10). The primitive
  pin (R2, `(5).call` is `undefined`) passes on slice A too and holds that
  seeding Function.prototype does not reach primitives; the others fail there.
  Two F1/F1b pins of "`call` refuses" moved to `bind`.
- **Shape**: `NATIVE_PROTOTYPE_METHODS` (catalog) is the one table of populated
  prototype methods; `native-realm-requirements.ts` holds a prototype's methods
  from it, replacing the positional `METHOD_IDS` slice. The realm seeds
  `call` / `apply` on Function.prototype through slice A's catalog rule
  (`familyProperties`); only Object.prototype's methods keep their entry's own
  seeding (`object-prototype-method`). `builtin-prototype-keys.ts`
  derives both prototypes' unpopulated keys with one helper.

## Slice C plan: `bind` (2026-11-26, r1)

Branch `claude/s20-fn-bind`, stacked on slice B (#7480).

### Plan review r0 (PRV-7489C on fd56edfd) and how this plan answers it

| finding | answer |
|---|---|
| 1 [[Prototype]] of a target that is not under %Function.prototype% (a NativeError constructor's is %Error%) | `js.object.bind` aborts at run time when the target's [[GetPrototypeOf]] is not %Function.prototype%; pinned (`TypeError.bind(null)`) (C.1) |
| 2 no `return_call` inside the invocation boundary | none: the trampoline calls `apply-vector` and returns its result (C.2) |
| 3 reuse the closure extension point | a bound function is a closure; one fixed lifted "bound trampoline" is one `NativeClosureMethodEntry`; no new dispatcher arm (C.2) |
| 4 §20.2.3.2 order and arithmetic | HasOwnProperty(`length`) → Get(`length`) → Get(`name`), f64 arithmetic; the concat helper is named (C.1) |
| 5 `bind(null)` keeps `null` | an absent `thisArg` is `undefined`; a given one, `null` included, is passed as is (C.3) |
| 6 yield | ≤ 29, an estimate; per-file reading below |
| 7 counts | corrected against `bind.txt` below |
| 8 one prologue for `init-function` and `bind`; the concat in `argument-vector-bodies.ts` | C.1, C.2 |
| C.5 | approved by the lead with the reviewer's conditions (a)–(d); C.5 below |

### Measured

The census of `candidates.txt` on slice B's head `38ef5af6` (main `1a726b3e`), using the Measurement commands, finds 30 files whose only blocker outside the harness is "member read 'bind' of a function" (`plan/log/7489-census/bind.txt`):

- 10 trap in an abort body: `15.3.5.4_2-70…73gs`, `-89…92gs`, `10.4.3-1-98(-s|gs)`.
- 20 refuse at compile:
  - `Function/prototype/bind/*`: 11;
  - `10.4.3-1-76…79(-s|gs)`: 8;
  - `15.3.5.4_2-97gs`: 1.

A compile error shows only its first gap.

Per-file reading, i.e. what each needs past `bind`:

| files | needs |
|---|---|
| `15.3.5.4_2-70…73gs`, `-89…92gs`, `-97gs` | a bound call (strict or sloppy target, `this` absent / `null` / `undefined` / object); slice A's `caller` |
| `10.4.3-1-76…79(-s|gs)` | a strict target sees the bound `this` as is (`undefined`, `null`, `undefined`, an object) |
| `10.4.3-1-98(-s|gs)` | a sloppy target bound to an object |
| `bind/15.3.4.5-2-16` | `bind()` with no arguments, result unused |
| `bind/15.3.4.5-8-1` | `typeof bf` is "function" |
| `bind/15.3.4.5-16-2` | a write to a bound function creates an own property (`hasOwnProperty`) |
| `bind/15.3.4.5-20-2`, `-20-3` | `bf.caller` read and write throw a TypeError (slice A's accessor) |
| `bind/15.3.4.5-21-2`, `-21-3`, `S15.3.4.5_A2` | `bf.arguments` read and write throw a TypeError: C.5 |
| `bind/S15.3.4.5_A1` | `bf.caller` read inside the target |
| `bind/S15.3.4.5_A4` | leading and actual arguments; the bound call never reads the target's `apply` |
| `bind/15.3.4.5-8-2` | **also** `Object.prototype.toString.call(bf)`: `toString` is not native, so it stays refused |

**Estimate: ≤ 29 files** (30 minus `8-2`). The measured count goes in the PR.

The 2 slice-B cluster files `10.4.3-1-85(-s|gs)` are not in this slice: a sloppy `f.apply()` with no `this` needs the global object (C2-D3), which is Session B's area.

### What JavaScript answers (§20.2.3.2, §10.4.1)

- `F.bind(thisArg, …args)`:
  1. IsCallable(F), else a TypeError.
  2. BoundFunctionCreate(F, thisArg, args): [[Prototype]] = F.[[GetPrototypeOf]]().
  3. HasOwnProperty(F, "length"). If true: Get(F, "length"). If it is a Number:
     - +∞ stays +∞;
     - −∞ gives 0;
     - otherwise ToIntegerOrInfinity, then max(0, L − args.length).
     Otherwise L is 0.
  4. Get(F, "name"). If it is not a String, it becomes "". `name` = "bound " + that name.
  5. `length` and `name` are non-writable, non-enumerable and configurable.
- [[Call]]: Call(target, boundThis, boundArgs ++ args). [[Construct]] exists only when the target is a constructor.
- A bound function owns no `prototype`, `caller` or `arguments`. Its `caller` / `arguments` reach Function.prototype's %ThrowTypeError% accessor.

### Implementation Plan

**C.1 Creation: `js.object.bind(target, thisArg, argsVector) -> externref`.**

- **Where.** An ordinary-object callable, beside `js.object.init-function`:
  - declaration in `src/ir/runtime/ordinary-object-callables.ts`;
  - binding in `native-source-objects.ts`;
  - body in a new `src/runtime/wasmgc/values/bound-function-bodies.ts`, classified in `scripts/compiler-boundaries.json` in the same commit by copying `source-function-object-bodies.ts`'s row.
- **The value.** A closure of one fixed capture layout (`createClosureCaptureType`):
  - field 0 is the bound trampoline's funcref (C.2), with closure arity 0;
  - the bag;
  - captures `target`, `boundThis` and `boundArgs` (the argument-vector type).

  Because it is a source-closure-shaped value:
  - every kind test answers "function" (`js.value.is_function` is a closure-root test);
  - the kernel's `match` reads its bag;
  - [[Get]] / [[Set]] / `hasOwnProperty` work on it (`16-2`, `20-*`).
- **The shared prologue (finding 8).** Allocating the null-prototype bag, `$bag` set, and the length/name seed become one helper, `buildFunctionObjectPrologue`, in `source-function-object-bodies.ts`. `init-function` and `bind` both call it. `init-function` keeps its tail (own `caller`, `prototype`).
- **[[Prototype]] (finding 1).**
  - A bound function's [[Prototype]] is the closure's: %Function.prototype%.
  - That is right only for a target whose [[GetPrototypeOf]] is %Function.prototype%. On Prepared, that holds for every source function, every Object.prototype / Function.prototype method, and %Error%.
  - It does not hold for a NativeError constructor, whose prototype is %Error%.
  - So `bind`'s first step after IsCallable compares the target's prototype (the kernel's `getPrototypeOf`) with the %Function.prototype% singleton and takes the run-time abort when they differ. A pin covers it: `TypeError.bind(null)` aborts.
- **`length` / `name` (finding 4)**, in this order, with the kernel's own roles:
  1. `has-own(target, "length")`. If true, [[Get]] of it. If the result is a Number, f64:
     - `+∞` stays;
     - `−∞` or NaN gives 0;
     - otherwise `f64.trunc`, then `max(0, L − n)`, which gives `+0` for `−0`.
  2. [[Get]] of `name`. If it is not a string, use `""`. Then concatenate "bound " with it.

  [[Get]] is the kernel's, which calls a source getter through F2's dispatcher. A program can redefine `length` with an accessor; its getter then runs, and may throw, at this step, as in the specification.

**C.2 Calling: one bound trampoline, one `NativeClosureMethodEntry` (findings 2, 3).**

- **The trampoline.** A fixed lifted function `(self) -> externref` in `bound-function-bodies.ts`:
  1. read `target`, `boundThis` and `boundArgs` from `self`;
  2. build `boundArgs ++ actual arguments` with the new `buildArgumentVectorConcat` in `argument-vector-bodies.ts`. With closure arity 0, every actual argument is in the dispatcher's extras vector and `argc`;
  3. return `apply-vector(target, boundThis, vector)`.

  It is a plain call, not `return_call`, so the invocation boundary's restore of `this` / `argc` / extras runs.
- **Registration.** `native-invocation.ts`'s `entries()` adds the trampoline's entry where the realm holds `bind`:
  - allocation type: the bound layout;
  - `closureArity` 0;
  - result: an externref value.

  Both dispatchers (`js.closure.call:<n>`, `apply-vector`) then reach it through their existing per-entry match. `closure-method-body.ts` and `closure-vector-apply-body.ts` are unchanged.
- **The receiver.** The receiver the dispatcher installs is ignored, as [[Call]] requires. A nested bound function recurses through `apply-vector`.

**C.3 The call site: P1's shape, the sibling of `call` / `apply`.**

- `bind` joins `NATIVE_FUNCTION_PROTOTYPE_METHODS`.
- `f.bind(…)` whose callee is the realm's built-in becomes:
  1. IsCallable of the receiver (`holds` over `function`), else `throwingArm`'s TypeError;
  2. then `js.object.bind(f, thisArg, vec(rest))`.
- **`thisArg` (finding 5).** An absent one is `undefined`. A given one is passed as is, so `bind(null)` keeps `null`.
- **Shared unpacking.** `call`, `apply` and `bind` share one unpacking of `instr.args` into receiver, `thisArg` and rest. Today `invoke` and `apply` each destructure by hand.

**C.4 What a bound function does not do yet: run-time abort.**

- `new bf(…)` and `x instanceof bf`: `dynamicConstruct` / `dynamicInstanceOf` add a bound test, a `ref.test` of the bound layout through `js.object.is-bound-function`, whose arm is the abort.
- [[Construct]] through the target is later work; no file in the estimate needs it.

**C.5 `arguments` on a function: run-time split (approved by the lead, conditions (a)–(d)).**

- **The predicate (b).** One predicate, `ownsSloppyCaller(value)`: `js.object.has-own(value, "caller")`. It is true exactly for slice A's own-caller rule (`plainFunction && !strict`, written only by `init-function`).
  - The same function is the definition the IR's read and write arms test.
  - A program that defines an own `caller` on a strict function makes it true too. That case takes the abort, which is conservative.
- **Read and write (a).** Both arms of an access to `arguments` on a function value become:
  - predicate true: the run-time abort, because a sloppy function's value is implementation-defined (V8: its live arguments object);
  - otherwise: the realm's [[Get]] / [[Set]], whose accessor throws the TypeError.

  The select-time refusal goes. Nothing is claimed and then withdrawn: the arm is chosen at run time, and the access is lowered in every case.
- **Slice A's text and pins (c).** The issue's slice A section and `tests/issue-7489-function-caller.test.ts`'s "refusals that stay" become: sloppy `f.arguments` read and write abort; strict and bound read and write throw a TypeError. That gives one pin per function kind admitted on Prepared: sloppy declaration, sloppy expression, strict declaration, bound. Arrows, methods, generators and async functions still refuse before this site, so the existing refusal pins cover them.
- (d) the lead's OK is given.

**C.6 Carried-over wording.** RV7449's optional point: "V8's shape" becomes "node 22's" in `function-object-lowering.ts` and `source-function-object-bodies.ts`.

### Reuse and duplication

- **Reuses:**
  - the closure capture layout and the `NativeClosureMethodEntry` extension point (no new dispatcher arm);
  - `apply-vector`;
  - the kernel's `has-own` / [[Get]] / `getPrototypeOf`;
  - the length/name seed;
  - P1/B's identity branch, `holds` and `throwingArm`.
- **Removes:**
  - the duplicate function-object prologue (`init-function` and `bind` share `buildFunctionObjectPrologue`);
  - the hand-written argument unpacking of `call` / `apply`.

### Bytes

- The bound layout, its trampoline entry and `js.object.bind` are emitted only where the realm holds %Function.prototype.bind% (a use reads `bind`).
- Other Prepared programs' bytes are unchanged.
- JS-environment and ordinary-pipeline output stay byte-identical (the 170-compile digest).

### Pins (`tests/issue-7489-function-bind.test.ts`; all fail on slice B's head)

- **Agree with node:**
  - `f.bind(o)()` binds `this`;
  - a strict target sees an absent / `null` / `undefined` bound `this` as is;
  - leading and actual arguments are concatenated;
  - `f.bind(a).bind(b)()` keeps `a`;
  - `typeof bf`;
  - `bf.length` with 0, 1 and more leading arguments than parameters;
  - `bf.name`;
  - `bf.hasOwnProperty("caller")` is false;
  - `bf.caller` and `bf.arguments`, read and write, throw a TypeError;
  - `bf.call(x)` ignores `x`;
  - a write to `bf` creates an own property;
  - the realm's `bind` on a non-callable `o` throws a TypeError;
  - a bound call does not read the target's `apply` (`S15.3.4.5_A4`).
- **Abort:**
  - `new bf()`;
  - `x instanceof bf`;
  - `TypeError.bind(null)` (finding 1);
  - a sloppy target bound to `undefined` that reads `this` (C2-D3);
  - sloppy `f.arguments` read and write (C.5).
- **`length` order:** a target whose `length` is an accessor runs its getter once, before `name` is read.
- **M1 premise:** slice B's `bind` routes move to `toString`, a key the realm still does not hold.

### Acceptance

- Each pin fails on slice B's head and passes.
- On the census of `candidates.txt`, no file goes pass → fail. The pass count of `bind.txt` is reported with the main sha.
- Bytes as above.
- Quality:
  - one new module (`bound-function-bodies.ts`, classified);
  - no new dispatcher arm;
  - the prologue and the call-site unpacking are shared;
  - no function over budget without a reviewed grant;
  - the adversarial-review verdict goes in the PR body.
