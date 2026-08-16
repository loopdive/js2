# Curated npm-package upstream-suite triage — 2026-08-16

Every failing curated package's pinned upstream suite was re-run locally on
main `a9b20d4c` (`node --import tsx tests/dogfood/<pkg>-upstream-suite.mjs
--json`). **Every local result reproduced the npm-compat dashboard card
exactly**, so the buckets below are current-main facts, not artifact drift.
(lit is the one exception: the local run died at exit 137/OOM on this 4-core
box; its 12/16 figure is the CI card's, tracked by #3977.)

## Result → issue map

| package | Wasm/total | dominant failure | issue |
| --- | --- | --- | --- |
| moment | 0/10 | all 6 modules fail validation: closure `struct.new[5]` gets i32, wants `(ref null 72)` | **#4525** (new) |
| redux | 3/78 | 40× null-deref in `combineReducers` closures; 23× illegal cast at dynamic dispatch/`dispatch` | **#4526** (new) |
| axios | 16/170 | 7 modules invalid (`__class_call_concat_vararg` local type clash) ≈101 tests; 10 modules crash init on Symbol→ToNumber ≈49 tests | **#4527**, **#4528** (new) |
| jest | 16/32 | `typeof` on boxed any answers "object" for every primitive (jest-get-type) | **#4529** (new) |
| clsx | 20/32 | variadic arg classification: strings split per char, numbers/object-keys dropped; export identity | **#4530** (new) |
| prettier | 1/8 | 4× illegal cast on heterogeneous `AstPath.stack` reads; 3× Error-subclass `.name` = "Error" | **#4531**, **#4532** (new) |
| lodash / lodash-es | 0/11 ×2 | module init invokes null host slot; lodash-es lane hides its compile error behind a recursive report | **#4533** (new) |
| jsdom | 1/6 | `VirtualConsole extends EventEmitter` loses inherited `on` | **#4534** (new) |
| three | 0/18 | uniform silent failure incl. trivial `clamp` — shared adapter/ABI defect; error text needs PR #4619 | **#4535** (new) |
| stylelint | 7/9 | `arrayEqual` illegal cast (mixed elements) | **#4536** (new) |
| webpack | 13/16 | `groupBy` callback cast, `formatSize(NaN)` branch | **#4536** (new) |
| uuid | 10/75 | unchanged buckets, re-measured table added | #4383 (updated) |
| marked | 0/15 | `br is not a function` — matches the open measurement exactly | #4435 (in-review, no change) |
| tailwindcss / eslint / react / hono / styled-components / cookie | all tests pass | entry-compile budget issues only | #4287 / #4293 |
| react-dom | 0 run | suite not yet wired | #3982 (in-progress) |
| typescript | 1/1 | entry compile exceeds 600 s budget | #1058 / #1579 |

## Cross-package roots (fix-ordering signal)

1. **Boxed-`any` classification** (`typeof`, `Number.isNaN`, `for..in`,
   `Array.isArray` on dynamically passed values) — #4529 is the cleanest
   carrier; clsx (#4530) and webpack's formatSize (#4536) expect collateral.
2. **Heterogeneous array carriers** — prettier AstPath (#4531) is the
   carrier; stylelint arrayEqual (#4536) expects collateral.
3. **Dynamic-dispatch struct casts** (`__call_fn_*`, `__class_call_*`) —
   axios's invalid vararg bridge (#4527) is a hard validation error with a
   precise mechanism; redux's runtime casts (#4526) are the same boundary at
   runtime.
4. **Module-init ordering / null host slots** — lodash (#4533) and axios's
   Symbol crash (#4528) both kill whole modules before any test runs;
   per-test fixes are invisible until these land.

Biggest single-fix unlocks by blocked-test count: #4527 (~101), #4528 (49),
#4526 (~63), #4525 (10 + unmasks #4384's resolver work).

All twelve new issues carry `## Implementation Plan` sections written per the
plan/implement split (Fable plans, Opus implements).
