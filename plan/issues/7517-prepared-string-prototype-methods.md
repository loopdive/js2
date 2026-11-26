---
id: 7517
title: "Prepared: String.prototype methods read off a dynamic value"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7486, 7489, 7354, 7352, 7369, 7313]
---

# #7517 — Prepared: String.prototype methods off a dynamic value

## Problem

On the Prepared whole-program path (`TEST262_COMPILER_PATH=ir`, standalone, entry
`src/test262/test262-prepared-entry.ts`), a member read off a dynamic value cannot reach a
String.prototype method. The realm holds none, so `var s = "a "; s.trim()` reads `trim` through the
run-time kind abort `js.value.unsupported` (the program ends at a Wasm `unreachable`).

[#7486](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7486-prepared-kind-abort-site-ids)
(PR #7468) names each kind-abort site's reason. In its census, 42 of the 61 ES5 files that trap in
that abort stop at "member read '<key>' of a string needs String.prototype's properties". This issue
depends on #7486 for that measurement; #7486 is under `related` because its issue file is not on
main yet, and the issue-integrity gate rejects a `depends_on` that names a missing file.

Goal: a member read off a dynamic value reaches String.prototype's methods, and the method call
`s.m(…)` runs the method on its receiver.

**Out of scope, owned elsewhere.** Function.prototype's `caller` / `arguments`, `call` / `apply`
and `bind` belong to
[#7489](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7489-prepared-function-caller-call-apply-bind),
which covers them:
- slice A: PR #7449;
- slice B: PR #7480;
- slice C (`bind`, with its own `bound-function-bodies.ts`): under plan review on `claude/s20-fn-bind`
  at `fd56edfd`.

For the record only, this issue's stand-in measurement on main `1a726b3e` (2026-11-26) covered 84
Function.prototype files (73 abort bodies of census row 4, and 11 kind aborts):

| group | stand-in result |
|---|---|
| `caller` / `arguments` | 43 pass |
| `call` / `apply` | 22 of 25 pass; 3 need the global object as a sloppy `this` |
| `bind` | 15 of 15 pass |
| `Error/length.js` | not served: it needs %Function% as a value |

The shared dispatch shape below is #7517's first step, after #7480 merges. Slice C builds on it
and stays focused on `bind`.

## Measured (main `1a726b3e`, 2026-11-26)

Head `1a726b3e` (merge of PR #7348), confirmed with `git ls-remote origin refs/heads/main`.

**Method.** The census is `scripts/ir-census/prepared-census.mts --harness real --jobs 3`, the
script from the #7486 branch (it records the trap frame), run with `--tree` on a worktree of that
head.

**Current verdict:** all 42 files fail, trapping in `__js_value_unsupported` (re-run at 12:25 UTC).

**Stand-in.** Each `recv.m(args)` call (m a String.prototype method) was run in node with the
harness. A site where every execution had a primitive string receiver and gave one primitive answer
(or one primitive throw) was replaced by that literal, and the census was re-run on the rewritten
file. A pass means nothing else in the file blocks it. This is an **upper bound**: it assumes the
method answers correctly. Argument conversions' side effects are not replayed; the slice tests
cover them.
- 41 / 42 pass with `toString` / `valueOf` left as they are.
- 42 / 42 pass once `toString` is replaced too: `trim/15.5.4.20-1-8.js` also calls
  `strObj.toString()`.
- Each file reaches one method (two in `15.5.4.20-1-8.js`).

| slice | methods (files) | files | stand-in pass (measured) |
|---|---|---:|---:|
| S1 plain methods | `trim` 11, `indexOf` 3, `lastIndexOf` 3, `substring` 3, `slice` 3, `charAt` 2, `charCodeAt` 2, `concat` 2, `toUpperCase` 1, `toLowerCase` 1, `toLocaleUpperCase` 1, `toLocaleLowerCase` 1, `localeCompare` 1 (plus `toString` in one `trim` file) | 34 | 34 |
| S2 pattern, limit or callback | `replace` 3, `search` 3, `match` 1, `split` 1 | 8 | 8 |
| **total** | | **42** | **42** |

**At risk (estimated):**
- case mapping, 4 files: extracting `case-convert-native.ts`, the largest emitter, which also builds
  module globals for its tables;
- `localeCompare`, 1 file: code-unit order (decision 3) passes its test, which pins only
  antisymmetry, but it is not V8's ICU order.

**S2's 8 files stop before a RegExp or an array is needed.**
- `search` takes a pattern whose ToString holds no RegExp syntax (`"AB"`, `"null"`), or one that
  throws.
- `replace` searches a string literally.
- `match` throws in its argument's ToString, and `split` in its limit's ToUint32, both before their
  array result.
- The plan revisions below (run-time defaults, argument order, literal `replace` / `split`, the
  object-pattern refusal) match the stand-in's answers for all 42 files, so the yield was not
  re-measured.
- **Object patterns (checked 2026-11-26):** 6 of the 8 files pass an ordinary object as the pattern:
  - `search/S15.5.4.12_A1_T10`, `-T11`;
  - `replace/S15.5.4.11_A1_T10`, `-T11`;
  - `match/S15.5.4.10_A1_T11`;
  - `split/separator-override-tostring-limit-override-valueof-throws`.

  None of the 8 contains a RegExp literal or names `RegExp` or `Symbol`, and neither does the
  assembled harness (scanned with the TypeScript parser). The shim's `RegExp: globalThis.RegExp` and
  `Symbol: globalThis.Symbol` are member names, which `isMemberName` excludes. So the refusal below
  does not fire for them: S2 stays 8. Refusing every object pattern would have cost these 6.

## Implementation Plan

### What exists (`1a726b3e`, plus #7489 slices A and B)

- **Member read** (`src/ir/program/dynamic-member-access.ts`): a primitive's arm answers
  Object.prototype's native method (`realmIntrinsic`) or `undefined`. A key in
  `BUILTIN_REACHABLE_KEYS.string` (`builtin-prototype-keys.ts`) that no kind answers is a `gap()`.
  Where another kind answers, the string arm is the run-time abort.
- **String.prototype keys** are a hand list, `STRING_PROTOTYPE`, in `builtin-prototype-keys.ts`. The
  catalog (`src/runtime/contracts/native-realm-catalog.ts`) has no String.prototype row.
- **Method call of a realm method** (`dynamic-prototype-methods.ts`, #7354 P1 / G1): for `o.m(v)`,
  where the callee is the [[Get]] of `m` on the same receiver, the call compares the callee with the
  realm's built-in. If they are the same, it runs the method's algorithm at the site; otherwise it
  takes the dispatcher.
- **#7489 slice B's shape** (PR #7480, `38ef5af6`):
  - `NATIVE_PROTOTYPE_METHODS` records each prototype's native method names
    (`"Object.prototype"`, `"Function.prototype"`), and `NATIVE_VALUE_INTRINSICS` is derived from it.
  - `"Error.prototype": ["toString"]` stays a separate `NATIVE_MEMBERS` line, and its id is found
    as `NATIVE_VALUE_INTRINSICS.at(-1)`.
  - `unpopulatedKeys(parent)` gives the catalog keys of a prototype that the realm does not hold.
  - `heldPrototypeMethods` holds all of a prototype's native methods once one is read.
  - In the IR, `RealmMethod` is a union of names. `prototypeMethodOfCall` picks one parent per name
    (`toString` is Error.prototype's where `errors`). `methodId` and the algorithm are a `switch`
    with one case per method, and there is one lookup function per parent
    (`nativeObjectPrototypeMethod`, `nativeFunctionPrototypeMethod`).
- **Legacy string helpers.** These are hand `Instr[]` emitters over a `CodegenContext`. Each is
  listed with what it emits:

  | function | file | emits |
  |---|---|---|
  | `emitStrIndexOfHelper` | `src/codegen/native-strings-search.ts` | `__str_indexOf` |
  | `emitStrLastIndexOfHelper` | `native-strings-search.ts` | `__str_lastIndexOf` |
  | `emitStrIncludesHelper` | `native-strings-search.ts` | `__str_includes` |
  | `emitStrRegionEqHelper` | `native-strings-search.ts` | `__str_region_eq` |
  | `emitStrSliceCharHelpers` | `native-strings-basics.ts` | `__str_substring`, `__str_charAt`, `__str_charAt_cp`, `__str_slice`, `__str_substr` |
  | `emitStrCompareHelpers` | `native-strings-basics.ts` | `__str_compare` (code-unit order); its `__str_equals` already calls the shared `buildStringEqualityBody` |
  | `emitStrConcatHelpers` | `native-strings-basics.ts` | `__str_concat`, already the shared `buildStringConcatDefinition` |
  | `ensureNativeCharCodeAtHelper` | `char-code-at-helpers.ts` | the guarded `charCodeAt` |
  | `emitStrWsSpanHelpers` | `native-strings-ws.ts` | `__str_ws_start` / `__str_ws_end` |
  | `emitStrGetSubstitutionHelper` | `native-strings-rewrite.ts` | GetSubstitution |
  | `emitStrReplaceFirstHelper` | `native-strings-rewrite.ts` | `__str_replace`, the `$`-pattern replace (#7313) |
  | `emitNativeCaseConversion` | `case-convert-native.ts` | full Unicode case mapping over the generated `case-tables.ts` |
  | `wrapBodyWithFlatten` | `native-strings-shared.ts` (in `makeNativeStrShared`) | the `__str_flatten` preamble |

  The trim family is self-hosted (`src/stdlib/strings.ts`: `__str_trim`, `__sh_str_isWs`, which
  covers the full WhiteSpace and LineTerminator set). The Prepared backend has only `__str_flatten`,
  concat, equality, number conversion and literals. Flatten's body is already a shared pure builder
  (`buildStringFlattenDefinition(layout, resources)`), called by both pipelines.
- **Roles** (`src/ir/string-method-surface.ts`): the table of argument roles, omitted defaults and
  results that the typed path reads.
  - Its predicates `stringMethodPlan`, `isStringSurfaceMethod` and `isStringMethodHelper` steer the
    ordinary pipeline's selection, so their answers decide gc output.
  - `concat` takes one argument; `split`, `match`, `localeCompare`, `toString` and `valueOf` have no
    row.
- **Runtime support** (`runtime-support.ts`, `prepare-number-format.ts`, `program-codec.ts`,
  `number-to-string-target.ts`): the Prepared program carries one self-hosted IR body, the radix
  formatter, and retargets one ordinary helper call to it. The codec accepts exactly one batch.

### Shared dispatch (S1's first step, after #7480 merges)

One pattern for every prototype the realm populates; #7489's rows move in unchanged in behaviour.

- **Catalog.** `NATIVE_PROTOTYPE_METHODS` gains `"Error.prototype": ["toString"]`, which replaces the
  separate `NATIVE_MEMBERS` line, and `"String.prototype"`, filled per slice. The catalog gains a
  `%String.prototype%` row with its method rows.
  - `NATIVE_VALUE_INTRINSICS` becomes the prototype methods in record order, then the Error
    constructors.
  - `Error.prototype.toString`'s selector therefore moves (Prepared output only), and
    `NATIVE_VALUE_INTRINSICS.at(-1)` becomes `realmMethodId("Error.prototype", "toString")`.
  - Error.prototype's row stays held by the Error-family rule.
- **Keys.** `STRING_PROTOTYPE` becomes `unpopulatedKeys("String.prototype")`, and one
  `nativePrototypeMethod(parent, name)` replaces the per-parent lookups.
- **Primitive read.** The string arm answers String.prototype's native method, then
  Object.prototype's, then `undefined`: one lookup by parent, with no per-key branch.
- **Call.** The candidates are every prototype whose native list holds the call's constant key, with
  Error.prototype only where the program holds the Error family.
  - The callee is compared with each candidate's built-in in turn. The first match runs that
    prototype's builder, and no match keeps the call, which goes to the dispatcher.
  - With one candidate this is today's single identity test. `toString`'s `errors` special case
    becomes the Error.prototype row.
- **Holding (decision 1).** `heldPrototypeMethods` holds per method, not per prototype. A method is
  held where a use reads its key or names its intrinsic.
- **Why #7480's `switch` cannot serve strings:**
  - S1 and S2 make 24 String.prototype methods native, and all of them run one builder,
    parameterised by the role row: 24 cases would be the per-method branching this removes.
  - A name like `toString` / `valueOf` names several prototypes' built-ins, and which one a call
    reads is known only at run time.

### Final shared-dispatch API

The exact names and signatures that #7517's first step lands and #7489's slice C builds on:

```ts
// src/runtime/contracts/native-realm-catalog.ts
export const NATIVE_PROTOTYPE_METHODS: Readonly<{
  "Object.prototype": readonly ["hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable"];
  "Function.prototype": readonly ["apply", "call"]; // slice C appends "bind"
  "Error.prototype": readonly ["toString"];          // was NATIVE_MEMBERS' own line
  "String.prototype": readonly NativeStringPrototypeMethod[]; // filled by #7517 S1 / S2
}>;
export type NativePrototype = keyof typeof NATIVE_PROTOTYPE_METHODS;
export const realmMethodId: (parent: string, name: string) => string; // unchanged: `%${parent}.${name}%`
// NATIVE_VALUE_INTRINSICS: every prototype's methods in record order, then the Error constructors.

// src/ir/program/builtin-prototype-keys.ts
export interface RealmMethod {
  readonly parent: NativePrototype;
  readonly name: string;
}
/** `{ parent, name }` when the catalog marks `%<parent>.<name>%` native; replaces
 *  nativeObjectPrototypeMethod, nativeFunctionPrototypeMethod and objectPrototypeMethodId. */
export function nativePrototypeMethod(parent: NativePrototype, name: string): RealmMethod | undefined;
/** `realmMethodId(method.parent, method.name)`; replaces the `methodId` switch. */
export const realmMethodIdOf: (method: RealmMethod) => string;

// src/ir/program/dynamic-prototype-methods.ts
type Call = Extract<IrInstr, { kind: "call" }>;
/** Candidate rule: `call` is `o.m(…)`, its callee the [[Get]] of the constant key `m` on the same
 *  receiver; the answer is nativePrototypeMethod(P, m) for every P in NATIVE_PROTOTYPE_METHODS order
 *  that has one, Error.prototype only where `errors`. Empty: not a realm-method call. */
export function prototypeMethodsOfCall(
  call: Call,
  definitions: ReadonlyMap<IrValueId, IrInstr>,
  errors: boolean,
): readonly RealmMethod[];
/** The callee against each candidate's built-in (`js.value.strict_eq` with `js.object.intrinsic`) in
 *  turn; the first match runs PROTOTYPE_ALGORITHMS[parent], none keeps `call` (the dispatcher). */
export function dynamicPrototypeMethodCall(
  b: ObjectStaticBuilders,
  call: Call,
  candidates: readonly RealmMethod[],
): IrInstr[];
/** One builder per prototype; `name` selects the method inside it. */
export type PrototypeAlgorithm = (b: ObjectStaticBuilders, call: Call, name: string, result: IrValueId) => IrInstr[];
const PROTOTYPE_ALGORITHMS: Readonly<Record<NativePrototype, PrototypeAlgorithm>>;
//   "Object.prototype":   ownProperty / prototypeOf (this module)
//   "Function.prototype": #7489's invoke / apply (slice C adds bind)
//   "Error.prototype":    js.object.error-to-string
//   "String.prototype":   stringMethodCall (dynamic-string-methods.ts)

// src/ir/program/native-realm-requirements.ts
/** Per method (was: a prototype's all once one is read): the id of every native prototype method
 *  whose key a `js.object.get` use reads as its constant key, or whose intrinsic a use names.
 *  Error.prototype's row stays held by the Error-family rule (heldErrorConstructors). */
function heldPrototypeMethods(uses: readonly Use[]): ReadonlySet<string>;
```

### String methods: roles, conversions, patterns

**The role table** (`string-method-surface.ts`) is the one source of arguments for the typed and the
dynamic path. One field on the row keeps the new data out of the typed path, with no second table:

- **`typedPath: false` hides a whole row.** The new rows (`split`, `match`, `localeCompare`,
  `toString`, `valueOf`) carry it; absent means `true`, so every existing row is unchanged. All three
  typed predicates read it:
  - `stringMethodPlan` and `isStringSurfaceMethod`, through `stringMethodRow`, their one accessor;
  - `isStringMethodHelper`, which today scans `Object.values(ROWS)` directly and gains the same filter.
    Without it, `localeCompare`'s `__str_compare` would turn `isStringMethodHelper` true and move the
    ordinary pipeline's helper materialisation (`integration.ts`).
- **Dynamic-only parts of a typed row live in the row's `dynamic` record:**
  - `concat`'s `rest: true`;
  - the conversion order (`split`'s);
  - the receiver conversion (thisStringValue for `toString` / `valueOf`).

  `stringMethodPlan` copies only named fields into its result, and its arity check reads
  `row.arity ?? row.parameters.length`. So the record changes neither the plan nor typed `concat`'s
  one-argument arity.
- **The dynamic path** reads every row through `stringMethodRole(method)`.
- **A unit test pins the typed predicates.** `stringMethodPlan`, `isStringSurfaceMethod` and
  `isStringMethodHelper` give today's answers for every String.prototype name, argument counts 0–4,
  both backends, and every helper symbol, so selection and gc output cannot move.

New rows and fields:

| method | receiver | parameters (role, omitted) | result |
|---|---|---|---|
| `localeCompare` | ToString(this) | that: `search`, `undefined` | `index` (`__str_compare`'s -1/0/1) |
| `toString`, `valueOf` | thisStringValue: a non-string throws a TypeError | — | `string` |
| `concat` | ToString(this) | `search`, `dynamic.rest: true` (each argument in order) | `string` |
| `split` | ToString(this) | separator: `literal-pattern`; limit: `limit`, undefined → 2^32−1 | array: the run-time abort after the conversions |
| `match` | ToString(this) | regexp: `pattern`, `empty` | array: the run-time abort after the conversions |
| `replace` | ToString(this) | search: `literal-pattern`; replaceValue: `replacer` (callable, else ToString) | `string` |

- New roles:
  - `limit`: ToUint32, the IR's `js.shr_u` by 0;
  - `replacer`: IsCallable, else ToString, applied before the search;
  - `literal-pattern`: a non-object operand is used literally, with no RegExpCreate.
- `split`'s order exception: the limit is converted before the separator (§22.1.3.23 steps 4–5).
  The row's `dynamic.order` records it, and every other row converts in parameter order.

**Run-time defaults.** Every parameter with `omitted` gets a run-time branch:
`js.extern.is_undefined(arg)` ? default : conversion.
- One function, `omittedStringMethodArgument(parameter)`, gives the default for both paths. from-ast
  calls it for a static `undefined`; `stringMethodCall` uses it for the branch.
- An undefined end of `substring`, `slice` or `endsWith` is the length.
- `lastIndexOf`'s position (`nanIsOmitted`) also takes the default when ToNumber answers NaN,
  searching from +∞. ToNumber(undefined) is NaN, so one NaN test after the conversion covers both.

**`stringMethodCall`** (`dynamic-string-methods.ts`):
1. ToString(this) by the legalization's `stringOf`, or thisStringValue for `toString` / `valueOf`.
   The receiver is never `undefined` or `null`: its [[Get]] threw first.
2. Each argument by its role, in the row's order:
   - ToString by `stringOf`;
   - a position by `toNumber`, then `i32.trunc_sat_f64_s` (ToIntegerOrInfinity clamped to i32, NaN →
     0, as from-ast does);
   - the defaults above.
3. The helper call, with its result boxed into the carrier by its role (string; number; index →
   number; boolean).

**The receiver's arms.** `stringOf` is a chain over every kind the receiver may hold, so there is no
separate generic path. Its object arm is reached by one concrete program shape, pinned in S1's
tests:
- `var s = " a "; var o = {}; o.trim = s.trim; o.trim()`: the [[Get]] of `trim` on `o` answers
  String.prototype's built-in, so the identity test matches, and ToString(o) runs.
- `o.toString = s.toString; o.toString()` reaches thisStringValue's TypeError.

**Patterns (S2).**
- `replace` and `split` use a non-object pattern literally, with no RegExpCreate, so
  `"a.b".replace(".", "x")` is `"axb"`, not a refusal.
- An object pattern first needs `GetMethod(pattern, @@replace / @@split / @@search / @@match)`.
  - **Where the method can only be absent:** an ordinary object, and the program names neither
    `Symbol` nor `RegExp`. The object's ToString follows.
  - **Where it can be present, a named compile-time `gap()`** ("an object pattern of `<method>` in a
    program that names `Symbol` / `RegExp`"). Two sources can supply it:
    - a symbol-keyed property, possible only where the program names `Symbol`, as for `instanceof`;
    - a RegExp, which carries all four methods without the program naming `Symbol`.
  - **The RegExp key.** It is `ProgramObjects.namesRegExp`, computed in `programObjects`
    (`source-plain-objects.ts`) beside `namesSymbol`: a RegExp literal, or a pristine `RegExp`
    identifier that is not a member name. This keys the refusal on the RegExp family being
    reachable, as the `errors` flag keys Error.prototype.
  - **Why the key is syntactic for now.** A member read such as `globalThis.RegExp` cannot produce a
    RegExp value on the Prepared path today: there is no RegExp provider, and `globalThis` is out of
    scope.
  - **Owner of lifting it:** [#7369](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7369-prepared-regexp).
    - When it admits a RegExp value, it widens `namesRegExp` to every construct it admits (a call,
      `new RegExp`, a global read), or replaces the flag with the realm's own "holds RegExp" fact.
    - When it serves the protocol methods on its values, it narrows the refusal to object patterns
      whose method it does not serve.
- `replace` with a string `replaceValue` calls the existing `__str_replace` (GetSubstitution, #7313).
- `replace` with a callable `replaceValue`:
  1. ToString(this), then ToString(searchValue);
  2. find the first match with `__str_indexOf`;
  3. if there is one, call the replacer through the dispatcher with `this` `undefined` and
     (matched, position, string), then ToString of its result;
  4. join the prefix, the replacement and the suffix with `__str_substring` and `__str_concat`.
- `search` and `match` go through RegExpCreate: ToString(regexp) (undefined → `""`).
  - A pattern without a RegExp syntax character matches literally: `search` is `__str_indexOf`.
  - Any other pattern is the run-time abort until
    [#7369](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7369-prepared-regexp).
- `match` and `split` results are arrays: the run-time abort after their conversions until
  [#7352](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7352-ir-object-array-literals-foundation).

### One implementation: the legacy bodies become shared pure builders

No new self-hosted definitions. Each legacy emitter in the table above is split in two:
- a pure builder in `src/runtime/wasmgc/values/` that returns `{ locals, body }` from a
  `NativeStringLayout` and a resource record of the handles it calls (other helpers, literal
  globals, table globals). This is the pattern of `buildStringFlattenDefinition` and
  `StringFlattenResources`.
- the emitter, which keeps its function minting, type registration, name and order, and calls the
  builder with its `CodegenContext` indices.

The Prepared backend calls the same builders from `native-string-methods.ts` with its reserved
handles, bound to the same intrinsic symbols. The trim family stays self-hosted. It reaches the
Prepared program through the runtime-support batch, which becomes a table with the radix batch as
one row, and through one helper-retarget table that the radix retarget joins.

**Why gc's bytes stay identical, by construction.** Each builder returns the instruction array the
emitter built in place, element for element. The extraction moves code without changing it: index
arguments become parameters, and the emitter passes the indices it computed before. Function and
type order are unchanged, because minting and `addFuncType` stay in the emitter.

**The test that proves it** (each extraction PR, result in the PR body):
- `scripts/byte-diff-corpus.mts` gains a `strings` corpus, like #7369's `regexp` corpus: every
  test262 file and playground example that calls a String.prototype method, on the default,
  standalone and wasi targets.
- It is run on the base tree and on the head, then compared with `--compare`. Required: 0 differing
  rows, and the order-dependent rows listed.
- `scripts/prove-emit-identity.mjs check` on its default corpus must report no drift.

### Target structure

| concern | module | change |
|---|---|---|
| catalog | `src/runtime/contracts/native-realm-catalog.ts` | `NATIVE_PROTOTYPE_METHODS` rows `Error.prototype` and `String.prototype`; `%String.prototype%` row |
| keys | `src/ir/program/builtin-prototype-keys.ts` | `unpopulatedKeys("String.prototype")`; `nativePrototypeMethod`, `realmMethodIdOf` |
| dispatch | `src/ir/program/dynamic-prototype-methods.ts` | candidates, identity chain, `PROTOTYPE_ALGORITHMS` |
| holding | `src/ir/program/native-realm-requirements.ts` | per-method `heldPrototypeMethods` |
| String algorithm | `src/ir/program/dynamic-string-methods.ts` (new) | `stringMethodCall` |
| roles | `src/ir/string-method-surface.ts` | new rows and roles, the `typedPath` field, `dynamic` records, `stringMethodRole`; `omittedStringMethodArgument` |
| object-pattern key | `src/ir/source-plain-objects.ts`, `src/ir/program/dynamic-value-kinds.ts` | `namesRegExp` beside `namesSymbol` |
| search bodies | `src/runtime/wasmgc/values/string-search-bodies.ts` (new) | `indexOf`, `lastIndexOf`, `includes`, `region_eq` |
| slice / char bodies | `src/runtime/wasmgc/values/string-slice-char-bodies.ts` (new) | `substring`, `charAt`, `charAt_cp`, `slice`, `substr`, `charCodeAt` |
| compare body | `src/runtime/wasmgc/values/string-compare-body.ts` (new) | `__str_compare` |
| whitespace bodies | `src/runtime/wasmgc/values/string-whitespace-bodies.ts` (new) | `__str_ws_start` / `_end` |
| replace bodies | `src/runtime/wasmgc/values/string-replace-bodies.ts` (new) | GetSubstitution, `__str_replace` |
| case bodies | `src/runtime/wasmgc/values/string-case-bodies.ts` (new) | case mapping and its table globals |
| case tables | `src/codegen/case-tables.ts` → `src/runtime/wasmgc/values/case-tables.ts` (`git mv`) | generated data; `scripts/gen-case-tables.mjs` writes the new path |
| flatten preamble | `src/runtime/wasmgc/values/string-flatten-bodies.ts` | `wrapBodyWithFlatten` becomes a builder here |
| Prepared resources | `src/backend/wasmgc/resources/native-string-methods.ts` (new) | reserves and binds the helpers above |
| support batches | `src/frontend/builtins/prepare-number-format.ts` → `prepare-runtime-support.ts` (`git mv`); `runtime-support.ts`; `program-codec.ts` | a batch table: radix, trim family |
| retarget | `src/ir/program/number-to-string-target.ts` → `prepared-helper-targets.ts` (`git mv`) | one table: radix, trim family |

**Boundaries** (`scripts/compiler-boundaries.json`, in the same PR as each module, classification
copied from its siblings):
- **`files` entries:**
  - `src/ir/program/dynamic-string-methods.ts`: `{ "state": "clean", "layer": "ir-program" }`, as
    `dynamic-prototype-methods.ts`;
  - `src/ir/program/prepared-helper-targets.ts`: the same, as `number-to-string-target.ts`;
  - `string-search-bodies.ts`, `string-slice-char-bodies.ts`, `string-compare-body.ts`,
    `string-whitespace-bodies.ts`, `string-replace-bodies.ts`, `string-case-bodies.ts` and
    `case-tables.ts` (all under `src/runtime/wasmgc/values/`):
    `{ "state": "clean", "layer": "native-runtime" }`, as `string-flatten-bodies.ts` and
    `string-concat-bodies.ts`;
  - `src/backend/wasmgc/resources/native-string-methods.ts`:
    `{ "state": "clean", "layer": "backend-wasmgc" }`, as `native-string-flatten.ts`;
  - `src/frontend/builtins/prepare-runtime-support.ts` keeps `prepare-number-format.ts`'s
    classification (`mixed-needs-split`, destination `frontend-ts`, owner `3518-coordinator`): it
    still reads the `src/stdlib` templates.
- **Layer entries:** the native-runtime modules join `layers[native-runtime].entries`, with an
  `activationHistory` record (`{ layer, entries, minModules }`, as `string-concat-bodies.ts`'s). The
  backend module joins `layers[backend-wasmgc].entries`.
- **Moves:** each `git mv` gets a `moves` record (`{ from, to }`).
- Run `npm run check:compiler-boundaries` before each commit.

**Duplicates removed:**
- the `STRING_PROTOTYPE` hand list;
- #7480's per-method `switch` cases, per-parent lookups and union names;
- the `toString` / `errors` special case and the `at(-1)` index;
- the omitted defaults (one function, two callers);
- the one-batch codec rule and the radix-only retarget;
- a second implementation of any String method: the Prepared lane calls the legacy bodies' builders.

**Not built here, named:**
- a built-in called through a plain value (#7354 P2): a detached `var h = s.trim; h()` or
  `String.prototype.trim.call(o)` keeps the dispatcher's run-time abort;
- `String` as a value (#7354 V1);
- a String object's own `length` and indices (#7352).

### Decisions

1. **Per-method holding** lands in the shared-dispatch step, as a change of granularity of #7480's
   `heldPrototypeMethods`. Holding String.prototype per prototype would put 24 entries in every
   program that reads one key, and `indexOf` / `slice` / `concat` are Array keys too.
2. **`toString` / `valueOf`** take thisStringValue (a non-string throws a TypeError); every other
   method takes ToString(this).
3. **`localeCompare`** answers code-unit order through `__str_compare`. This conforms, because
   §22.1.3.12 leaves the order implementation-defined. A test pins antisymmetry and `0` for equal
   strings, not V8's ICU order.

### Slices

**Every slice:**
- the named files pass in the census on the slice's head;
- the full ES5 census (8,717 positive files) shows no pass → non-pass against the base;
- standalone only;
- refusal at select only: an unsupported sub-case is a named `gap()` or the run-time abort, never a
  claim that is withdrawn;
- the byte-identity proof above for every extraction.

**S1: plain methods (34 files, measured stand-in).**
1. The shared dispatch (after #7480).
2. The catalog row and `unpopulatedKeys`.
3. The search, slice / char, compare and whitespace extractions.
4. The Prepared resources; the trim batch and retarget rows.
5. The role rows and `omittedStringMethodArgument`.
6. `stringMethodCall`.
7. S1b: the case extraction and its four methods.

Native methods: `trim`, `trimStart`, `trimEnd`, `indexOf`, `lastIndexOf`, `includes`, `startsWith`,
`endsWith`, `substring`, `slice`, `charAt`, `charCodeAt`, `concat`, `toString`, `valueOf`,
`localeCompare`, then the four case methods.

Tests:
- each method on a string receiver;
- the object-receiver program above, and the thisStringValue TypeError;
- conversion order: receiver, then arguments, and a throw stops the rest;
- a run-time `undefined` end for `substring`, `slice` and `endsWith`;
- `lastIndexOf` with NaN and with `undefined`;
- variadic `concat`;
- `trim` over every WhiteSpace and LineTerminator code point;
- `localeCompare` antisymmetry;
- the predicates-unchanged pin;
- a user-written `o.trim = …` (not the built-in) takes the dispatcher, and a detached call still
  aborts.

**S2: `replace`, `search`, `match`, `split` (8 files, measured stand-in).**
1. The replace extraction.
2. The `limit`, `replacer` and `literal-pattern` roles; `ProgramObjects.namesRegExp`.
3. The four algorithms above.

Tests:
- `"a.b".replace(".", "x")`;
- a function replacer's arguments and `this`, and ToString of its result;
- a non-callable `replaceValue` converted before the search;
- `$` patterns through GetSubstitution;
- `split`'s limit before its separator, and undefined limit;
- `search` with a literal and with a RegExp-syntax pattern (the abort);
- `match` / `split` conversions before their abort;
- the object-pattern refusal, pinned with a RegExp-literal pattern:
  - `"abc".replace(/b/, "x")`, `"a,b".split(/,/)`, `"abc".search(/b/)` and `"abc".match(/b/)` must
    each refuse, and never search the literal text `"/b/"`;
  - today the literal's own refusal (no RegExp provider) comes first; the test accepts either that
    refusal or this issue's named gap, so it keeps holding when #7369 admits the literal;
  - the same four with an ordinary-object pattern in a program that names `Symbol` refuse by name;
  - with an ordinary-object pattern in a program that names neither, they run ToString.

### Acceptance criteria

**Correctness:**
- S1's 34 and S2's 8 files pass in the census.
- No pass → non-pass on the full ES5 census.
- The completed-edition ratchet stays green.
- The byte-identity proof: 0 differing rows in the `strings` corpus on default, standalone and wasi.

**Code quality:**
- one prototype-method pattern (the API above) for the Object, Function, Error and String
  prototypes;
- no per-key branch in `dynamic-member-access.ts` and no per-method `case`;
- one role table for the typed and the dynamic path, whose old answers are pinned;
- one implementation of every String method body, used by both pipelines;
- String.prototype keys from the catalog;
- one runtime-support batch table and one retarget table;
- the `compiler-boundaries.json` entries above;
- new modules sibling-shaped and within the loc / func budgets without a grant;
- an adversarial review verdict in each PR body.

### Hazards

- **Byte identity:** an extraction that reorders minting or type registration changes gc output. The
  corpus compare catches it; keep the minting in the emitter.
- **Prepared output changes:** Error.prototype's selector moves. Prepared-only pins that name
  selector numbers need updating in the shared-dispatch step.
- **Realm size:** held String methods are entries initialised with the realm. Use per-method holding
  and check `scripts/check-harness-compile-budget.ts`.
- **The M1 premise** (no Prepared program can change a built-in prototype) carries the identity
  test's soundness for primitives. Extend its test to String.prototype, and revisit it when `String`
  becomes a value.
- **Stand-in limits:** argument conversions were not replayed by the stand-in. The S1 / S2 tests
  cover them.

## Follow-up: separate issue (id to be allocated)

Typed string receivers: 136 ES5 files stop at compile time on
`method call .m(...) on string not in slice 4`, because the Prepared resolver gives from-ast no
`stringMethodPlan`.

| | value |
|---|---|
| count in the 2026-11-26 census (`main-6694a8b8-real.jsonl`, main `6694a8b8`) | 136 |
| count on `1a726b3e` (re-measured 2026-11-26) | 136 |
| pass behind the wall with the same stand-in (measured; unreached sites given a placeholder so that they compile) | 113 |

- **By method:** `trim` 56, `indexOf` 11, `charAt` 9, `replace` 8, `toLocaleLowerCase` 8,
  `toLocaleUpperCase` 6, `search` 5, others ≤ 4.
- **The 23 non-passes:**
  - `split` / `match` array results 8;
  - `unknown class "String"` 4;
  - a computed-key read 4;
  - an uncaught throw in `10.4.3-1-100gs` / `-102gs` 2;
  - `JSON` not in scope 2;
  - others 3.
- It reuses this issue's helpers and retarget table, so it comes after S1.

## Reproduce

The rows and the stand-in rewriters are kept locally under `.tmp/7517/` of the worktree that wrote
this file (gitignored).

```bash
git worktree add .claude/worktrees/main-7517 origin/main      # 1a726b3e
# link node_modules and test262 into it, then, from the #7486 branch:
npx tsx scripts/ir-census/prepared-census.mts --tree <main-7517> --files str42.txt \
  --out main-str42.jsonl --harness real --jobs 3
# stand-in: rewrite into a scratch tree (src, tests and test262/harness symlinked), census with --tree
node strings-all.cjs str42.tsv <main-7517>/test262/test <scratch-tree> report.jsonl
```

Delete the census `--out` file before a re-run: the script resumes from it.
