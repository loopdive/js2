# Spec: 90 % test262 ES5 pass rate in standalone mode

- **Author**: architect lane (spec), implementation dispatched to opus dev agents
- **Date**: 2026-08-08
- **Parent goal**: [es5.md](es5.md) (this is the standalone-lane slice), overlaps
  `standalone-mode` / `property-model` / `builtin-methods`
- **Branch**: `claude/test262-es5-pass-rate-vdseyg`

## Definition and math

**ES5 bucket** = test files whose frontmatter carries `es5id:` (same rule as
`scripts/generate-editions.ts`, priority 1). Official scope (standard +
annex B, no proposals), standalone lane (`TEST262_TARGET=standalone`),
honest oracle.

Measured 2026-08-08 against `test262-standalone-current.jsonl`
(baseline sha `a06fe8f3`, oracle v13):

| metric | value |
| --- | --- |
| es5id-tagged files in suite | 8,260 |
| present in standalone baseline | 8,115 |
| pass | 6,907 (**85.11 %**) |
| fail | 1,059 |
| compile_error | 128 |
| compile_timeout | 21 |
| **needed for 90 %** | **7,304 → +397 net passes** |

The reachable pool is large enough: source-scanning the 1,208 non-passing
tests, 143 use `eval(` / `Function(` (gated on the `runtime-eval` goal) and
106 use `with(` — leaving a **clean reachable pool of 959** failures, 2.4× the
397 needed.

Full per-test failure list with error signatures: regenerate with
`node .tmp/es5-standalone-analysis.mjs` / `.tmp/es5-buckets.mjs` (both in
`.tmp/`, gitignored; they join `es5id:`-tagged files against the fetched
standalone baseline JSONL — `node scripts/fetch-baseline-jsonl.mjs --standalone`).

## Ranked work packages

Ordered by (expected net passes) / (risk × effort). Counts are failing ES5
tests in the standalone lane only; fixes usually also lift non-ES5 and host-lane
numbers.

### WP1 — Property-descriptor cluster (~245 failing; expect +140–180)

Dirs: `built-ins/Object/defineProperty` (92), `defineProperties` (61),
`create` (41), `getOwnPropertyDescriptor` (20), `keys`/`getOwnPropertyNames`/
`preventExtensions`/`prototype` (~30).

Dominant signatures:

- `desc.writable Expected SameValue(«undefined», «true|false»)` (17 in
  getOwnPropertyDescriptor alone): the descriptor object returned in standalone
  mode is missing `writable`/`enumerable`/`configurable` fields for data
  properties. Sample: `15.2.3.3-4-4.js`, `-4-6.js`, `-4-8.js` (own data props
  of built-ins/arrays/strings).
- `Expected a TypeError to be thrown but no exception was thrown at all`
  (~19 across defineProperty/defineProperties): redefinition validity checks
  ([[DefineOwnProperty]] rejection rules, non-extensible targets, invalid
  descriptor combos) not enforced.
- `Object.defineProperties unsupported descriptor shape in standalone mode
  [SITE-PROPS-BAG-NOT-A…]` (13): props bags built from variables/computed
  objects rather than literal shapes are rejected at compile time.
- `verifyEnumerable !== true` / `verifyProperty` failures: attribute semantics
  (enumerability in for-in / Object.keys after defineProperty).

Entry points: standalone object model in `src/codegen/` (search
`SITE-PROPS-BAG`, `defineProperty`, `getOwnPropertyDescriptor` emit paths) and
`src/runtime/builtins.ts`. The property-model goal doc has background.

### WP2 — Function invocation semantics (~150 failing; expect +50–80)

> **Refinement (source scan):** the `call`/`apply` sub-buckets are ~87 %
> `Function(...)`-constructor-dependent (20 of 23 each) — those are
> `runtime-eval`-gated, not fixable here. The clean WP2 pool is:
> `language/statements/function` 50, `built-ins/Function` 26,
> `language/expressions/call` 19, `bind` 18, `language/function-code` 17,
> `language/arguments-object` 17, call/apply 6. Prioritize bind crashes,
> TypeError-on-non-callable, arguments-object, and sloppy `this` coercion.

Dirs: `built-ins/Function` (40), `Function/prototype/call` (23), `apply` (23),
`bind` (18), `language/statements/function` (61 − 8 with-related),
`language/function-code` (24), `language/arguments-object` (17),
`language/expressions/call` (20).

Dominant signatures:

- Sloppy-mode `this` coercion: `this["shifted"]` / `this["feat"]` tests
  (S15.3.4.4_A3/A5/A6 family) — primitive `thisArg` must be boxed to wrapper
  objects, `null`/`undefined` must become the global object in non-strict
  functions; currently either crashes (`Cannot access property on null or
  undefined`) or passes the raw value.
- `typeof obj.call === "function"` fails: `call`/`apply` not reified as
  properties reachable via lookup on user function objects.
- `bind`: 10 null derefs (`__module_init`, nested closures) — bound-function
  construction crashes; 5 missing TypeErrors (bind on non-callable).
- `Expected a TypeError but got undefined` (8 in expressions/call): calling a
  non-function value must throw TypeError, not return undefined.
- `Function` constructor (13 missing TypeErrors + 8 `__get_builtin` CEs):
  dynamic-shape operations on the Function built-in.

### WP3 — String cluster (~100 failing; expect +55–75)

Dirs: `built-ins/String/prototype/split` (23), `replace` (20), `built-ins/String`
(39), misc prototype (~20).

- `String.prototype.split is not yet implemented in --target standalone` (22):
  pure implementation gap — implement split (string separator, regexp separator,
  limit) natively. Follow the dual-backend pattern of #679; see
  `src/codegen/string-proto-substring.ts` and neighbors for the existing
  standalone string-method idiom.
- `replace`: standalone RegExp engine lacks function replacers (8) and
  RegExp/symbol-protocol search values (8).
- `built-ins/String`: `new String(x)` wrapper semantics — `.constructor`
  identity, `hasOwnProperty` on index props, indexed access returning
  `undefined` out of range.

### WP4 — Array cluster (~90 failing; expect +45–60)

- `filter` (31): `newArr.length` wrong / `Array.isArray(result)` false —
  looks like one root cause in the standalone array-HOF lowering when `this` is
  an array-like (15.4.4.20-9-* family exercises callbackfn side effects and
  array-like receivers; see `src/codegen/array-like-hof-arms.ts`,
  `array-methods.ts`). Verify against the 9-b-* deleting/adding-elements tests.
- `built-ins/Array` (23): `new Array(len)` OOB accesses (6), sparse/`undefined`
  hole reads, `toString` via Object.prototype.
- `Array/length` (17): setting `length` must truncate, non-writable when
  defined so, RangeError on invalid values.

### WP5 — instanceof + isPrototypeOf host-import leaks (~25 failing; expect +20)

`host_import_leak: env::__instanceof_check` (10), `env::Object_isPrototypeOf`
(9). instanceof and isPrototypeOf currently route to a JS-host import with no
standalone fallback — violates the dual-mode rule. Implement the prototype-walk
natively (both already have all the pieces: proto chain exists in the
standalone object model). Also fixes S11.8.6\_\* and S15.3.5.3\_\*.

### WP6 — Wrapper `constructor` identity (~40 failing; expect +25)

`built-ins/Object` (36) + `Number/prototype`/`Boolean` misc: `Object(5)
.constructor === Number`, `new Number().constructor`, `Number.prototype` value
identity. The standalone object model's wrapper objects don't expose a
`constructor` own/proto property linking to the intrinsic constructor
function objects.

### WP7 — `with` statement (99 failing; DEFERRED)

31 CEs need the dynamic-scope route of #1387/#671 (explicitly a scoping
decision), the rest are scope-chain bugs in the closed-shape route. High
effort, capped upside. Only attack if WP1–WP6 land short of +397.

### Not in scope

eval-dependent tests (gated on `runtime-eval` goal), proposals, compile
timeouts (21, mostly pathological strict reruns), RegExp engine rewrites
beyond what WP3 needs.

## Implementation constraints (binding for all WPs)

1. **Standalone-native only** — no new host imports without a standalone
   fallback (dual-mode rule, CLAUDE.md). WP5 exists because this rule was
   broken before.
2. Type queries in new codegen go through `ctx.oracle`, not the raw TS checker
   (oracle-ratchet gate).
3. Debug/probe files go in `.tmp/`.
4. Don't regress the host (gc) lane: run the same scoped filter with
   `TEST262_TARGET=gc` when touching shared codegen paths.
5. Scoped validation per WP (from repo root):
   ```bash
   TEST262_TARGET=standalone TEST262_PATH_FILTER="<dir1>|<dir2>" \
     TEST262_WORKERS=4 bash scripts/run-test262-vitest.sh --official-scope-only
   ```
   Pass/total per bucket must strictly improve; no new fails inside the filter.
6. Equivalence tests for the touched area (`npm test -- tests/<relevant>.test.ts`)
   plus at least one new regression test per fixed root cause.

## Outcome (2026-08-08, both waves landed on this branch)

| WP | Issue | Measured flips | Notes |
| --- | --- | --- | --- |
| WP3a split | #4220 | +22 (runner-validated) | + `<array>.constructor` fix; regexp separators still refused |
| WP5 instanceof | #2916 | +5 (runner-validated) | both host-import leaks retired; 5 files need runtime `Get(C,"prototype")` |
| WP4a filter | — | +9 (runner-validated) | 3 of 4 root causes were outside filter → WP4b/WP1 |
| WP1 descriptors | #3984-adj | +17 (agent A/B) | array-exotic [[DefineOwnProperty]] was the real gap; SITE-PROPS-BAG deferred (design call) |
| WP6 ctor identity | #4223 | +28 (agent A/B) | `new Object(<primitive>)` (12) + `Object(null)` (6) left with mechanism documented |
| WP3b replace | #4224 | +19 (agent A/B) | function replacers + static-regexp lane; reflective arm left |
| WP4b array | #4222 | +6 (agent A/B) | delete-presence + length RangeError; `Array(n)` holes needs a carrier decision |
| WP2 functions | #4221 | +18 (agent A/B) | non-callable TypeErrors both lanes; arguments-object model untouched |

**Sum ≈ +124 vs the +397 needed** — measured per-bucket, zero known
regressions (every agent A/B'd against its base; phantom regressions from
load-induced compile timeouts and runtime-eval tier mismatches were each
run down and excluded). The next tranche, in expected-value order, is
documented in the issue files above: `arguments`-object model (#4221
leftover), `new Object(<primitive>)`/`Object(null)` (#4223), `Array(n)`
hole carrier (#4222), SITE-PROPS-BAG dynamic descriptor bags (WP1),
reflective `replace`/`split`-family arms (#4224), gOPD on intrinsic
receivers (WP1), and the `with`-statement scope-chain bugs (WP7).

## Wave plan

- **Wave 1 (parallel, disjoint):** WP3-split, WP1, WP5, WP4-filter.
- **Wave 2:** WP2, WP6, WP3-replace, WP4 remainder — rebased on Wave 1.
- Each wave ends with scoped re-runs of every touched bucket; the branch is
  pushed after each merged wave.

Projected: WP1–WP6 midpoints sum to ~+380–460 → 90 % is reachable without
touching `with`/eval.
