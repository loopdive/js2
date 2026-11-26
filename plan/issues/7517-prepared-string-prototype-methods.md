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
related: [7486, 7489, 7354, 7352, 7369]
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
which covers them: slice A PR #7449, slice B PR #7480, slice C (`bind`, with its own
`bound-function-bodies.ts`) under plan review on `claude/s20-fn-bind` at `fd56edfd`. For the record
only, the stand-in measurement made for this issue on main `1a726b3e` (2026-11-26) found, of 84
Function.prototype files (73 abort bodies of census row 4 and 11 kind aborts): `caller` /
`arguments` 43 pass with a stand-in, `call` / `apply` 22 of 25 (3 need the global object as a
sloppy `this`), `bind` 15 of 15, and `Error/length.js` 1 not served (it needs %Function% as a
value).

## Measured (main `1a726b3e`, 2026-11-26)

Head `1a726b3e` (merge of PR #7348), confirmed with `git ls-remote origin refs/heads/main` at
12:25 UTC. Census: `scripts/ir-census/prepared-census.mts --harness real --jobs 3`, the script from
the #7486 branch (it records the trap frame), run with `--tree` on a worktree of that head.

- **Current verdict:** all 42 fail, trapping in `__js_value_unsupported` (42 / 42, re-run at 12:25 UTC).
- **Stand-in:** each `recv.m(args)` (m a String.prototype method) was run in node with the harness.
  A site whose every execution had a primitive string receiver and one primitive answer (or one
  primitive throw) became that literal; the census then re-ran on the rewritten file. A pass means
  nothing else in the file blocks it: an **upper bound**, which assumes the method answers
  correctly. Argument conversions' side effects are not replayed (the slice tests cover them).
  - 41 / 42 pass with String.prototype `toString` and `valueOf` left as they are; 42 / 42 once
    `toString` is stood in too (`trim/15.5.4.20-1-8.js` also calls `strObj.toString()`).
- Each file reaches exactly one method (two in `15.5.4.20-1-8.js`).

| slice | methods (files) | files | stand-in pass (measured) |
|---|---|---:|---:|
| S1 plain methods | `trim` 11, `indexOf` 3, `lastIndexOf` 3, `substring` 3, `slice` 3, `charAt` 2, `charCodeAt` 2, `concat` 2, `toUpperCase` 1, `toLowerCase` 1, `toLocaleUpperCase` 1, `toLocaleLowerCase` 1, `localeCompare` 1 (`toString` in one `trim` file) | 34 | 34 |
| S2 pattern or callback | `replace` 3, `search` 3, `match` 1, `split` 1 | 8 | 8 |
| **total** | | **42** | **42** |

**At risk (estimated):** `trim` 11 (needs the full WhiteSpace and LineTerminator set; the
self-hosted `isWs` of `src/stdlib/strings.ts` covers it per #1963), case mapping 4 (needs the
Unicode case tables), `localeCompare` 1 (needs decision 2). A delivered figure below 42 is
expected for any of these that ships late.

**S2's 8 files stop before a RegExp or an array is needed:** `search` / `replace` take a pattern
whose ToString holds no RegExp syntax (`"AB"`, `"null"`) or throws; `match` and `split` throw in an
argument conversion before their array result.

## Implementation Plan

### What exists (`1a726b3e`, plus #7489 slices A and B)

- **Member read** (`src/ir/program/dynamic-member-access.ts`): a primitive's arm answers
  Object.prototype's native method (`realmIntrinsic`) or `undefined`. A key in
  `BUILTIN_REACHABLE_KEYS.string` (`builtin-prototype-keys.ts`) that no kind answers is a `gap()`;
  where another kind answers, the string arm is the run-time abort.
- **String.prototype keys** are a hand list (`STRING_PROTOTYPE`, beside `NUMBER_PROTOTYPE`) in
  `builtin-prototype-keys.ts`: the catalog (`src/runtime/contracts/native-realm-catalog.ts`) has no
  String.prototype row. #7489 keeps the list (all three of its branches).
- **Method call of a realm method** (#7354 P1, G1; `dynamic-prototype-methods.ts`): for `o.m(v)`
  whose callee is the [[Get]] of `m` on the same receiver, the call compares the callee with the
  realm's built-in (`js.value.strict_eq` against `js.object.intrinsic(selector)`), runs the method's
  algorithm at the site when they are the same, and otherwise takes the dispatcher.
- **#7489 slice B's shape** (PR #7480, `claude/s20-fn-call-apply` at `38ef5af6`):
  - catalog: `NATIVE_PROTOTYPE_METHODS`, a record from prototype to its native method names
    (`"Object.prototype"`, `"Function.prototype"`), from which `NATIVE_VALUE_INTRINSICS` and
    `NATIVE_MEMBERS` are derived;
  - keys: `unpopulatedKeys(parent)`, the catalog keys of `parent` that the realm does not hold as
    methods, in place of a hand-filtered set;
  - realm (`native-realm-requirements.ts`): `PROTOTYPE_METHODS` / `heldPrototypeMethods` hold all
    of a prototype's native methods where one is read;
  - IR: `RealmMethod` is a union of names (`"isPrototypeOf"`, `"Error.prototype.toString"`,
    `` `Function.prototype.${name}` ``); `prototypeMethodOfCall` picks one parent per name;
    `methodId` and the algorithm are a `switch` with one case per method; and lookups are
    per-parent functions (`nativeObjectPrototypeMethod`, `nativeFunctionPrototypeMethod`).
- **Typed string methods** (`src/ir/string-method-surface.ts`, `stringMethodPlan`): the one table
  of argument roles (ToString / ToIntegerOrInfinity), omitted defaults and results. Its helpers
  (`__str_trim`, `__str_indexOf`, …) are legacy runtime functions. The self-hosted ones
  (`src/stdlib/strings.ts`) call legacy kernels (`__str_flatten`, `__str_region_eq`,
  `__str_ws_start` / `_end`, `charCodeAt`, `__str_substring`). The Prepared backend has only
  `__str_flatten`, concat, equality, number conversion and literals.
- **Runtime support** (`runtime-support.ts`, `prepare-number-format.ts`, `program-codec.ts`,
  `number-to-string-target.ts`): the Prepared program carries one self-hosted IR body, the radix
  formatter (`number-format-radix-v1`), and retargets the ordinary pipeline's helper call to it. The
  codec accepts exactly one batch, of that kind.

### How the String table matches #7489's shape

**The catalog and key layers take strings as they are:**
- `NATIVE_PROTOTYPE_METHODS` gains `"String.prototype": NATIVE_STRING_PROTOTYPE_METHODS`, so
  `NATIVE_VALUE_INTRINSICS`, `NATIVE_MEMBERS` and the realm's holding rule follow with no new code;
- the catalog gains a `%String.prototype%` row with its method rows;
- `STRING_PROTOTYPE` becomes `unpopulatedKeys("String.prototype")`, which removes the hand list.

**The IR dispatch layer cannot serve strings unchanged, for three reasons:**
1. **One `case` per method.** S1 and S2 make 24 String.prototype methods native, and every one runs
   the same algorithm, parameterised by its `stringMethodPlan` row. Twenty-four `case`s in `methodId` and in
   the algorithm `switch` would be the per-method branching this issue removes.
2. **One parent per name.** `prototypeMethodOfCall` maps a name to one parent. Once strings are
   native, `toString` / `valueOf` name String.prototype's method and (later) Object.prototype's,
   and `toString` already names Error.prototype's, which #7354 G1 special-cases with the `errors`
   flag. Which one a call reads is known only at run time, from the value its [[Get]] answered.
3. **A lookup function per parent.** `nativeObjectPrototypeMethod`, `nativeFunctionPrototypeMethod`
   and a third for strings would be three copies of `nativeLength(parent, name)`.

**Proposed shared shape** (one pattern for every prototype; #7489's rows move into it unchanged in
behaviour):
- `RealmMethod = { parent: NativePrototype | "Error.prototype"; name: string }`;
  `methodId = realmMethodId(parent, name)`, with no `switch`.
- `nativePrototypeMethod(parent, name)` replaces the per-parent lookups.
- `prototypeMethodOfCall` answers the candidates: every parent whose native list holds the
  constant key, with Error.prototype's `toString` only where the program holds the Error family.
- `dynamicPrototypeMethodCall` tests the callee against each candidate's built-in in turn: the
  first match runs that parent's algorithm, and no match takes the dispatcher. With one candidate
  this is today's single identity test. The `errors` special case becomes a candidate row.
- `PROTOTYPE_ALGORITHMS: Record<parent, (b, call, name, result) => IrInstr[]>`, one builder per
  parent, each in its own module, in the shape of `ownProperty` / `prototypeOf`:
  - `"Object.prototype"`: today's `ownProperty` / `prototypeOf`;
  - `"Function.prototype"`: #7489's `invoke` / `apply`;
  - `"Error.prototype"`: `js.object.error-to-string`;
  - `"String.prototype"`: `stringMethodCall` in the new `dynamic-string-methods.ts`.
- **The holding rule becomes per method.** `heldPrototypeMethods` holds all of a prototype's
  methods once one is read. For String.prototype that means 24 entries, and `slice`, `indexOf` and
  `concat` are Array keys too, so a program that reads `a.indexOf` on a dynamic value would hold
  the whole family. Per method is finer and as sound for Object.prototype and Function.prototype.

**Coordination:** the shape change touches #7489's slice B lines. Land it as S1's first step after
#7480 merges, or offer it to #7489's slice C. Either way it is one change to one shared module, not
a second pattern.

### Target structure

| concern | module | change |
|---|---|---|
| catalog | `src/runtime/contracts/native-realm-catalog.ts` | `%String.prototype%` row and method rows; `NATIVE_STRING_PROTOTYPE_METHODS` (per slice) in `NATIVE_PROTOTYPE_METHODS` |
| keys | `src/ir/program/builtin-prototype-keys.ts` | `STRING_PROTOTYPE` hand list replaced by `unpopulatedKeys("String.prototype")`; one `nativePrototypeMethod(parent, name)` |
| primitive read | `dynamic-member-access.ts` | the primitive arm answers the wrapper prototype's native method, then Object.prototype's, then `undefined`: one lookup by parent, no per-key branch |
| dispatch | `dynamic-prototype-methods.ts` | the shared shape above: candidates, identity chain, `PROTOTYPE_ALGORITHMS` |
| String algorithm | `dynamic-string-methods.ts` (new) | `stringMethodCall(b, call, name, result)`, driven by the `stringMethodPlan` row |
| omitted arguments | `string-method-surface.ts` | one function for an omitted argument's value, called by from-ast's `omittedStringMethodArgument` and by `stringMethodCall` |
| bodies | `src/stdlib/strings.ts`; runtime support (`runtime-support.ts`, `prepare-number-format.ts` → a batch table, `program-codec.ts`) | new self-hosted defs (`indexOf`, `lastIndexOf`, `substring`, `slice`, `charAt`, `charCodeAt`, `concat`, then case mapping); one batch kind per self-hosted family, with the radix batch as one row |
| helper binding | `number-to-string-target.ts` → one retarget table | the helper symbol (`__str_trim`, …) maps to the Prepared support function; the radix retarget is one row |
| kernels | shared pure builders in `src/runtime/wasmgc/values/` | the code-unit read, the flat substring, `__str_region_eq`, `__str_ws_start` / `_end`, moved from the legacy emitters (`native-strings-search.ts`, `native-strings-ws.ts`, `char-code-at-helpers.ts`); both pipelines call them, as they already call `__str_flatten`'s |

**The String algorithm** (`stringMethodCall`):
- ToString(this) by the legalization's `stringOf` (an object receiver runs its `toString`; see
  decision 3 for `toString` / `valueOf`). The receiver is never `undefined` or `null`: its [[Get]]
  threw first.
- Each argument converted by its `stringMethodPlan` role: ToString by `stringOf`; a position by
  `toNumber`, then `i32.trunc_sat_f64_s`. That is ToIntegerOrInfinity clamped to i32 with NaN → 0,
  the same as from-ast.
- Omitted arguments from the shared default function.
- The helper call, with the result boxed into the carrier by its role (string, number, index →
  number, boolean).

**Duplicates removed:**
- the `STRING_PROTOTYPE` hand list;
- the per-method `switch` cases and per-parent lookups (Object.prototype's and Function.prototype's
  included);
- the `errors` special case for `toString`;
- the omitted-argument defaults (one function, two callers);
- the one-batch codec rule and the radix-only retarget;
- the legacy kernel emitters' hand `Instr[]`.

**Not built here, named:**
- a built-in called through a plain value (#7354 P2): a detached `var h = s.trim; h()` or
  `String.prototype.trim.call(o)` keeps the dispatcher's run-time abort;
- `String` as a value (#7354 V1);
- a String object's own `length` / indices
  ([#7352](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7352-ir-object-array-literals-foundation)).

### Decisions to settle in review before code

1. **Holding granularity:** per method (proposed above) or #7489's per prototype.
2. **`localeCompare` without ECMA-402:** code-unit order conforms (§22.1.3.12 leaves the order
   implementation-defined), but it differs from V8. ICU gives `"h".localeCompare("H") === -1`; code
   units give 1. Either refuse by name (1 file lost), or answer code-unit order with a test that pins
   only what ES requires (antisymmetry, `0` for equal strings).
3. **`toString` / `valueOf`** are not generic (thisStringValue): a non-string receiver throws a
   TypeError. Every other S1 method takes ToString(this).

### Slices

**Every slice:**
- the named files pass in the census on the slice's head;
- the full ES5 census (8,717 positive files) shows no pass → non-pass against the base head;
- standalone only;
- refusal at select only: an unsupported sub-case is a named `gap()` or the existing run-time
  abort, never a claim that is withdrawn.

**S1: plain methods (34 files, measured stand-in).**
- Steps:
  1. The shared dispatch shape (after #7480).
  2. The catalog row and `unpopulatedKeys`.
  3. Kernels as shared pure builders. List the closed set the defs call, and fail loudly on any
     other.
  4. The support batch table and retarget table.
  5. The self-hosted defs.
  6. `stringMethodCall`.
  7. S1b, case mapping: a self-hosted body over the generated `case-tables.ts` data.
- Native methods: `trim`, `trimStart`, `trimEnd`, `indexOf`, `lastIndexOf`, `includes`,
  `startsWith`, `endsWith`, `substring`, `slice`, `charAt`, `charCodeAt`, `concat`, `toString`,
  `valueOf`, `localeCompare` (decision 2), then the four case methods.
- Tests:
  - each method on a string receiver, and on an object receiver with `toString` (the generic path);
  - conversion order: receiver first, then each argument, and a throw stops the rest;
  - omitted and `undefined` arguments; `lastIndexOf` with a NaN position;
  - `trim` over every WhiteSpace and LineTerminator code point;
  - `toString` on a non-string receiver throws;
  - a user-written `o.trim = …` takes the dispatcher; a detached call still aborts.

**S2: `replace`, `search`, `match`, `split` (8 files, measured stand-in).**
- A pattern converted by ToString at run time matches literally only when it holds no RegExp syntax
  character. Otherwise it is the run-time abort until
  [#7369](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7369-prepared-regexp).
- `replace` with a function replaceValue calls it through the dispatcher (match, position,
  string).
- `match` and `split` results are arrays: the run-time abort until #7352. The 2 files here throw in
  a conversion before that.

### Acceptance criteria

**Correctness:**
- S1's 34 and S2's 8 files pass in the census.
- No pass → non-pass on the full ES5 census.
- The completed-edition ratchet stays green.
- JS-environment (gc) output is byte-identical on the equivalence corpus and the playground
  examples. Compare the binaries before and after, as #7486 did: the legacy emitters now call the
  shared kernel builders.

**Code quality:**
- one prototype-method pattern for Object, Function, Error and String prototypes, as proposed above;
- no per-key branch in `dynamic-member-access.ts`, and no per-method `case`;
- one argument-role table (`string-method-surface.ts`) for the typed and the dynamic path;
- String.prototype keys come from the catalog;
- one runtime-support batch mechanism and one helper-retarget table;
- every kernel is a pure builder used by both pipelines;
- new modules are sibling-shaped and within the loc / func budgets without a grant;
- an adversarial review (fresh context, given the diff and this plan) records its verdict in each PR
  body.

### Hazards

- **Byte identity** of the legacy emitters that move to shared builders: compare binaries, not
  verdicts.
- **Realm size:** each held String method is an entry initialised with the realm. Check the holding
  rule (decision 1) and the harness-compile budget (`scripts/check-harness-compile-budget.ts`).
- **The M1 premise** carries the identity test's soundness for primitives: no Prepared program can
  change a built-in prototype. Extend the premise test to String.prototype, and revisit it when
  `String` becomes a value.
- **Stand-in limits:** the stand-ins do not replay argument conversions (e.g. `split`'s `valueOf`
  order). The S1 / S2 tests cover them.

## Follow-up: separate issue (id to be allocated)

Typed string receivers: 136 ES5 files stop at compile time on
`method call .m(...) on string not in slice 4`, because the Prepared resolver gives from-ast no
`stringMethodPlan`. Sources and figures:
- 136 in the 2026-11-26 census `main-6694a8b8-real.jsonl` (main `6694a8b8`); still 136 on
  `1a726b3e` (re-measured 2026-11-26).
- With the same stand-in (unreached sites given a placeholder so that they compile), **113 pass
  behind the wall** (measured).
- By method: `trim` 56, `indexOf` 11, `charAt` 9, `replace` 8, `toLocaleLowerCase` 8,
  `toLocaleUpperCase` 6, `search` 5, others ≤ 4.
- The 23 non-passes: arrays from `split` / `match` 8, `unknown class "String"` 4, a computed-key read
  4, an uncaught throw in `10.4.3-1-100gs` / `-102gs` 2, `JSON` not in scope 2, others 3.
- It reuses this issue's support bodies and retarget table, so it comes after S1.

## Reproduce

The rows and the stand-in rewriters are kept locally under `.tmp/7517/` of the worktree that wrote
this file (gitignored).

```bash
git worktree add .claude/worktrees/main-7517 origin/main      # 1a726b3e
# link node_modules and test262 into it, then, from the #7486 branch:
npx tsx scripts/ir-census/prepared-census.mts --tree <main-7517> --files str42.txt \
  --out main-str42.jsonl --harness real --jobs 3
# stand-in: rewrite into a scratch tree (src, tests and test262/harness symlinked), census with --tree
node strings.cjs str42.tsv <main-7517>/test262/test <scratch-tree> report.jsonl
```

Delete the census `--out` file before a re-run: the script resumes from it.
