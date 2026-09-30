# Independent Object.create(null) source admission — 2026-09-30

Delivery branch `codex/3518-object-create-null-main-20260930` is based on exact
upstream main721d12bf9f11512d7c00eb55b82f3863748b358b. The authoritative claim
`3518:object-create-null-source-admission-20260930` is owned by
`ttraenkler/codex-object-create-null-source-admission-20260930`. Worktree:
`/private/tmp/js2-ir-object-create-null-main-20260930`.

This change proves the genuine compiler-library Object.create binding/member/
resolved signature, retains exact AST membership/currentness and invalidates
mutation, escape and dynamic-constructor hazards. Only direct nonoptional/
nonspread one-literal-null calls are selected in standalone WasmGC whole-program
preparation. Selected initializer, discarded function and module calls emit the
existing effectful js.object.create-null intrinsic. Plain object literals and
other policies retain their previous paths. Original/decoded source programs
retain one canonical provider/call, no source closures and no host capabilities.

Only the four frontend implementation/test files were transplanted from signed
checkpoint1d19ffe9ee9a0e0e4bb07f2c7c3960fc1d5ef575. Independent dependency review
confirmed all required APIs, declaration and logical provider already on main.
Neither PR6358(native builtin callable objects) nor PR6359(shared invocation
resources) is imported or needed for this source preparation. Their armed
branches remain untouched; their current quality failures are test timeouts,
not delivered code. The native realm integration remains separately pending.

Fresh transplant evidence: TS7 exit0; strict focused65/65, zero failures/skips/
worker errors. Seven gates exit0: LOC, function, oracle, coercion, JsTag, compiler
inventory and dead-export preservation. All7354 source/test/script/root JSON
hashes remained unchanged during these checks. Exact four-file hashes and
main-only patch are retained under .tmp/object-create-main/. Inventory preserves
all1728main rows/order/activation/edges and appends one conservative frontend-ts
mixed-needs-split row; three existing rows receive formatting only. Full graph
closure and retirement remain uncertified.

Prior combined-root evidence is separate:65/65 focused,505/505 normal main-merge
hook assertions; strict seven-file240/248, with eight ordinary-object contract
failures reproduced with identical names/errors at the signed dependency base.
Initial failures, pre-fix bytes and exact controls remain in the original source
worktree; no fixture or expectation was weakened.

Pinned test262 is a real clean checkout at
b363f29d3c43c626dc852744ad64a0b48a003693 with56970tracked files. Shared object
storage depends on the original source worktree; preserve both until corpus
objects are independently retained. Normal hooks, signing, fork publication,
protected queue checks and exact main content verification are still required.
Only verified main merges count as delivery.

Physical public Object materialization remains typed unsupported. Full
Object/Function realm, Number parity and the remaining IR migration stay open;
legacy code retires only after complete IR parity/conformance. Preserve the
dirty root, Number56files, native realm12files, existing failures and other PRs.
One heavy process at a time; no timeout, hook or protection bypass. No passive
GitHub watcher is available in this session; do not add scheduled polling.
