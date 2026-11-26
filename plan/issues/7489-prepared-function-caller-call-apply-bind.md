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
