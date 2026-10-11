---
id: 6657
title: "$262.createRealm is wont-fix for --target standalone (6 ES2015 test262 rows)"
status: wont-fix
sprint: current
created: 2026-09-23
updated: 2026-09-23
priority: low
horizon: s
feasibility: hard
task_type: conformance
area: conformance, runtime
es_edition: ES2015
goal: standalone-mode
parent: 6651
related: [6651, 4444]
assignee: "ttraenkler/project-thread"
---

# `$262.createRealm` — wont-fix on `--target standalone`

Six ES2015 test262 rows fail on the standalone target because they call
`$262.createRealm()`:

```
built-ins/ThrowTypeError/distinct-cross-realm.js
language/eval-code/indirect/realm.js
language/expressions/call/eval-realm-indirect.js
language/expressions/tagged-template/cache-realm.js
language/types/reference/get-value-prop-base-primitive-realm.js
language/types/reference/put-value-prop-base-primitive-realm.js
```

They are **not** an `instanceof` / eval / tagged-template gap that happens to
use a realm — the realm *is* the assertion. `distinct-cross-realm` asserts
`%ThrowTypeError%` is a different function object in the second realm;
`cache-realm` asserts the template-object cache is per-realm;
`get-value-prop-base-primitive-realm` asserts a primitive's wrapper resolves
against the *other* realm's `Number.prototype`. Each test's subject is the
existence of two realms.

## Why a no-host standalone target cannot honour them

1. **`$262.createRealm` is a HOST hook, not an ECMAScript feature.** test262's
   `INTERPRETING.md` defines it as "a new ECMAScript Realm … created by the
   host", and §9.6 InitializeHostDefinedRealm is host-defined by construction.
   A standalone binary has, by definition, no host to define it.
2. **A standalone module instance IS exactly one realm, materialised at compile
   time.** The intrinsics are WasmGC structs and module globals minted by
   codegen and instantiated once per module instance. No runtime operation
   mints a second set; doing so would mean instantiating a second module, which
   needs an embedder.
3. **Even given a second instance, the two realms could not exchange object
   references usefully.** Each instance has its own rec-group type identities,
   so a value from instance B satisfies no `ref.test` in instance A — every
   brand check, every `__typeof_*` classifier and the whole prototype substrate
   would answer "foreign". The cross-realm *identity* assertions these six rows
   make are precisely the ones that depend on those checks.

## Scope

Wont-fix for `--target standalone` only. The JS-host lane keeps whatever
`$262.createRealm` support the runner gives it; nothing here changes that.

Under #6651's definition of done these 6 rows count as documented-done rather
than open residual.

Measured and root-caused by the cluster-I slice I2 lane, 2026-09-22; see the
`### Cluster I` receipt in
`plan/issues/6651-es2015-standalone-100pct-execution-plan.md`.
