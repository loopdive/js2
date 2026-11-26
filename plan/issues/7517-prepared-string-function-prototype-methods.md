---
id: 7517
title: "Prepared: String.prototype and Function.prototype methods read off a dynamic value"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: high
horizon: xl
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: [7486]
related: [7354, 7352, 7369, 7312]
---

# #7517 — Prepared: String.prototype and Function.prototype methods off a dynamic value

## Problem

On the Prepared whole-program path (`TEST262_COMPILER_PATH=ir`, standalone, entry
`src/test262/test262-prepared-entry.ts`), a member read off a dynamic value cannot reach a method of
String.prototype or Function.prototype. The realm holds neither prototype's methods, so the read is a
run-time kind abort (`js.value.unsupported`, the program ends at a Wasm `unreachable`) where the
value may also be another kind, and a compile-time refusal where it can only be a string or a
function. Examples: `var s = "a "; s.trim()`; `f.call(o)`; `g.caller`.

[#7486](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7486-prepared-kind-abort-site-ids)
(PR #7468, not on main yet) names each kind-abort site's reason. Its census of the 61 ES5 files that
trap in that abort found 42 String.prototype reads and 11 Function.prototype reads. The ES5 census
of 2026-11-26 (`plan/log/es5-prepared-census-2026-11-26.md`, row 4) has 73 more files that trap in an
abort body whose refusal is a Function.prototype member read or write (an **abort body**: a function
whose body the Prepared path cannot lower is compiled as a run-time abort instead of failing the
program, #7354 U).

Goal: a member read off a dynamic value reaches String.prototype and Function.prototype methods, and
a method call runs them on the receiver.

## Measured (2026-11-26, main `1a726b3e`)

Head: `1a726b3e` (merge of PR #7348, 2026-11-26 07:01 UTC), checked with `git fetch origin main`.
Census: `scripts/ir-census/prepared-census.mts --harness real --jobs 3`, the script of the #7486 branch
(`origin/claude/7486-kind-abort-sites`, which records the trap frame and abort body), run with
`--tree` on a worktree of that head.

| file set | files | verdict on `1a726b3e` |
|---|---:|---|
| kind abort, String.prototype read (#7486 reason) | 42 | 42 fail: trap in `__js_value_unsupported` |
| kind abort, Function.prototype read (#7486 reason) | 11 | 11 fail: trap in `__js_value_unsupported` |
| kind abort, other reasons (out of scope, below) | 8 | 8 fail: trap in `__js_value_unsupported` |
| abort body, Function.prototype member (census row 4) | 73 | 73 fail: `caller` read 38, `apply` 12, `call` 10, `bind` 10, `caller` write 2, `arguments` write 1 |

All 134 fail on main as they did in the 2026-11-26 census. The 8 kind-abort rows outside this lever:
`new` with a function `prototype` 3, a string's own `length` / index 3
([#7352](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7352-ir-object-array-literals-foundation)),
`Object.defineProperties` of a string 1, Object.prototype `toString` on an object 1.

## Yield: what lies behind the gap

The census stops at the first gap, so a passing lever does not by itself make a file pass. To see
what lies behind it, each file was rewritten so that the lever's operation is replaced by a stand-in
of its correct answer, and the census re-run on the rewrite (same head, same harness). A stand-in pass
means nothing else in the file blocks it. It is an **upper bound**: it assumes the real
implementation answers correctly, and it drops side effects the stand-in does not model (noted per
row).

Stand-ins used:

- **Strings:** each `recv.m(args)` (m a String.prototype method) ran in node with the harness. A site
  whose every execution had a primitive string receiver and one primitive answer (or one primitive
  throw) became that literal. The argument conversions' side effects are not replayed.
- **Functions:** `f.call(t, a…)` → `f(a…)`; `f.apply(t[, u])` → `f()`; `f.bind(t)()` → `f()`;
  `g.caller` → a TypeError thrown where `g` is strict, an absent-key read (`undefined`) where it is
  sloppy; a write of `caller` / `arguments` (only on strict functions in this set) → a thrown
  TypeError. Files whose verdict reads `this`: `f.call(o)` → `(o.__standin = f, o.__standin())`.
  `foo.bind({})` as a value → `foo` (a function object with its own properties stands in for the
  bound function).

Yield by slice (dependency order taken into account: a file counts in the slice that completes it):

| slice | files | stand-in pass (measured) | not served (estimated) |
|---|---:|---:|---|
| F1 `caller` / `arguments` | 43 | 43 | — |
| S1 plain String.prototype methods | 34 | 33 | 1 needs String.prototype `toString` too (in S1); estimated to pass |
| F2 `call` / `apply` | 25 | 22 | 3: a sloppy callee with `this` `undefined` needs the global object (#7354 C2-D3) |
| F3 `bind` | 15 | 15 | — |
| S2 `replace` / `search` / `match` / `split` | 8 | 8 | — |
| none (`Error.constructor.length` needs %Function% as a value) | 1 | — | 1 |
| **total** | **126** | **121** | 4 |

- **Upper bound 121 (measured, stand-in); 122 with the one estimated row.**
- **At risk, estimated:** `localeCompare` 1 (needs the decision below), the case-mapping rows 4
  (`toUpperCase`, `toLowerCase`, `toLocaleUpperCase`, `toLocaleLowerCase`; need Unicode tables), `trim` 11 (needs the full
  WhiteSpace + LineTerminator set, which `src/stdlib/strings.ts`'s `isWs` covers per #1963). A
  delivered figure below 121 is expected if a slice ships without one of these.
- **The `caller` model is worth 13 files (measured by file inspection):** 13 noStrict files
  (`15.3.5.4_2-75gs`, `-79gs`…`-82gs`, `-84gs`…`-87gs`, `-89gs`…`-92gs`) read `g.caller` of a sloppy
  `g` and expect no throw. A realm with only the specification's Function.prototype accessor
  (%ThrowTypeError% for every function) fails them; V8's own `caller` on sloppy functions passes them.
  F1 is 42 instead of 43, F2 14 instead of 22, F3 11 instead of 15 without it.

## Related walls (not counted in the yield)

Compile-error first stops on the full ES5 census of 2026-11-26 (`main-6694a8b8-real.jsonl`, main
`6694a8b8`, 8,717 positive files) that the same mechanisms serve:

| wall | files | served by | re-measured on `1a726b3e` |
|---|---:|---|---|
| `method call .m(...) on string not in slice 4` (a typed string receiver: the Prepared resolver has no `stringMethodPlan`) | 136 | the same String.prototype algorithms (slice T) | still 136; stand-in: **113 pass behind it** (measured) |
| `member read 'call' / 'bind' / 'apply' / 'toString' of a function needs Function.prototype's properties` (in module-init, so a compile error, not an abort body) | 64 (35 / 20 / 8 / 1) | F2, F3 (`toString` not) | still 64; behind the gap not measured |

The typed group by method: `trim` 56, `indexOf` 11, `charAt` 9, `replace` 8, `toLocaleLowerCase` 8,
`toLocaleUpperCase` 6, `search` 5, others ≤ 4. Its 23 stand-in non-passes: `split` / `match`
results are arrays (8), `unknown class "String"` 4, computed-key member read 4, an uncaught throw in
`10.4.3-1-100gs` / `-102gs` 2, `JSON` not in scope 2, others 3.

Walls that need the catalog rows this issue adds but a different mechanism (built-in constructors as
values, #7354 V1), from the same artifact only: `unknown class "String"` 281,
`identifier "String" is not in scope` 206, `identifier "Function" is not in scope` 79,
`direct call to "Function" has no exact AST-site plan` 154.

## Implementation Plan

### What exists (read on `1a726b3e`)

- **Member read** (`src/ir/program/dynamic-member-access.ts`): one chain over the receiver's kinds. A
  key in `BUILTIN_REACHABLE_KEYS` (`builtin-prototype-keys.ts`) is "missing": a compile-time `gap()`
  when every kind the receiver may hold misses it, else the run-time abort in that kind's arm. A
  primitive's arm answers Object.prototype's native method (`realmIntrinsic`) or `undefined`. A
  function's arm is the realm's [[Get]] (`js.object.get`).
- **Method call of a realm method** (#7354 P1, G1; `dynamic-prototype-methods.ts`): for the shape
  `o.m(v)` whose callee is the [[Get]] of `m` on the same receiver, the call compares the callee with
  the realm's built-in (`js.value.strict_eq` against `js.object.intrinsic(selector)`) and runs the
  method's algorithm at the site; any other callee takes the dispatcher (`irClosureMethodReference`),
  which aborts for a built-in. Rows today: `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`,
  `Error.prototype.toString`.
- **Realm catalog** (`src/runtime/contracts/native-realm-catalog.ts`): Object, Function,
  Object.prototype, Function.prototype (with `call`, `apply`, `bind`, `toString`, and the `caller` /
  `arguments` accessors over %ThrowTypeError%), the Error family. No String.prototype row: its keys are
  a hand list (`STRING_PROTOTYPE`, and `NUMBER_PROTOTYPE`) in `builtin-prototype-keys.ts`.
  `NATIVE_VALUE_INTRINSICS` numbers the function objects the realm can hold; an entry's behaviour
  (`native-builtin-function-requests.ts`) is `function-prototype`, `throw-type-error`,
  `object-prototype-method` (seeded onto Object.prototype) or `native`. The realm's
  Function.prototype holds none of its methods or accessors.
- **Function objects** (`source-function-object-bodies.ts`, `js.object.init-function(closure, name,
  length, constructor)`): own `length`, `name`, and for a constructor `prototype`. No `caller` /
  `arguments`.
- **Typed string methods** (`src/ir/string-method-surface.ts`, `stringMethodPlan`): the one table of
  argument roles (ToString / ToIntegerOrInfinity), omitted defaults and results, read by the
  selector, the WasmGC and the linear resolvers. Its helpers (`__str_trim`, `__str_indexOf`, …) are
  legacy runtime functions; the self-hosted ones (`src/stdlib/strings.ts`: trim family,
  `startsWith`, `endsWith`, `repeat`, pad) call legacy kernels (`__str_flatten`, `__str_region_eq`,
  `__str_ws_start` / `_end`, `charCodeAt`, `__str_substring`). The Prepared backend has only
  `__str_flatten`, concat, equality, number conversion and literals (`src/backend/wasmgc/resources`).
  `program-source-units.ts` gives the Prepared resolver no `stringMethodPlan`.
- **Runtime support batches** (`src/ir/program/runtime-support.ts`, `prepare-number-format.ts`,
  `program-codec.ts`): the Prepared program carries one self-hosted IR body
  (`number-format-radix-v1`, built by `buildSelfHostedIrBody` from `src/stdlib/number-format.ts`),
  and `number-to-string-target.ts` retargets the ordinary pipeline's helper call to the Prepared
  binding. The codec accepts exactly one batch, of that kind.

### Target structure

Two families, one shape: the realm holds the built-in method; a read off a value finds it; the
method call recognises it by identity and runs its algorithm at the site, over the legalization's own
conversions (`stringOf`, `toNumber`, the dispatcher). This is P1's mechanism, made table-driven.

| concern | module | change |
|---|---|---|
| String.prototype in the catalog | `src/runtime/contracts/native-realm-catalog.ts` | a `%String.prototype%` row and its method rows; the methods with a Prepared algorithm marked `native` and appended to `NATIVE_VALUE_INTRINSICS`; Function.prototype `call` / `apply` / `bind` marked `native` per slice |
| reachable keys | `src/ir/program/builtin-prototype-keys.ts` | `STRING_PROTOTYPE` hand list replaced by `realmStringKeys("%String.prototype%")`; native methods leave `BUILTIN_REACHABLE_KEYS` like Object.prototype's (P1); `caller` / `arguments` leave the function row once F1 holds the accessors |
| primitive read | `dynamic-member-access.ts` | the primitive arm answers the wrapper prototype's native method, then Object.prototype's, then `undefined`: one lookup by catalog parent, no per-key branch |
| method-call algorithms | `dynamic-prototype-methods.ts` (dispatch) plus sibling modules `dynamic-string-methods.ts` and `dynamic-function-methods.ts` | `prototypeMethodOfCall` answers a catalog id; `dynamicPrototypeMethodCall` keeps the identity test and takes the algorithm from a table keyed by catalog parent (Object.prototype, Error.prototype, String.prototype, Function.prototype). Each sibling module exports one algorithm builder in the shape of `ownProperty` / `prototypeOf` |
| realm seeding | `native-builtin-function-requests.ts`, `builtin-function-bodies.ts` | `object-prototype-method` becomes `prototype-method` with the holder taken from the catalog parent (Object.prototype or Function.prototype); F1 seeds Function.prototype's `caller` / `arguments` accessors from the catalog |
| sloppy function's own `caller` / `arguments` | `source-function-object-bodies.ts`, `js.object.init-function` | the `constructor` flag becomes a function-kind selector; a sloppy plain function also gets own `arguments`, `caller` = `null` (non-writable, non-enumerable, non-configurable; V8's own key order `length`, `name`, `arguments`, `caller`, `prototype`) |
| String algorithms' bodies | `src/stdlib/strings.ts` (self-hosted sources), a generalised runtime-support batch (`runtime-support.ts`, `prepare-number-format.ts` → a batch table, `program-codec.ts`) | one batch kind per self-hosted family, the radix batch one row of it; the string family's defs built once by `buildSelfHostedIrBody` |
| helper binding | `number-to-string-target.ts` → one retarget table | the ordinary helper symbol (`__str_trim`, …) maps to the Prepared support function; the radix retarget is one row |
| kernels | shared pure builders in `src/runtime/wasmgc/values/` | the code-unit read, flat substring, `__str_region_eq`, `__str_ws_start` / `_end` move from the legacy emitters (`native-strings-search.ts`, `native-strings-ws.ts`, `char-code-at-helpers.ts`) to pure builders that both the legacy emitter and the Prepared backend call, as `__str_flatten` already is |
| bound functions (F3) | `src/runtime/wasmgc/values/` (a bound-function layout and its dispatcher arm), `dynamic-function-methods.ts` (`bind`'s algorithm) | a function-kind value whose call unwraps to its target with the bound `this` and arguments; own bag like a source function |

**Duplicates removed:** the `STRING_PROTOTYPE` hand list (keys come from the catalog); the
per-method ternary in `dynamicPrototypeMethodCall` (one table); the `caller` / `arguments`
special case in `dynamicMemberWrite` and `FUNCTION_REACHABLE_KEYS`'s accessor keys (the realm answers
them); the "exactly one radix batch" codec rule and the radix-only retarget (one table each); the
omitted-argument defaults written twice (from-ast's `omittedStringMethodArgument` and the new
dynamic arm) become one function in `string-method-surface.ts` that both call; the legacy kernel
emitters' hand `Instr[]` (one pure builder each, shared).

**Not built here, named:** a built-in function object callable through a value (#7354 P2: the
dispatcher calling a built-in's `(this, vector)` algorithm). A detached call
(`var h = s.trim; h()`) and `String.prototype.trim.call(o)` keep the dispatcher's run-time abort.

### Decisions to settle in review before code

1. **`caller` on a sloppy function: V8's own data property, value `null`.** The specification
   (§17.1, forbidden extensions) allows an own `caller` on a non-strict function as long as it never
   answers a strict function; `null` meets that. V8 answers the calling function when the caller is
   sloppy; `null` differs there, and no file in this set observes the difference (13 files need the
   property to exist, see above). The alternative, the specification's accessor only, costs those 13
   files.
2. **`localeCompare` without ECMA-402:** code-unit order is conforming (§22.1.3.12 leaves it
   implementation-defined) but differs from V8 (ICU: `"h".localeCompare("H")` is -1, code units
   give 1). Either refuse by name (1 file lost) or answer code-unit order with a test that pins only
   the properties ES requires (antisymmetry, `0` for equal strings).
3. **`String.prototype.toString` / `valueOf`** are not generic (thisStringValue): a non-string
   receiver throws a TypeError. Every other S1 method takes ToString(this).

### Slices, by measured yield

Each slice: the files named are run in the census on the slice's head; the full ES5 census (8,717
positive files) shows no pass → non-pass against the base head; standalone only; refusal at select
only (an unsupported sub-case is a named `gap()` or the existing run-time abort, never a claim that
is withdrawn).

**F1 — `caller` / `arguments` (43 files, measured stand-in).**
- Realm: seed Function.prototype's `caller` / `arguments` accessors (get and set %ThrowTypeError%)
  from the catalog. `init-function` gives a sloppy plain function own `arguments` / `caller` =
  `null` (decision 1). Arrows, methods, accessors and strict functions get none.
- IR: `caller` / `arguments` leave `FUNCTION_REACHABLE_KEYS`; the write's
  `FUNCTION_PROTOTYPE_ACCESSOR_KEYS` refusal goes (the realm's [[Set]] finds the accessor and its
  setter throws; a sloppy function's own read-only property takes F1b's PutValue).
- Tests: strict `g.caller` / `g.caller = 1` / `g.arguments = 1` throw a TypeError; sloppy `g.caller`
  is `null`; `Object.getOwnPropertyDescriptor(g, "caller")` of a sloppy `g` gives node's descriptor
  and of a strict `g` `undefined`; a getter's `caller` throws. Files: the 41 `caller`-only and write files of census row 4, `15.3.5.4_2-94gs`, `-96gs`.

**S1 — plain String.prototype methods (34 files: 33 measured stand-in, 1 estimated).**
- Catalog row `%String.prototype%` and its methods; native: `trim`, `trimStart`, `trimEnd`,
  `indexOf`, `lastIndexOf`, `includes`, `startsWith`, `endsWith`, `substring`, `slice`, `charAt`,
  `charCodeAt`, `concat`, `toString`, `valueOf`, `localeCompare` (decision 2), then the four case
  methods as S1b once the case tables are a pure data module the self-hosted body reads
  (`case-tables.ts` is generated data already).
- Primitive read answers the method (`realmIntrinsic`). Call site: the identity test, then
  ToString(this) by `stringOf` (decision 3 for `toString` / `valueOf`), each argument converted by its
  `stringMethodPlan` role (ToString by `stringOf`; a position by `toNumber` then
  `i32.trunc_sat_f64_s`, which is ToIntegerOrInfinity clamped to i32, NaN → 0, as from-ast does),
  omitted arguments from the shared default function, the helper call, the result boxed into the
  carrier by its role (string, number, index → number, boolean).
- Bodies: the existing self-hosted defs plus new defs in `src/stdlib/strings.ts` for `indexOf`,
  `lastIndexOf`, `substring`, `slice`, `charAt`, `charCodeAt`, `concat`; their kernels as shared pure
  builders (step 1 enumerates the closed set the defs call and fails loudly on any other).
- Byte identity: the legacy emitters that now call the shared builders produce the same bytes; check
  by compiling the equivalence corpus and the playground examples on the JS target before and after
  and comparing the binaries (the #7486 method).
- Tests: each method on a string receiver and on an object receiver with `toString` (the generic
  path), argument conversion order (receiver, then each argument, a throw stops the rest), omitted
  and `undefined` arguments, `lastIndexOf` with NaN position, `trim` over every WhiteSpace and
  LineTerminator code point, a detached call still aborts. Files: the 34.

**F2 — `call` / `apply` (22 files measured stand-in; 3 not served).**
- Catalog marks `%Function.prototype.call%` / `apply` native; the realm seeds them onto its
  Function.prototype (`prototype-method` behaviour), held where the program reads the key (P1's rule).
- Algorithm: IsCallable(F) (the function-kind test, else a TypeError), then the dispatcher with the
  receiver `thisArg` and the remaining arguments. `apply` with `undefined` / `null` (or no) argument
  list calls with none; an array-like list is the run-time abort until a vector call exists (named).
- Tests: `this` of a strict and a sloppy callee, argument padding, a non-callable receiver's
  TypeError, a user-written `f.call = …` takes the dispatcher. Files: the 16 of row 4 and the 6 that
  read `this` (`10.4.3-1-88`, `-93` both forms, `S15.3.4.3_A5_T5`, `S15.3.4.4_A5_T5`).

**F3 — `bind` (15 files, measured stand-in).**
- A bound function: a function-kind value (it passes `js.value.is_function`), own bag with `length`
  (max(0, target length − bound arguments)) and `name` (`"bound " + name`), [[Prototype]] the
  target's. The dispatcher unwraps it (target, bound `this`, bound arguments first); `new` on it
  constructs the target (the bound `this` ignored). Bound arguments use the argument vector the realm
  already has.
- Tests: call, `new`, `length` / `name`, properties defined on the bound function, a bound bound
  function. Files: the 8 of row 4 that use `bind`, `10.4.3-1-98` both forms, the 5 `bind` kind-abort
  files.

**S2 — `replace`, `search`, `match`, `split` (8 files, measured stand-in).**
- A pattern argument converted by ToString at run time matches literally only when it holds no
  RegExp syntax character; otherwise the run-time abort until
  [#7369](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7369-prepared-regexp) provides
  RegExp. `replace` with a function replaceValue calls it through the dispatcher (match, position,
  string). `match` and `split` results are arrays: the run-time abort until arrays carry through the
  realm ([#7352](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7352-ir-object-array-literals-foundation));
  the 2 files here throw in a conversion before that.

**T — typed string receivers (related, not in the yield; 113 behind the gap, measured stand-in).**
- The Prepared resolver gets `stringMethodPlan`; the helper calls bind through the retarget table to
  the same support bodies. No second plan table. Measure the 136 files again before building.

### Acceptance criteria

- Correctness: each slice's files pass in the census on its head; no pass → non-pass on the full ES5
  census against the base head; the completed-edition ratchet stays green; JS-environment (gc)
  output byte-identical on the equivalence corpus and the playground examples.
- Code quality:
  - one method-call mechanism (P1's identity test) with a table of algorithm builders, no per-key
    branch in `dynamic-member-access.ts`;
  - one argument-role table (`string-method-surface.ts`) read by the typed and the dynamic path;
  - String.prototype keys from the catalog, the `STRING_PROTOTYPE` hand list gone;
  - one runtime-support batch mechanism and one helper-retarget table, the radix batch a row of each;
  - every kernel a pure builder in `src/runtime/wasmgc/values/` used by both pipelines;
  - new modules sibling-shaped and within the loc / func budgets without a grant;
  - an adversarial review (fresh context, given the diff and this plan) records its verdict in each
    PR body.

### Hazards

- **Byte identity** of the legacy emitters moved to shared builders: compare binaries, not just test
  verdicts.
- **New own keys on sloppy functions** change `Object.getOwnPropertyNames`, `hasOwnProperty` and
  property counts for every sloppy function: the full ES5 census is the check, not the 43 files.
- **Realm size:** every held String.prototype method is an entry initialised with the realm. Hold an
  entry only where a program reads its key (P1's rule), and check the harness-compile budget
  (`scripts/check-harness-compile-budget.ts`).
- **The M1 premise** (no Prepared program can change a built-in prototype) carries the identity
  test's soundness for primitives. It stops holding when `String` becomes a value (#7354 V1); the
  premise test must then cover String.prototype.
- **Stand-in limits:** the string stand-ins do not replay argument conversions (e.g. `split`'s
  `valueOf` call order), and the function stand-ins do not model the bound `this`. The slice tests
  above cover both.

## Reproduce the measurement

The rows and the stand-in rewriters are kept locally under `.tmp/7517/` of the worktree that wrote
this file (gitignored).

```bash
git worktree add .claude/worktrees/main-7517 origin/main   # 1a726b3e
# link node_modules and test262 into it, then, from the #7486 branch:
npx tsx scripts/ir-census/prepared-census.mts --tree <main-7517> --files set134.txt \
  --out main-134.jsonl --harness real --jobs 3
# stand-ins: rewrite into a scratch tree (src, tests and test262/harness symlinked), census with --tree
node strings.cjs str42.tsv <main-7517>/test262/test <scratch-tree> report.jsonl
node functions.cjs fn65.txt <main-7517>/test262/test <scratch-tree>
```

Delete the census `--out` file before a re-run: the script resumes from it.
