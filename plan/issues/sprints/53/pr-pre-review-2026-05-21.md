# PR Pre-Review — 2026-05-21

Reviewer: senior-developer (claude). Pre-CI spec-correctness + merge-order audit
of all 13 pending PRs (#453–#468) plus a duplicate-work note for #449 / #450.

## Merge order recommendation

Merge in this order (lowest-risk + dependency-respecting first; large-touch PRs
last so smaller fixes don't have to re-merge them):

1. **#465** — docs-only runbook. Zero conflict risk.
2. **#467** — doc-only investigation note for #779b. Zero conflict risk.
3. **#463** — `#1560` closed as covered-by; doc + test only. No src changes.
4. **#457** — `src/resolve.ts` only (#1559). Isolated file, no overlap.
5. **#458** — `src/codegen/statements/variables.ts` only (#820c). Isolated.
6. **#466** — `src/codegen/array-methods.ts` only (#1522). Isolated.
7. **#462** — `src/codegen/binary-ops.ts` (#1558). Pick this OVER #450 (see
   below). Touches only binary-ops.ts.
8. **#453** — `src/codegen/destructuring-params.ts` only (#1553a). Refactor
   that #464 depends on (threads `DestructureMode`/`BindingKind`).
9. **#464** — `src/codegen/statements/destructuring.ts` (#1553b). Depends on
   #453's exported types; merge after it.
10. **#454** — `src/codegen/literals.ts` (#1553e). Touches `_isUndefinedLike`
    + `compileArrayLiteral`; orthogonal to #455/#461/#451 hunks but rebase
    will likely just succeed.
11. **#451** — `src/codegen/literals.ts` (#820b). Tiny ComputedPropertyName fix
    in `compileObjectLiteralWithAccessors` — different region from #454/#461.
12. **#452** — `src/codegen/literals.ts` (#1151 Gap B). Two small hunks in
    `compileObjectLiteralForStruct` — different region from #451/#454/#461.
13. **#461** — `src/codegen/literals.ts` (#1557). Larger fork-by-arity pre-pass
    + per-literal funcIdx routing. Merge AFTER the three smaller literals.ts
    PRs to minimise rebase pain. **Reject #449** (duplicate, riskier approach).
14. **#460** — `src/codegen/expressions/calls.ts` + `src/runtime.ts` (#1129
    Object(x) auto-boxing). Adds an `Object()` peephole near the `RegExp`
    one; rebase trivially over #455.
15. **#455** — `src/codegen/expressions/calls.ts` + `src/codegen/literals.ts`
    + `src/runtime.ts` (#820a RegExp Symbol.*). Touches three files but
    each hunk is in its own region; rebase risk small but non-zero.
16. **#468** — `src/codegen/index.ts` + `src/runtime.ts` (#779c split
    constructor). The `extern_get` runtime branch is right next to where
    #456 wants to edit — merge #468 first so #456 rebases onto a known
    text region.
17. **#459** — `src/codegen/builtin-tags.ts` + `src/codegen/class-bodies.ts`
    + `src/runtime.ts` (#1455 builtin subclassing). Largest runtime.ts diff
    in this set; merge late so smaller runtime.ts touches don't have to
    rebase across it.
18. **#456** — `src/runtime.ts` only (#1352 host_eq normalize). **HOLD —
    contains a real bug** (`intent.kind === "host_loose_eq"` will never be
    true; the discriminator is `intent.type`). Loose equality silently
    falls through to the SameValueZero comparator, breaking `null ==
    undefined`. Bounce back to the dev with `## Spec bug` flag below
    before merging.

If CI lands all green simultaneously and you want a one-shot wave, you can
also batch the truly isolated set first — #463, #465, #467, #457, #458,
#466, #462, #453 — then queue the literals.ts cluster (#454, #451, #452,
#461) and finally the runtime.ts cluster (#460, #455, #468, #459) with
#456 held out for the bug fix.

## Per-PR findings

### PR #468 — fix(#779c): String.prototype.split result `.constructor === Array`
- **Verdict**: ✓ looks correct (minor: sandbox-specific behaviour)
- **Spec section**: §22.1.3.1 / §22.1.3.24 — `String.prototype.split` returns
  an Array whose `.constructor` is the realm's `%Array%` intrinsic.
- **Concerns**:
  - The fix is sandbox-aware: only substitutes `globalSandbox.Array` when
    a `globalSandbox` is supplied. That's exactly what test262's per-test
    realm isolation needs.
  - Edge: if `globalSandbox` exposes `Array` but the test mutated it
    (`sandbox.Array = function(){}`), this returns the mutated version —
    which is the spec-correct behaviour (Realm-bound).
  - Adding `__extern_get` to the emit-trigger set for `emitVecAccessExports`
    is sound, but verify the existing `if (!ctx.funcMap.has("__iterator")…)`
    gate did not previously guarantee `__vec_len` existed for every
    `__extern_get` callsite. If a standalone-mode caller imports
    `__extern_get` without ever needing vec access otherwise, this enlarges
    the emit set slightly — measurable as a small `.wasm` size increase.
- **Conflict risk**: shares `src/runtime.ts` with #455, #456, #459. The
  `extern_get` branch (line ~4673) is editted by #468; #456 edits the
  `host_eq` / `host_loose_eq` block at line ~4706 — adjacent but disjoint.

### PR #467 — plan(#779b): investigation — real cause is #1364b prototype-chain
- **Verdict**: ✓ documentation only.
- **Concerns**: none. Findings section in the issue file correctly reroutes
  the bug to instance prototype-chain (`getPrototypeOf` returning
  `Object.prototype` instead of class prototype). Recommend the architect
  pick up the proposed `__register_instance_prototype` fix next sprint.
- **Conflict risk**: none.

### PR #466 — fix(#1522): Array filter/map/reduce void-callback stack underflows
- **Verdict**: ✓ correct
- **Spec section**: §23.1.3.{filter, map, reduce, reduceRight} — callback
  return value is treated as ToBoolean (filter), used as element (map), or
  becomes the accumulator (reduce). `undefined` callbacks are spec-legal.
- **Concerns**:
  - `buildTruthyCheck` pushes `i32.const 0` for void returns (undefined →
    falsy → element dropped). Correct.
  - `buildFalsyCheck` pushes `i32.const 1` (callback's value WAS falsy).
    Correct.
  - `compileArrayMap` falls back to `defaultValueInstrs(mapResultElemType)`
    when the callback is void — comment notes that for i32 element type
    the result is `0` rather than spec's `NaN`. That's an acceptable
    deviation since the underlying element-type is i32 by static
    inference (true `undefined` mapping would need a vec of externref or
    f64). Per the test file: explicitly documents the gap.
  - For `reduce`, the accumulator becomes the default value of the
    accumulator's numeric kind (`NaN` for f64, `0` for i32). Spec would
    have it be `undefined`, but again the static typing constrains this.
- **Conflict risk**: only touches `src/codegen/array-methods.ts`. Isolated.

### PR #465 — docs: runbook for self-hosted Mac mini test262 runner
- **Verdict**: ✓ docs-only.
- **Concerns**: none on correctness. The trust-boundary section is
  thoughtful; recommend cross-linking from `.github/workflows/test262-sharded.yml`
  before flipping any matrix entries to `self-hosted`.
- **Conflict risk**: none.

### PR #464 — fix(#1553b): delegate typed-struct object decl to destructureParamObject
- **Verdict**: ✓ correct, with one architectural caveat
- **Spec section**: §14.3.3 DestructuringAssignmentEvaluation + §13.15.5.2
  KeyedDestructuringAssignmentEvaluation. Defaults must fire when the
  property value is `undefined`, including for nested patterns
  (`{w:{x,y,z}={...}}={w:undefined}`).
- **Concerns**:
  - **Depends on #453** — uses `BindingKind`, `destructureParamObject`,
    `ensureLateImport`, `flushLateImportShifts` (the latter two also added
    by this PR's import). Merge #453 first.
  - Pre-trigger of `__throw_type_error` via `ensureLateImport` is correctly
    ordered before the helper builds its body — comment in the PR
    explains why the late-import shift cannot reach instructions that
    haven't been appended to `fctx.body` yet.
  - Rest-element fallthrough: rest binding (`{a, ...r}`) bypasses the
    helper because the typed-struct fast path can't enumerate own
    properties. Routed through the externref path, which is spec-correct
    via `__extern_rest_object`. Good.
  - `bindingKind` derivation: `decl.parent.flags & ts.NodeFlags.Const` /
    `& ts.NodeFlags.Let` — correct for the typical `let { ... } = obj`
    case. Confirm `decl.parent.flags` is the VariableDeclarationList flags,
    not VariableStatement — verified: VariableDeclaration's parent IS
    VariableDeclarationList.
  - Lost 194 lines of inline destructuring code — much of it duplicated
    null-guard / nested-pattern logic. The helper now owns the
    edge-case-handling; positive simplification.
- **Conflict risk**: shares `src/codegen/statements/destructuring.ts` with
  no other pending PR. Depends on #453 exports.

### PR #463 — test(#1560): close as covered-by #1559; pin 3-hop CJS class re-export
- **Verdict**: ✓ correct (test-only, no codegen)
- **Concerns**: depends on #457 being merged for `#1560` smoke results to
  be reproducible. Merge order: #457 → #463 (already reflected above).
- **Conflict risk**: none — docs + tests only.

### PR #462 — fix(#1558): widen LEFT i32 operand to f64 in legacy === branch
- **Verdict**: ✓ correct, **prefer this over #450**
- **Spec section**: §7.2.15 Strict Equality / §7.2.14 Loose Equality. JS
  has only Number; the i32/f64 split is a compilation detail. Both
  operands must reach the same numeric Wasm type before `f64.eq`.
- **Concerns**:
  - Three-case dispatch is exhaustive: (both i32) (only left i32) (only
    right i32). The (both i32) path correctly preserves order with a
    temp local — easy to reason about.
  - Test coverage is excellent (11 cases including the ESLint shape).
  - Alternative #450 would stay in i32 for both-i32 case and use
    `i32.eq` — slightly faster, but it widens the divergence with the
    IR path (which uses f64.eq for the same expression). #462's "always
    widen to f64" approach is more consistent with the surrounding
    `compileNumericBinaryOp` and easier to audit.
- **Conflict risk**: ONLY touches `src/codegen/binary-ops.ts`. Conflicts
  with PR #450 (duplicate work — close #450).

### PR #461 — fix(#1557): per-literal funcIdx for trampoline arity mismatches
- **Verdict**: ✓ correct, **prefer this over #449**
- **Spec section**: not a spec issue per se — this is a compiler
  data-structure bug where TS structural type dedup collapses two
  literals with differently-arity methods into one struct hash, then
  their bodies overwrite each other.
- **Concerns**:
  - Approach: pre-scan the literal's methods, if existing funcMap entry's
    signature `params.length !== newParams.length`, allocate a fresh
    funcIdx and route both trampoline + body to it. Shared `funcMap`
    entry stays put for `ClassName.prototype.method` lookups.
  - **Edge case missed?**: if THREE literals share the same struct hash
    with arities (1, 2, 2), the second literal will fork (mismatch
    against arity-1 placeholder), but the third literal will look up
    `funcMap[fullName]` and see whatever entry was last written —
    `funcMap` is not updated when a fork happens. Result: the third
    literal's trampoline references the original arity-1 placeholder,
    which gets overwritten when this literal's body compiles. Verify
    by adding a 3-literal test case (e.g. arities 0, 1, 1).
  - **#449 is more invasive**: it edits `ensureStructForType` to hash on
    AST arity instead of signature arity — which changes struct dedup
    semantics globally. Riskier; could regress unrelated literals.
    Recommend close #449 in favour of #461.
- **Conflict risk**: `src/codegen/literals.ts` (compileObjectLiteralForStruct
  hot zone). Conflicts with #451, #452, #454 if they merge first — but
  the regions are different (lines ~244, ~700, ~1300 vs #461's
  ~936/~1028/~1391); manual rebase should be quick.

### PR #460 — fix(#1129): ToObject — primitive auto-boxing for Object(x)
- **Verdict**: ✓ correct
- **Spec section**: §20.1.1.1 / §7.1.18 ToObject.
- **Concerns**:
  - `isNullOrUndefinedArg` correctly checks `(flags & NULL_UNDEFINED_VOID)
    !== 0 && (flags & ~NULL_UNDEFINED_VOID) === 0` so unions like
    `number | undefined` fall through to the wrapper path. Sensible.
  - The literal `undefined` identifier check (`a.text === "undefined"`)
    misses `void 0` syntactically, but the `getTypeAtLocation` check
    catches that case via the type system. Combined, both bases covered.
  - `Object()` / `Object(null)` / `Object(undefined)` → `__object_create(null)`
    — produces an externref object whose `typeof` is `"object"` and
    which has no own props. Matches spec.
  - `Object(number)` → `__new_Number(f64)` — correct (Number wrapper).
  - `Object(boolean)` coerces bool→i32→f64 then calls `__new_Boolean(f64)`.
    Confirm `__new_Boolean`'s host impl already coerces 0→false / 1→true.
    Assumed yes per the existing `new Boolean` path in `new-super.ts`.
  - **Missed edge case**: `Object(bigint)`, `Object(symbol)` — should
    return a BigInt / Symbol wrapper. Not currently supported; falls
    through to the identity branch which returns the externref. Acceptable
    for now (BigInt / Symbol wrappers are rarely round-tripped) but
    worth a follow-up issue.
  - **Missed edge case**: `Object(value)` where `value`'s static type is
    `any` and runtime value is a primitive — the identity-branch returns
    the unboxed primitive. Per spec, ToObject(primitive) auto-boxes. The
    PR's comment correctly defers this to a future `__to_object` runtime
    helper.
- **Conflict risk**: shares `src/codegen/expressions/calls.ts` with #455.
  Different regions (#460 ~line 1011, #455 ~line 6760). Rebase should
  succeed automatically.

### PR #459 — fix(#1455): builtin subclassing (extends Array/Map/Set)
- **Verdict**: ⚠ minor concerns (tag remapping + global registry)
- **Spec section**: §10.1.13 OrdinaryCreateFromConstructor + §10.2.2
  [[Construct]] semantics for built-in constructors. `Reflect.Construct(P,
  args, newTarget)` requires the instance's [[Prototype]] to be set from
  `Get(newTarget, "prototype")`, not from `Parent.prototype`.
- **Concerns**:
  - **Builtin tag renumbering**: `WeakRef` moves from `-60` to `-24`. If
    any committed `.wasm` baselines or external code paths depend on
    these numeric tag values, this is a breaking change. Verify nothing
    serializes these to disk (e.g., AOT caches). The new tags `-4`
    (Boolean), `-5` (Number), `-6` (String) slot in among existing
    primitive-adjacent slots; ensure no collisions in any
    `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE` enumeration that hits switch
    statements indexed by tag.
  - **`_subclassCtors` global state**: lazy synthesis of `class Sub
    extends Parent {}` per `(subName, parentName)` pair is correct and
    bucketed to avoid name-collision across realms. But this is process-
    global state on the runtime side — multi-realm test262 sandbox runs
    that re-import the same module could leak `Sub` ctors across
    iterations. Probably fine for the test262 budget, but flag for
    `test262-shard` reruns: an arena `WeakMap` keyed by `callbackState`
    would be cleaner.
  - **`__instanceof` walk**: iterates the entire bucket for `ctorName`.
    OK for small N; if hundreds of subclasses share a `subName` (very
    unlikely), this becomes O(N) per check. Acceptable.
  - **`emitSetSubclassProto` standalone path**: returns early if
    `setProtoIdx === undefined`. Wait — `ensureLateImport` always
    succeeds in import registration, so `undefined` would never happen.
    The standalone path comment is misleading; the actual standalone
    behaviour will be a host-import-with-no-impl, which the runtime
    rejects at instantiation. Confirm standalone mode is not a target
    for the subclass-builtins feature, or add a real no-op fallback.
  - **Test262 baseline JSON file regenerated** in this PR — verify the
    `public/benchmarks/results/test262-report.json` change is just a
    trailing-newline normalisation (per diff: only the EOF newline
    changed). No actual numeric delta — safe.
- **Conflict risk**: shares `src/runtime.ts` with #455, #456, #468. The
  `__instanceof` / `__register_user_class` regions are at lines ~4530-
  4630; #456 edits ~4706; #455 adds ~4343; #468 edits ~4673. All
  disjoint. shares `src/codegen/class-bodies.ts` with no other PR.

### PR #458 — fix(#820c): async-gen yield* object-method null deref
- **Verdict**: ✓ correct (narrow scope, well-gated)
- **Spec section**: not a direct spec issue — this is a Wasm-typing fix
  for a corner case in hoisted local re-typing.
- **Concerns**:
  - The narrowing `ref → externref` is gated on `initIsAccessorLiteral`,
    which limits exposure. The comment correctly justifies why no prior
    `struct.new` could refer to the local (hoisted ref locals get no
    init).
  - **Risk**: if a user writes `let x = {get foo(){...}}; x = {a:1};`
    where the second assignment creates a struct ref of the same type
    as the original hoisted local, the first assignment (accessor
    literal → externref) might break the second's expected struct
    type. Verify with: does the second assignment's stored type get
    re-checked against the now-externref local type and trigger a
    coercion? If not, this could silently miscompile mixed-shape
    re-assignments.
  - Recommend a follow-up test: `let x = {get foo(){return 1}}; x =
    {a: 2}; return x.a;` — should compile and return 2.
- **Conflict risk**: ONLY `src/codegen/statements/variables.ts`. Isolated.

### PR #457 — fix(#1559): resolver prefers .js impl over .d.ts for bare-package imports
- **Verdict**: ✓ correct
- **Spec section**: not a spec issue (resolver behaviour).
- **Concerns**:
  - Generalises the existing `@types/` detection to any `.d.ts` whose
    bare-package import has an impl body next door. Correctly preserves
    the fall-through for true declaration-only packages.
  - **Edge case**: if a package ships `dist/index.d.ts` AND `dist/index.js`
    but the `.js` is a stub that delegates to `dist/cjs/index.js`, this
    resolver returns `dist/index.js`. Verify `findImplementationBody` is
    smart enough to follow the next-level package.json `main`/`exports`,
    or this regresses to the stub. Looking at the existing #1060
    implementation, it just searches for sibling files — probably OK
    for ESLint's flat layout.
  - The `endsWith(".d.ts")` check correctly fires only on declaration-
    file resolutions. Won't affect normal `.js` / `.ts` first-hit paths.
- **Conflict risk**: ONLY `src/resolve.ts`. Isolated.

### PR #456 — fix(#1352): normalize wasmGC string structs in host equality bridges
- **Verdict**: ✗ **SPEC BUG — `intent.kind` should be `intent.type`**
- **Spec section**: §7.2.14 Loose Equality / §7.2.15 Strict Equality /
  §7.2.11 SameValueZero.
- **Concerns**:
  - **CRITICAL BUG (line `if (intent.kind === "host_loose_eq")`)**:
    the switch in `resolveImport` discriminates on `intent.type` (see
    runtime.ts:1788 and every other branch in the file). `intent.kind`
    is not a field of the intent union — TypeScript may infer it as
    `never` and silently let it compile, but the runtime check will
    NEVER be true. Consequence: when intent.type is `"host_loose_eq"`,
    the function falls past both `if` branches and returns the
    `same_value_zero` comparator. SameValueZero ≠ loose equality:
    `null == undefined` returns true under `==`, but SameValueZero
    returns false (different types). This regresses every `null ==
    undefined` / `0 == "0"` / `"" == 0` test that previously passed.
  - The test file in this PR only exercises string-vs-string comparisons,
    which return the same result under all three operators — so the
    test suite does NOT catch the bug. Add a `null == undefined` test
    case BEFORE merging.
  - Suggested fix: change `intent.kind === "host_loose_eq"` to
    `intent.type === "host_loose_eq"`.
  - Otherwise the normalisation logic itself looks correct — uses
    `_toPrimitive(v, "string", callbackState)` to coerce a wasmGC
    string struct to a primitive before comparison. Good for the
    `m[0] === "42"` case.
- **Conflict risk**: shares `src/runtime.ts` with #455, #459, #468.
  Different regions (this PR ~line 4704-4725). Should rebase cleanly.

### PR #455 — fix(#820a): RegExp Symbol.{match,replace,search,matchAll} dispatch
- **Verdict**: ✓ correct (with one mutating-receiver caveat)
- **Spec section**: §22.2.5.{6,9,10,11} RegExp.prototype[@@match/@@replace/
  @@search/@@matchAll]. Each invokes RegExpExec which calls Get(R,"exec")
  and falls back to the builtin.
- **Concerns**:
  - **Mutating-receiver side effect**: `_ensureExecCallable(r)` does
    `r.exec = wrapped` if the user assigned a WasmGC closure to
    `r.exec`. This mutates the user's RegExp instance. Per spec, the
    user's `r.exec` should remain whatever they assigned; the engine
    just calls it. The mutation works because the wrapped function
    invokes the same closure, but observable side effects (e.g.
    `typeof r.exec` before/after `r[Symbol.match](s)` differs from
    "object" to "function") could fail test262 invariant checks.
    Suggested mitigation: dispatch through a non-mutating shim that
    holds the WasmGC closure in a closure and proxies the call.
  - Symbol.matchAll added to WELL_KNOWN_SYMBOLS at id 15 — correctly
    bumps `_symbolIdToKeys`, `_symbolToWasm`, `_safeGet` / `_safeSet`
    upper bounds (1-14 → 1-15) in all three places. Consistent.
  - `__regexp_symbol_search` calls `Number(v)` on the result — spec
    requires ToInteger → ToInt32 effectively; `Number()` returns NaN
    for non-numeric returns. For `Symbol.search` the spec result is
    always a Number ≥ -1, so `Number()` is fine.
  - `__regexp_symbol_replace` correctly threads the `repl` arg (which
    can be a string OR a function). Both work through `fn.call(r, s,
    repl)` → engine handles function-replacement semantics.
  - The `_ensureExecCallable` arity loop (1, 2, 3, 4) tries multiple
    `__call_fn_N` dispatchers — clever workaround for DCE'd lower-arity
    exports. Worth documenting that this might fail silently if a
    closure has arity 5+; verify spec only requires arity 1 (it does
    — exec takes one string arg).
- **Conflict risk**: shares `src/codegen/expressions/calls.ts` with #460
  (different regions); shares `src/codegen/literals.ts` with #461,
  #454, #452, #451 (different regions); shares `src/runtime.ts` with
  #456, #459, #468 (different regions). Conflict probability low but
  non-zero — manual rebase should be quick.

### PR #454 — fix(#1553e): array-literal explicit undefined fires dstr default for f64
- **Verdict**: ✓ correct
- **Spec section**: §13.15.5.5 IteratorBindingInitialization — the
  default initialiser fires when the iterator value is `undefined`.
- **Concerns**:
  - `_isUndefinedLike` now unwraps `as T`, `<T>x`, `satisfies T`, `(x)`,
    and `x!`. Correct — these are transparent expressions. The unwrap
    loop is bounded (TS AST is acyclic).
  - Element-kind inference change: `firstSignificantElem` now skips
    undefined-likes as well as omitted. When ALL elements are
    undefined-like, falls back to the contextual type's first type
    argument if it's `f64` (kept for primitive numerics only). The
    i32 case is correctly excluded — there's no reliable sentinel.
  - **Edge case**: if the contextual type is `Array<f64>` and ALL
    elements are `undefined`, the result will be a vec of f64 sNaN
    sentinels. Subsequent reads will trigger destructuring default
    correctly, but if the vec escapes (e.g. `console.log` printing it),
    the user sees `NaN` instead of `undefined`. This is the documented
    sentinel-based approach used elsewhere in #1024; acceptable.
- **Conflict risk**: shares `src/codegen/literals.ts` with #455, #461,
  #452, #451. Different regions; rebase should succeed.

### PR #453 — refactor(#1553a): thread decl-mode + bindingKind through destructure-param helpers
- **Verdict**: ✓ correct (refactor, exports new types)
- **Spec section**: §14.3.3 — TDZ semantics for `let` / `const` bindings.
- **Concerns**:
  - Adds `DestructureMode` and `BindingKind` exported types — required
    by #464. Merge first.
  - `isDeclMode` / `shouldEnsureLetConstFlags` are correctly gated on
    `opts?.mode === "decl"`; param-mode (default) behaviour unchanged.
  - `emitLocalTdzInit` invocations added after every binding `local.set`
    in decl mode. Consistent with the existing `let`/`const` TDZ
    discipline.
- **Conflict risk**: ONLY `src/codegen/destructuring-params.ts`.
  Blocks #464.

### PR #452 — fix(#1151 Gap B): object-literal method binding-pattern params → externref
- **Verdict**: ✓ correct (mirrors closures.ts/class-bodies.ts pattern)
- **Spec section**: §14.3.3.1/.2 — destructuring null/undefined must throw
  TypeError synchronously.
- **Concerns**:
  - Two hunks at literals.ts:~1294 and ~1370 — sig-collection phase and
    fctx-param-population phase. Both override `wasmType = externref`
    when the param's name is an Array/ObjectBindingPattern AND there's
    no explicit `param.type` AND no `...rest`. Correct.
  - Mirrors the same fix already in `closures.ts:1186` and
    `class-bodies.ts:1160` per the comment. Consistent triple-site
    pattern — could be extracted to a shared helper, but that's a
    follow-up cleanup.
- **Conflict risk**: shares literals.ts with #451, #454, #455, #461.
  All in different regions; rebase clean.

### PR #451 — fix(#820b): handle ComputedPropertyName in object accessor pre-pass + emit
- **Verdict**: ✓ correct
- **Spec section**: §13.2.5 PropertyDefinition / §13.2.5.1 PropertyDefinitionEvaluation
  — accessor name can be computed; ToPropertyKey applies.
- **Concerns**:
  - Uses `resolveAccessorPropName(ctx, p.name)` which presumably handles
    ComputedPropertyName with a literal key (numeric / string / template
    no-interp). Truly dynamic computed keys correctly return `undefined`
    and the accessor is skipped (matches the pre-existing "out of scope"
    behaviour).
  - Tiny diff: only 4 lines net. Low risk.
- **Conflict risk**: literals.ts, ~line 244 region. No overlap.

### PR #449 — fix(#1557): use AST param count for method struct hash + fork per-literal
- **Verdict**: ⚠ duplicate of #461, riskier approach. **RECOMMEND CLOSE**.
- **Concerns**: changes `ensureStructForType` to hash on AST arity
  instead of TS signature arity. Affects struct dedup globally — could
  regress unrelated literals that legitimately share a struct. #461's
  per-literal funcIdx fork is the narrower, safer fix.
- **Conflict risk**: would conflict with #461 in `src/codegen/literals.ts`
  and `src/codegen/index.ts`.

### PR #450 — fix(#1558): coerce i32 left operand to f64 in numeric/equality binary ops
- **Verdict**: ⚠ duplicate of #462. **RECOMMEND CLOSE**.
- **Concerns**: routes both-i32 case through `compileI32BinaryOp` (stays
  in i32). Equivalent semantics, slightly faster Wasm, but diverges from
  the surrounding `compileNumericBinaryOp` path that all other binary
  ops use. #462's "always widen to f64" is more consistent.
- **Conflict risk**: would conflict with #462 in `src/codegen/binary-ops.ts`.

## File-overlap conflict matrix

Files touched by each PR (compiler source only — docs/tests/plan omitted):

| File                                          | PRs touching it                       |
|-----------------------------------------------|---------------------------------------|
| `src/codegen/index.ts`                        | #468, #449                            |
| `src/codegen/literals.ts`                     | #451, #452, #454, #455, #461, #449    |
| `src/codegen/expressions/calls.ts`            | #455, #460                            |
| `src/codegen/binary-ops.ts`                   | #462, #450                            |
| `src/codegen/array-methods.ts`                | #466                                  |
| `src/codegen/builtin-tags.ts`                 | #459                                  |
| `src/codegen/class-bodies.ts`                 | #459                                  |
| `src/codegen/destructuring-params.ts`         | #453                                  |
| `src/codegen/statements/destructuring.ts`     | #464                                  |
| `src/codegen/statements/variables.ts`         | #458                                  |
| `src/resolve.ts`                              | #457                                  |
| `src/runtime.ts`                              | #455, #456, #459, #468                |

Pairwise conflict matrix (X = touches same file; ?? = same region risk):

|       | 451 | 452 | 453 | 454 | 455 | 456 | 457 | 458 | 459 | 460 | 461 | 462 | 463 | 464 | 466 | 468 | 449 | 450 |
|-------|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|
| 451   | —   | X   | .   | X   | X   | .   | .   | .   | .   | .   | X   | .   | .   | .   | .   | .   | X   | .   |
| 452   | X   | —   | .   | X   | X   | .   | .   | .   | .   | .   | X   | .   | .   | .   | .   | .   | X   | .   |
| 453   | .   | .   | —   | .   | .   | .   | .   | .   | .   | .   | .   | .   | .   | dep | .   | .   | .   | .   |
| 454   | X   | X   | .   | —   | X   | .   | .   | .   | .   | .   | X   | .   | .   | .   | .   | .   | X   | .   |
| 455   | X   | X   | .   | X   | —   | X   | .   | .   | X   | X   | X   | .   | .   | .   | .   | X   | X   | .   |
| 456   | .   | .   | .   | .   | X   | —   | .   | .   | X   | .   | .   | .   | .   | .   | .   | X   | .   | .   |
| 457   | .   | .   | .   | .   | .   | .   | —   | .   | .   | .   | .   | .   | dep | .   | .   | .   | .   | .   |
| 458   | .   | .   | .   | .   | .   | .   | .   | —   | .   | .   | .   | .   | .   | .   | .   | .   | .   | .   |
| 459   | .   | .   | .   | .   | X   | X   | .   | .   | —   | .   | .   | .   | .   | .   | .   | X   | .   | .   |
| 460   | .   | .   | .   | .   | X   | .   | .   | .   | .   | —   | .   | .   | .   | .   | .   | .   | .   | .   |
| 461   | X   | X   | .   | X   | X   | .   | .   | .   | .   | .   | —   | .   | .   | .   | .   | .   | DUP | .   |
| 462   | .   | .   | .   | .   | .   | .   | .   | .   | .   | .   | .   | —   | .   | .   | .   | .   | .   | DUP |
| 463   | .   | .   | .   | .   | .   | .   | dep | .   | .   | .   | .   | .   | —   | .   | .   | .   | .   | .   |
| 464   | .   | .   | dep | .   | .   | .   | .   | .   | .   | .   | .   | .   | .   | —   | .   | .   | .   | .   |
| 466   | .   | .   | .   | .   | .   | .   | .   | .   | .   | .   | .   | .   | .   | .   | —   | .   | .   | .   |
| 468   | .   | .   | .   | .   | X   | X   | .   | .   | X   | .   | .   | .   | .   | .   | .   | —   | X   | .   |
| 449   | X   | X   | .   | X   | X   | .   | .   | .   | .   | .   | DUP | .   | .   | .   | .   | X   | —   | .   |
| 450   | .   | .   | .   | .   | .   | .   | .   | .   | .   | .   | .   | DUP | .   | .   | .   | .   | .   | —   |

Notes:
- All `X` overlaps in literals.ts are in DIFFERENT regions of the file
  (lines ~244 for #451 vs ~700 for #455 vs ~1290 for #452 vs ~1990 for
  #454 vs ~930+~1390 for #461). Manual git merge should succeed; auto-
  rebase usually does too.
- The runtime.ts overlaps for #455/#456/#459/#468 are all in distinct
  regions (~4343 #455; ~4530-4630 #459; ~4673 #468; ~4706 #456). No
  textual conflicts expected.
- `dep` = logical dependency, not text conflict (rebase order matters).
- `DUP` = duplicate work on the same issue; one must close.

## Issues to file

1. **#1557 needs a 3-literal regression test** (covered in #461 review
   above). Suggested test: three object literals with arities (0, 1, 1)
   sharing the same struct hash — verify the second and third literals'
   trampolines call the correct funcIdx.
2. **#1352 dev needs to add a `null == undefined` loose-equality test
   case** before #456 can merge. Once added it will catch the
   `intent.kind` → `intent.type` bug (file is otherwise correct).
3. **#1455 builtin-tag renumbering** (`WeakRef -60 → -24`) — check that
   no AOT cache / disk-serialised tags exist anywhere. If they do, file
   a migration issue.
4. **#820a mutating-receiver** in `_ensureExecCallable` — file a
   follow-up to use a non-mutating shim so `typeof r.exec` doesn't flip
   from "object" to "function" after the first call. Low priority
   (test262 likely tolerates this).
5. **#820c follow-up test** — `let x = {get foo(){return 1}}; x =
   {a:2}; return x.a;` to lock in the externref-narrowing behaviour
   doesn't break legitimate re-assignment.
6. **#1129 BigInt/Symbol wrapper** — `Object(bigint)` and `Object(symbol)`
   are stubbed to identity. File a follow-up for full ToObject(7.1.18)
   coverage once BigInt / Symbol wrapper paths land.

## Summary

- **13 review-target PRs (#453–#468) plus 2 duplicates (#449, #450)**.
- **1 SPEC BUG**: #456 has an unreachable `intent.kind` check; loose
  equality silently falls through to SameValueZero. **HOLD #456** until
  the dev flips it to `intent.type` and adds a `null == undefined` test.
- **2 DUPLICATES**: close #449 (in favour of #461) and #450 (in favour
  of #462).
- **Doc-only / no-conflict-risk batch ready to land first**: #465,
  #467, #463 (depends on #457).
- **Logical merge dependency chains**: #457 → #463; #453 → #464.
- **Largest rebase risk**: literals.ts cluster (#451, #452, #454, #461)
  and runtime.ts cluster (#455, #459, #468) — but all hunks are in
  distinct regions so auto-rebase should succeed.
- **No cross-PR regression risk identified** beyond the #456 spec bug.
