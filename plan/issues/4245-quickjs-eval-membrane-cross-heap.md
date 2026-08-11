---
id: 4245
title: "QuickJS eval membrane — live cross-heap object access both directions + cycle-safe lifetimes (gc_mark), replacing slice-2's copy/box tier"
status: in-progress
assignee: ttraenkler/opus-membrane
sprint: current
created: 2026-08-08
updated: 2026-08-10
priority: high
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: runtime-eval
language_feature: eval
goal: runtime-eval
related: [2928, 2929, 4236, 4238, 4242]
blocked_by: [4238]
# id 4245 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-08 (gh CLI unavailable; pr_scan=degraded). RENUMBERED TWICE — from
# 4241 (collided with open PR 4252's unreserved file) and again from 4243
# (collided with open PR 4249's unreserved file). 4245 was verified clear of
# ALL open PRs' added issue files via a full MCP get_files sweep (PR 4249:
# 4230-4234, 4243, 4244; PR 4252: 4241; PR 4253: this branch), not just
# the reservation book. Original note:
# open PR 4252 (another lane) added plan/issues/4241-extern-get-receiver-
# stamp-dispatch.md without a reservation; our 4241 reservation was the only
# one on origin/issue-assignments, but renumbering this docs-only file was
# cheaper than cross-lane coordination. The id coincides with a merged PR
# number — shared sequence, not a namespace (precedent: 4235/4236/4237).
---

# #4245 — QuickJS eval membrane: live cross-heap objects + cycle-safe lifetimes

## Why (the gap #4238 deliberately leaves)

The #4238 MVP bridges primitives by copy, surfaces QuickJS functions as
callable carriers, boxes non-callable QuickJS objects opaquely, and refuses
compiled GC objects crossing inward with a typed TypeError. That is correct
for the MVP but is NOT parity with the Acorn+interpreter provider, which
shares the WasmGC heap and therefore gives eval'd code **live** access to
compiled objects — identity-preserving reads AND writes.

Replacing the interpreter as the default engine (#4242) requires the
membrane: objects crossing the seam must be **live views, not copies**, in
both directions.

## Scope

1. **Inward (compiled GC object → visible inside QuickJS eval'd code)**:
   exotic wrapper via `JSClassDef` — per-property `get`/`set`/`has`/
   `delete`/`ownKeys` traps that call back through the seam into GC-lane
   accessor exports. Identity: the same GC object wraps to the same QuickJS
   object within a context (wrapper table). This is the #4236 variant C
   design; the browser-JS↔DOM precedent and the trap inventory are recorded
   there — architect to turn it into an implementable trap↔seam-export map.
2. **Outward (QuickJS object → compiled code)**: upgrade slice-2's opaque
   handle box to a live view — property get/set through seam helpers
   (dynamic-access paths only; typed code cannot hold these except behind
   `any`, which is exactly where the codegen already emits dynamic MOP
   calls). Same-handle → same-box identity.
3. **Cycle-safe lifetimes**: implement the `JSClassDef.gc_mark` hook so
   QuickJS's cycle collector can see wrapper→GC-handle edges; define and
   implement the release protocol for both tables (wrapper table inward,
   box table outward) so a dropped cycle spanning both heaps is collected.
   Replace slice-2's documented context-lifetime retention of function
   carriers with the same mechanism.
4. **Leak accounting**: a debug/assert mode that reports live wrapper/box
   counts per context (test hook), so the lane tests can assert
   allocate→drop→collect actually reclaims.

## Hard constraints

- All #4238 constraints carry over: flag-gated only, default path
  byte-identical, 4-import seam ABI frozen (new capability arrives via NEW
  provider-internal exports/imports between adapter and artifact, never by
  changing the user-module seam), zero JS behind the seam, borrow
  discipline.
- **The interpreter provider and everything it depends on (src/interp/,
  its IR/codegen substrate, acorn) are UNTOUCHED** — project-lead directive
  2026-08-08: the migration keeps the interpreter fully working behind
  `JS2WASM_EVAL_ENGINE=interpreter`; no removals, ever, in this issue.
- quickjs-ng stays pinned (v0.16.1 / 954dc536); shim additions only.

## Acceptance criteria

- [ ] A compiled GC object passed (via a runtime-assembled name) into
      eval'd code can be READ and WRITTEN there, and the compiled side
      observes the writes — identity preserved across multiple evals.
- [ ] An object created inside eval, returned to compiled code, mutated by
      a later eval, shows the mutation to compiled-side dynamic reads.
- [ ] Function carriers and object boxes no longer retain for context
      lifetime: the leak-accounting hook shows reclamation after drops,
      including a cross-heap cycle (GC object ↔ QuickJS object referencing
      each other, both dropped).
- [ ] The #4238 test lane extended with membrane cases; all green under
      `JS2WASM_EVAL_ENGINE=quickjs`; default-path suites untouched and
      green with no env set.
- [ ] Residuals honestly enumerated in this file (e.g. exotic-wrapper
      visibility limits: `Object.getOwnPropertyDescriptor` fidelity,
      prototype-chain crossing, `instanceof` across heaps).

## Implementation Plan

(architect, 2026-08-08 — grounded in the #4238 spec + slice-1 implementation
record, #4236 "## Design variant C" + the adoption-review gc_mark notes.
File:line anchors verified against current main for `src/`, and against
`origin/issue-4238-quickjs-eval-provider-flag` (b82da514) for `scripts/`.
This plan assumes #4238 slices 2 (full value bridge, carriers, `qjs_call`,
UTF-8 both directions, error mapping) is landed; where slice-2 code is cited
it is by the #4238 spec's own section numbers, not by a WIP branch.)

### Decision summary (read this first)

| decision | choice |
| --- | --- |
| outward live view | the box is a **standalone-`Proxy`** created in adapter TS. Load-bearing discovery: `ensureProxyRuntime` is called **unconditionally** from `ensureObjectRuntime` (`src/codegen/object-runtime.ts:4849`), so EVERY user module that does dynamic access already carries the `ref.test $Proxy` front-guards on `__extern_get`/`__extern_set`/`__extern_has` (`object-runtime-proxy.ts:44`, `object-runtime.ts:820`) and the 12 `__proxy_call_*` trap drivers (`object-runtime-proxy.ts:24-35`). A Proxy minted by the adapter is structurally canonical with the user module's `$Proxy`, so compiled dynamic reads/writes dispatch its trap closures **with zero user-codegen change**. |
| inward wrapper | QuickJS exotic class (`JSClassDef` + `JSClassExoticMethods`) in `qjs_shim.c`, opaque = GC registry id; traps call adapter exports through the artifact's own `__indirect_function_table` (funcref indices registered at link time) — the artifact keeps importing ONLY `wasi_snapshot_preview1`, and zero JS is on the data path. |
| callback ABI | all-i32 signatures. Native `i32` annotations ARE honored on defined-function params/returns (`src/codegen/declarations.ts:341-349`, #3673), so `export function __membrane_get(gc: i32, …): i32` emits a real `(i32,i32,i32)→i32` export that `call_indirect` from C typechecks against. |
| identity | inward: GC object → registry id via an adapter `Map` (object-identity keys are native — `src/codegen/map-runtime.ts` header, SameValueZero/`ref.eq`); id → wrapper deduped C-side (non-owning slot, cleared by finalizer). Outward: `qjs_value_ptr(h)` (JS_VALUE_GET_PTR) keys a `Map<ptr, box>`; same ptr ⇒ same Proxy box. Round-trips **collapse** in both directions (wrapper crossing back out unwraps to the original GC object; box crossing back in unwraps to the retained handle). |
| lifetimes | single-owner refcount accounting: each distinct QuickJS object has ONE membrane root (box table) XOR wrapper-edge ownership; edges live **C-side per wrapper**, reported by `gc_mark`, freed by the wrapper finalizer. Wrappers reclaim promptly (finalizer → release GC pin). Cross-heap cycles built through the traps collect **pre-teardown**; cycles built by compiled-side writes, and boxes held only by compiled code, reclaim at context teardown only (WasmGC has no finalizers, #988 — stated honestly below). |
| errors | inward trap errors are full-fidelity (C throws real QuickJS exceptions — catchable by eval'd code). Outward box-trap errors CANNOT propagate as GC exceptions across modules (exception tags are module-local — `src/codegen/registry/imports.ts:209-216`, and the #2928 envelope only covers the 4 seam entries): a failing box trap returns `undefined` and bumps a debug counter. Documented residual. |
| user seam | untouched. The 4 `js2wasm:runtime-eval` imports (`src/codegen/expressions/runtime-eval-provider.ts:34`, signature table in #4236 variant C), the envelope, the 8-slot carrier, push/pull are all byte-identical. Everything below lives in the provider bundle + shim. |

### 0. Architecture recap — where the membrane physically lives

```
user module ──js2wasm:runtime-eval (4 imports, FROZEN)──▶ GC adapter (js2wasm-compiled TS)
GC adapter ──js2wasm:qjs (i32 handle ABI) + imported memory──▶ libquickjs.wasm
libquickjs.wasm ──__indirect_function_table slots (registered at link)──▶ GC adapter exports   ← NEW (inward traps)
adapter-minted $Proxy boxes ──structural canonicalization──▶ user module's __proxy_*_dispatch  ← NEW (outward views)
```

Both new edges are provider-internal. The inward edge is wasm→wasm
`call_indirect` through the artifact's exported function table (the harness
does one-time `table.grow`/`table.set` at link, the same class of sanctioned
plumbing as binding imports — NOT a JS closure on the data path, which the
#4238 spec explicitly forbids). The outward edge is not an edge at all at the
module level: the box Proxy's trap closures are adapter closures invoked by
the user module's own `__proxy_call_*` drivers via the closure-call bridge
(`object-runtime-proxy.ts:47-57`), exactly how cross-module accessor closures
already work (#1888 S5b, `object-runtime.ts:~1826-1850` getter arm,
`:~2543-2556` setter arm).

### 1. Inward exotic wrappers (compiled GC object visible inside eval'd code)

#### 1.1 The wrapper classes

Two `JSClassID`s registered in `qjs_shim.c` at first use (quickjs-ng:
`JS_NewClassID(JSRuntime*, JSClassID*)` — the rt-taking signature; verify
against the pinned `quickjs.h` at compile time, the C compiler will catch a
mismatch):

- `js2wasm_gc_wrapper` — plain objects. `JSClassDef { finalizer, gc_mark, exotic }`.
- `js2wasm_gc_callable` — compiled functions/closures crossing inward. Same
  def **plus `call`**, routing to `__membrane_call` (§1.4). `typeof` inside
  eval'd code then answers `"function"` for compiled callables.

Opaque (`JS_SetOpaque`) = the GC registry id (`gc` below), a dense i32 index
into the adapter's pin registry.

#### 1.2 Trap set (what is and is NOT trapped)

Implemented `JSClassExoticMethods`:

| exotic hook | behavior |
| --- | --- |
| `get_own_property` | `__membrane_has` → absent ⇒ 0; present ⇒ `__membrane_get`, fill `desc` as a **synthesized data descriptor** `{value, writable, enumerable, configurable}` — flag fidelity is NOT preserved (residual §5). When `desc == NULL` (pure existence probe) free the value handle immediately. |
| `get_own_property_names` | `__membrane_own_keys` → QuickJS Array of strings → `JSPropertyEnum` (js_malloc'd). String + array-index keys only. |
| `delete_property` | `__membrane_delete`. |
| `define_own_property` | **NOT trapped** — `JS_ThrowTypeError(ctx, "Object.defineProperty on a compiled object inside eval is not supported (#4245)")`. Loud beats approximated. NOTE: plain assignment does NOT land here because `set_property` below is implemented; only reflective defineProperty does. |
| `has_property` | `__membrane_has` (fast path; also keeps `in`, `with`-scope probes off the descriptor path). |
| `get_property` | `__membrane_get`; absent ⇒ `JS_UNDEFINED` (no proto-chain crossing — the wrapper's [[Get]] answers for the whole compiled object, own+proto, because the adapter resolves through `__extern_get`'s proto walk on the GC side). |
| `set_property` | `__membrane_set`; strict-mode failure semantics via the `flags & JS_PROP_THROW` bit. |

Explicitly NOT trapped / not faithful (state in code comments too):
descriptor-flag fidelity (synthesized above), `Object.defineProperty`
(TypeError), prototype operations (`Object.getPrototypeOf(wrapper)` answers
the wrapper class's proto — QuickJS `Object.prototype` — never the compiled
object's real chain; `setPrototypeOf` → default behavior on the wrapper
object), `Symbol`-keyed access (detect via `JS_AtomToValue` tag == SYMBOL ⇒
treat as absent), array exotics (`Array.isArray(wrapper)` is `false` even for
compiled arrays; `.length` still reads as a value through the trap).

Property-key transport: the C trap converts the `JSAtom` with
`JS_AtomToCString` — the returned bytes live in the QuickJS heap, **which IS
the memory the adapter imports** (`QUICKJS_ADAPTER_COMPILE_OPTIONS.importMemory`,
`scripts/quickjs-eval-provider.mjs:66-73`), so the callback passes
`(ptr, len)` and the adapter reads them with the slice-2 `load8` + UTF-8
decode. `JS_FreeCString` after the callback returns. No copy, no allocation.

#### 1.3 The trap→adapter hop (ABI, spelled out)

C cannot import adapter functions (instantiation cycle: qjs instantiates
first). Mechanism: **function-pointer slots through the artifact's own
indirect function table**.

1. `scripts/quickjs-artifact/build.sh` linker flags (`:139-148`): add
   `-Wl,--export-table -Wl,--growable-table` — exports
   `__indirect_function_table`, growable from the host.
2. `instantiateQuickjsEvalNamespace` (`scripts/quickjs-eval-provider.mjs`,
   link section) after instantiating both modules:
   ```js
   const t = qjs.exports.__indirect_function_table;
   const base = t.grow(8);
   t.set(base + 0, adapter.exports.__membrane_get);   // …one per callback
   qjs.exports.qjs_set_membrane_callbacks(base + 0, base + 1, …);
   ```
   One-time link plumbing; funcref tables legally hold functions from any
   instance, and each callee runs against its own instance's state.
3. `qjs_shim.c` stores the indices and calls through typed function pointers —
   clang lowers `((membrane_get_t)(uintptr_t)idx)(…)` to `call_indirect`
   against `__indirect_function_table`, which typechecks against the
   adapter's exported `(i32,…)→i32` signatures (guaranteed by the native-i32
   annotations on the adapter's export declarations, `declarations.ts:341-349`).

Adapter exports (all params/returns `i32` via `type i32 = number` annotations;
`gc` = registry id, `keyPtr/keyLen` = UTF-8 bytes in the shared heap,
`h` = qjs handle):

| export | signature | contract |
| --- | --- | --- |
| `__membrane_get` | `(gc, keyPtr, keyLen) → i32` | returns an **owned** qjs handle of the converted value; `0` = absent; `1` = adapter error (C throws TypeError). Conversion is the §2 outward table (objects box, wrappers collapse). |
| `__membrane_set` | `(gc, keyPtr, keyLen, h) → i32` | borrows `h`; converts (inward table, boxes collapse) and writes via the adapter's own dynamic write (`obj[key] = v` → adapter's `__extern_set`, which runs user accessors/Proxies on the canonical object). `0` ok, `1` error. This call site is also the ownership-transfer point (§3.3). |
| `__membrane_has` | `(gc, keyPtr, keyLen) → i32` | `0`/`1`; `2` = error. Resolves own+proto via the adapter's `in`-equivalent (`__extern_has`). |
| `__membrane_delete` | `(gc, keyPtr, keyLen) → i32` | `1` deleted-or-absent, `0` refused (non-configurable), `2` error. |
| `__membrane_own_keys` | `(gc) → i32` | owned handle to a QuickJS `Array` of key strings the adapter builds via `qjs_new_array` + `qjs_set_prop_idx`. |
| `__membrane_call` | `(gc, thisH, argc, argvPtr) → i32` | `argvPtr` = C-authored i32 array of **owned** arg handles (C dups each `argv[i]` into a cell); adapter converts args inward, invokes the compiled callable via its dynamic apply machinery, converts the result outward, returns an owned handle; `1` = error. Adapter frees every arg handle. |
| `__membrane_wrapper_finalized` | `(gc) → void` | wrapper finalizer notification (§3.2). MUST NOT call back into any `qjs_*` (runs during GC/context free). |

Sentinel discipline: handles are heap pointers (≥ heap base), so `0`/`1`/`2`
never collide with a real handle.

#### 1.4 Wrapper identity table

- **Adapter side** — pin registry: `const gcRegistry: any[] = []` +
  freelist (`#4236` "handle registry needs no wasm table"); reverse map
  `const gcIds: Map<any, number> = new Map()` (object-identity keys are native
  in the standalone Map runtime — `map-runtime.ts` header). `wrapOutbound(v)`:
  existing id → reuse; else allocate id, pin, `qjs_new_wrapper(ctx, id, isCallable)`.
- **Shim side** — dedup array `gc_id → JSValue` (**non-owning**; gc ids are
  dense so a growable C array suffices). `qjs_new_wrapper` returns a dup of
  the existing wrapper when the slot is live, else creates, stores
  (non-owning), returns owned. The wrapper **finalizer** clears the slot and
  calls `__membrane_wrapper_finalized(gc_id)` — the classic
  weak-cache-by-finalizer pattern, so an eval-dropped wrapper is genuinely
  collectable and identity still holds while it lives.
- Same GC object across multiple evals in one context ⇒ same registry id ⇒
  same wrapper (acceptance box 1's "identity preserved across multiple
  evals"). Identity is per-context by construction (tables live in the
  adapter instance; `instantiateRuntimeEvalNamespace` builds a fresh pair per
  call — `quickjs-eval-provider.mjs`, link section comment).

#### 1.5 Where inward wrapping replaces slice-2 refusals

All in the adapter source (`buildQuickjsAdapterSource`,
`scripts/quickjs-eval-provider.mjs`):

- the GC→QuickJS conversion table's last row (`#4238 §3`): "any other GC
  object/function → typed TypeError" becomes `wrapOutbound` → wrapper handle
  (callable ⇒ callable class).
- the globals mirror (`#4238 §3` "Globals push/pull"): "non-primitive globals
  are skipped" becomes: object-valued own properties of the shared realm
  object mirror as **wrappers** on QuickJS `globalThis` (live — eval-side
  `g.x = 1` writes through the trap into the canonical GC object, so the
  caller's pull (`emitRuntimeEvalGlobalBindingPullBody`,
  `src/codegen/expressions/runtime-eval-provider.ts:289-333`) needs no new
  machinery; rebinding `g = other` is caught by the existing pull copy-back
  with the §2 inward conversion).
- `__runtime_apply_interpreted` args/`this` (`#4238 §3` item 3): GC objects no
  longer refuse — they wrap.

### 2. Outward live views (QuickJS object held by compiled code)

#### 2.1 The box is a Proxy — routing through the compiled MOP, cited

Compiled dynamic access on `any` receivers funnels into:

- reads: `__dyn_get`/`__dyn_has` (`src/codegen/dyn-read.ts:232`, `:79`) and the
  member ladder `ensureDynMemberGet` (`dyn-read.ts:519`) → tag-6 GC-ref arm →
  `__extern_get` (`object-runtime.ts:1675-1954`);
- writes: `ensureDynMemberSet` (`dyn-read.ts:826`) → `__extern_set`
  (`object-runtime.ts:~2480-2680`);
- presence/delete: `__extern_has` / `__delete_property`;
- dynamic calls: `__extern_method_call` (`object-runtime.ts:4799-4836`) which
  does `__apply_closure(__extern_get(recv, name), recv, …)`.

Every one of `__extern_get`/`__extern_set`/`__extern_has` carries the
`ref.test $Proxy` front-guard patched by `ensureProxyRuntime`
(`object-runtime-proxy.ts:44`, registered unconditionally at
`object-runtime.ts:4845-4849`), dispatching to `__proxy_{get,set,has}_dispatch`
→ trap closure via the closure-call bridge; delete/ownKeys/gopd have their own
drivers (`PROXY_CALL_DELETE`/`OWNKEYS`/`GOPD`, `object-runtime-proxy.ts:27-33`).
So: the adapter mints `new Proxy(target, handler)` in its own (js2wasm-compiled,
same-compiler-bundle) source; the `$Proxy`/`$ProxyTraps` rec-group is
structurally canonical; the user module's guards catch it and invoke the
adapter's trap closures cross-module — the same mechanism that already carries
the 8-slot callable carrier and #1888 accessor closures across the seam.

Box shape in adapter TS:

```ts
function makeQjsBox(h: i32): any {
  const target: any = { __qjs_handle__: h };   // brand + handle; Proxy target
  return new Proxy(target, {
    get: (t: any, k: any) => qjsBoxGet(t.__qjs_handle__, k),      // qjs_get_prop_len → outward convert
    set: (t: any, k: any, v: any) => qjsBoxSet(t.__qjs_handle__, k, v), // inward convert → qjs_set_prop_len
    has: (t: any, k: any) => qjsBoxHas(t.__qjs_handle__, k),
    deleteProperty: (t: any, k: any) => qjsBoxDelete(t.__qjs_handle__, k),
    ownKeys: (t: any) => qjsBoxOwnKeys(t.__qjs_handle__),
    getOwnPropertyDescriptor: (t: any, k: any) => qjsBoxGopd(t.__qjs_handle__, k), // synthesized data desc
  });
}
```

- keys arrive as externref (string or number) — number keys stringify before
  `qjs_*_prop_len`; Symbol keys: absent/no-op (residual).
- `getOwnPropertyDescriptor` synthesizes `{value, writable: true,
  enumerable: true, configurable: true}` when present — the standalone Proxy
  dispatch performs NO §10.5 invariant checks (Phase 1 note,
  `object-runtime-proxy.ts:59-65`), so synthesized descriptors are accepted.
- method calls: `box.m(1)` → `__extern_method_call` → `__extern_get` (proxy
  arm) returns the **qjs-callable carrier** for a function-valued property
  (§2.2) → `__apply_closure`… → `__runtime_apply_interpreted` → `qjs_call`
  with `this` = the unwrapped box handle. Verify with a slice-2 canary that
  `__extern_method_call` reaches the proxy get arm (it routes through
  `__extern_get`, so it should; if a direct-cast arm bypasses it, that arm's
  front-guard needs the same `ref.test $Proxy` — provider-side workaround is
  NOT possible, so this canary gates the slice).

#### 2.2 Function-valued reads and the carrier

QuickJS function values keep crossing as the **8-slot carrier** (frozen apply
path, `#4238 §3` OBJECT+is_function row) — the box's `get` trap returns
`makeQjsCarrier(handle)` for function-valued properties, so invocation stays
on `__runtime_apply_interpreted`. Carriers join the outward identity table
(§2.3): same function object ⇒ same carrier (identity across reads, and the
lifetime protocol of §3 covers them — this **replaces slice-2's
retain-forever** for carriers).

#### 2.3 Outward identity table

New shim export `qjs_value_ptr(h) → i32` (JS_VALUE_GET_PTR — stable per
object lifetime; only meaningful for OBJECT-tagged values). Adapter:
`const qjsBoxes: Map<number, any> = new Map()` (ptr → box-or-carrier) plus the
reverse entry record (§3.1). `boxInbound(h)`:

1. `qjs_wrapper_gc_handle(h)` ≠ sentinel ⇒ **collapse**: free `h`, return
   `gcRegistry[id]` (the original GC object — never a box of a wrapper).
2. ptr hit in `qjsBoxes` ⇒ free the fresh `h` (the table entry already owns
   one ref), return the existing box/carrier.
3. else retain `h` in the table entry, mint box (non-callable) or carrier
   (callable), return it.

Inward direction symmetric collapse: converting a GC value that is a box
target/carrier (brand check on `__qjs_handle__` / the carrier's stashed
handle) ⇒ pass `qjs_dup(handle)` of the retained handle — never wrap a box.
These two collapses are the #4236 stage-5 "double-membrane" criterion.

### 3. gc_mark + release protocol (cycle-safe lifetimes)

#### 3.1 Ownership model — single-owner accounting

Per distinct QuickJS object crossing outward there is exactly ONE box-table
entry: `{ ptr, handle (owned), kind: box|carrier, owner: TABLE | EDGES(n),
tombstoned: bool }`. Additional membrane references exist only as **wrapper
edges** (C-side, §3.3), each owning its own dup. Invariant: every owned
QuickJS reference the membrane holds is accounted to exactly one owner —
either the table root or one wrapper's edge list — because QuickJS's cycle
collector decrements child refcounts along `gc_mark`-reported edges, and a
reference marked by an object that does not own it (or owned but unmarked
while claimed) corrupts the count. This is why §3.3's edge lists mirror
ownership exactly, and why the adapter must NEVER mark speculatively.

#### 3.2 Inward wrappers — prompt reclamation

- registry pin (adapter) holds the GC object strongly while the wrapper lives.
- wrapper `finalizer` (C): clear the dedup slot; free every edge handle in the
  wrapper's C edge list with `JS_FreeValueRT` (finalizers may run during
  runtime free — context-level `JS_FreeValue` is not safe there); for each
  freed edge whose entry's owner-count drops to zero, the follow-up
  bookkeeping happens in `__membrane_wrapper_finalized(gc)` (adapter):
  unpin `gcRegistry[gc]`, push freelist, delete the `gcIds` reverse entry, and
  **tombstone** any box entry whose last owner was this wrapper's edges
  (§3.4). The callback touches only GC-side state — no `qjs_*` calls.
- Result: eval'd code dropping a wrapper ⇒ next `JS_RunGC` (or refcount zero)
  reclaims wrapper AND releases the compiled object. No context-lifetime
  retention for the inward direction.

#### 3.3 Wrapper edges + `gc_mark` — cycles through wrappers

Edges = owned QuickJS references stored INTO the compiled heap **through the
membrane traps**. Maintained where the store happens:

- `__membrane_set(gc, k, h)` storing a non-primitive: after the GC-side write
  succeeds, move ownership: if the box entry's owner is `TABLE`, transfer the
  table's ref to a new C-side edge (`qjs_wrapper_add_edge(gc, handle)` — no
  new dup, owner := `EDGES(1)`); if already `EDGES(n)`, add a fresh dup'd
  edge (`qjs_wrapper_add_edge(gc, qjs_dup(handle))`, owner := `EDGES(n+1)`).
  Overwriting/deleting a property whose old value was a box: remove that edge
  (`qjs_wrapper_remove_edge`); if it was the last one, **re-dup to the table
  root first** (owner := `TABLE`), then free the edge's ref.
- `gc_mark` (C, wrapper class): walk the wrapper's own C edge list and
  `JS_MarkValue` each edge's JSValue — refcount-accurate (one mark per owned
  ref), no adapter call, no allocation, no reentrancy.

Effect: a cycle `Q → wrapper(G)` in QuickJS plus `G.prop → box(Q)` written by
**eval'd code through the trap** is fully visible to QuickJS's cycle
collector (Q→W native edge, W→Q via gc_mark) with no external root — both
sides collect pre-teardown; the wrapper finalizer then releases G's pin and
tombstones Q's box entry, and WasmGC collects G and the box. This is the
acceptance-box-3 cycle case, demonstrable with `qjs_run_gc` + the leak hook.

#### 3.4 What is and is NOT collectable before teardown (be honest)

| case | reclaimed when |
| --- | --- |
| wrapper dropped by eval'd code | next QuickJS GC (finalizer) — prompt |
| pure-QuickJS cycle through wrappers (edges written via traps) | QuickJS cycle collector — prompt |
| cross-heap cycle, GC→QJS leg created via trap write (§3.3) | QuickJS cycle collector — prompt |
| box/carrier held only by compiled code | **context teardown only** — WasmGC has no finalization (#988); nothing can observe the drop |
| cross-heap cycle whose box was stored into the GC graph by a **compiled-side write** (no trap ran, no ownership transfer) | **context teardown only** — the table root is invisible to QuickJS's collector |
| tombstone hazard | a box whose ownership had moved to a wrapper edge dies with that wrapper's cycle; if compiled code still holds the box, every later trap on it throws a typed `TypeError("quickjs object was reclaimed with its wrapper cycle (#4245)")` — loud, not dangling. Enumerated residual (§5); `JS2WASM_QJS_MEMBRANE_PIN_ALL=1` (adapter env baked at build? no — read via a shim-settable flag from the harness) disables ownership transfer entirely for debugging (everything strong until teardown, no tombstones, more leaks). |

Context teardown (new, replaces slice-1's "runtime/context intentionally
never freed"): `instantiateQuickjsEvalNamespace` returns the namespace plus a
provider-internal `__membrane` debug object (extra keys are ignored by the
user-module link, which picks exactly the 4 named imports —
`scripts/test262-import-object.mjs:120-133`); its `teardown()` frees every
box-table handle, runs `qjs_run_gc` (wrapper finalizers → pins released),
then `qjs_free_context`/`qjs_free_runtime` (both already exported,
`qjs_shim.c` lifecycle section). The test lane calls it; production instances
still reclaim via host-GC of the whole instance pair.

#### 3.5 Leak-accounting debug hook (acceptance box on the issue)

Adapter exports (always compiled — they are a handful of i32 getters; no env
gate needed because they are unreachable from the seam):
`__membrane_live_wrappers(): i32`, `__membrane_live_boxes(): i32` (excludes
tombstones), `__membrane_live_carriers(): i32`, `__membrane_live_edges(): i32`,
`__membrane_tombstoned(): i32`, `__membrane_trap_errors(): i32` (§ errors
row). Exposed on the returned namespace's `__membrane` object next to
`teardown()` and `runGc()` (→ `qjs_run_gc`). Lane tests assert
allocate→drop→`runGc()`→counts-shrink and teardown→all-zero.

### 4. What changes where (exact files)

**`scripts/quickjs-artifact/qjs_shim.c`** (shim additions only; artifact hash
key already covers the file — `quickjsArtifactCacheKey`,
`scripts/quickjs-eval-provider.mjs:120-146`):

```c
/* membrane callback registration (indices into __indirect_function_table) */
void qjs_set_membrane_callbacks(uint32_t get, uint32_t set, uint32_t has,
                                uint32_t del, uint32_t keys, uint32_t call,
                                uint32_t finalized, uint32_t reserved);
/* wrappers */
qjs_handle qjs_new_wrapper(JSContext *ctx, uint32_t gc_id, int callable); /* dedup; owned */
uint32_t   qjs_wrapper_gc_handle(qjs_handle h);   /* 0xFFFFFFFF when not a wrapper */
/* edges (§3.3) — owned refs accounted to a wrapper, marked in gc_mark */
void qjs_wrapper_add_edge(uint32_t gc_id, qjs_handle h);     /* takes ownership of h's ref */
int  qjs_wrapper_remove_edge(uint32_t gc_id, qjs_handle h);  /* frees that edge's ref */
/* length-based property ops (NUL-safe keys; the *_str variants stay) */
qjs_handle qjs_get_prop_len(JSContext *ctx, qjs_handle obj, const char *k, uint32_t klen);
int        qjs_set_prop_len(JSContext *ctx, qjs_handle obj, const char *k, uint32_t klen, qjs_handle v); /* borrows v */
int        qjs_has_prop_len(JSContext *ctx, qjs_handle obj, const char *k, uint32_t klen);
int        qjs_delete_prop_len(JSContext *ctx, qjs_handle obj, const char *k, uint32_t klen);
/* outward keys/identity/GC */
qjs_handle qjs_own_keys(JSContext *ctx, qjs_handle obj);  /* Array of string keys (JS_GetOwnPropertyNames, JS_GPN_STRING_MASK) */
qjs_handle qjs_new_array(JSContext *ctx);
int        qjs_set_prop_idx(JSContext *ctx, qjs_handle arr, uint32_t i, qjs_handle v); /* borrows v */
uint32_t   qjs_value_ptr(qjs_handle h);                   /* JS_VALUE_GET_PTR; objects only */
void       qjs_run_gc(JSRuntime *rt);                     /* JS_RunGC — deterministic collection for tests */
int        qjs_throw_type_error(JSContext *ctx, const char *msg, uint32_t len);
```

plus the two class defs, the exotic method table (§1.2), the C dedup array,
per-wrapper edge lists, and the saved `(rt, mark_func)` for gc_mark. All
follow the borrow-in/own-out header contract (`qjs_shim.c:24-38`).

**`scripts/quickjs-artifact/build.sh`** — add `-Wl,--export-table
-Wl,--growable-table` to the link flags block (`:139-148`). Changes the
artifact hash → keyed cache rebuild, by design.

**`scripts/quickjs-eval-provider.mjs`**:

- `QUICKJS_ADAPTER_EXTERNS` (`:76-91`): add every new `qjs_*` above.
- `buildQuickjsAdapterSource` (`:199+`): the membrane adapter source — registry
  + `gcIds` Map, `wrapOutbound`, `boxInbound`, `makeQjsBox`, `makeQjsCarrier`
  identity table, the 7 `__membrane_*` exports (i32-annotated), the leak
  getters, and the conversion-table edits of §1.5. When this template string
  passes ~1k lines, extract to `scripts/quickjs-eval-adapter.src.ts` read at
  build time with the ABI consts prepended — keep the baked-consts discipline
  (re-pinned artifact ⇒ different source ⇒ different adapter cache key).
- `instantiateQuickjsEvalNamespace` (link section): table grow/set +
  `qjs_set_membrane_callbacks`, and the `__membrane` debug object (§3.5).
- `selectQuickjsEvalProvider`: unchanged shape; the adapter cache key already
  invalidates on source change.

**`scripts/build-quickjs-eval-provider.mjs`** — extend the canary set
(`QUICKJS_ADAPTER_CANARY_SOURCE` + `verifyQuickjsProvider`): (a) inward canary
— compiled object `{n: 7}` pushed as a global, eval reads `g.n` (must be 7)
and writes `g.n = 8`, compiled side observes 8; (b) outward canary —
`(0,eval)("({a:1})")` then compiled dynamic read `.a`, second eval mutates,
compiled read observes; (c) identity canary — two evals return `globalThis.X`,
compiled `===` is true (needs the any-eq path; if `===` on boxes is not
expressible in the canary module, compare via `Object.is`-equivalent dynamic
helper); (d) leak canary — counts return to baseline after `runGc()` +
teardown. Anti-vacuity rules of the slice-1 record apply (runtime-composed
sources, engine-witnessing expected values).

**`tests/quickjs-eval-membrane.test.ts`** (new; same self-gating probe as
`tests/quickjs-eval-provider.test.ts`) — acceptance-box cases: inward
read/write/identity across evals, outward mutation visibility, method call on
a box, `new Function` body touching a wrapped global, delete/`in`/`ownKeys`
both directions, wrapper drop → `runGc()` → count shrink, trap-write cycle →
collected pre-teardown, compiled-write cycle → NOT collected pre-teardown but
zero after `teardown()` (assert both, so the residual is pinned by a test),
tombstone TypeError shape, defineProperty-on-wrapper TypeError, Symbol-key
no-op. Extend the `quickjs-wasi-artifact.yml` lane job (non-required, #4238
§6) to run this file too.

**NO changes**: `src/**` (compiler and interpreter — verified: Proxy runtime,
accessor drivers, Map identity keys, native-i32 export signatures all already
exist on main), the 4-import seam, `RUNTIME_EVAL_IMPORT_MODULE`, cache-key
functions, default-path selection (`selectCachedRuntimeEvalProvider` branch
shape from #4238 §1 is untouched). If any compiler gap falls out of the §2.1
canary (e.g. a dynamic-access arm without the `$Proxy` front-guard), STOP and
file a separate S-size issue — do not patch codegen under this issue's flag.

### 5. Residual list (what the membrane does NOT give — for #4242's attribution)

1. **Prototype chains do not cross.** `Object.getPrototypeOf` on a wrapper
   answers QuickJS `Object.prototype`; on a box, the Proxy GPO trap is
   unimplemented (target's proto). `instanceof` across heaps is therefore
   meaningless in both directions. Buckets: the realm/lex-env-heritage
   eval-code files (2 per the #4194 census), plus any `built-ins/*` eval
   interplay asserting proto identity of crossed objects.
2. **Descriptor fidelity.** Both directions synthesize
   `{writable,enumerable,configurable} = true` data descriptors;
   `defineProperty` on a wrapper throws. Buckets: the property-descriptor MOP
   family when driven through eval (subset of the ~795-file census bucket in
   #4236 "builtin routing"); `Object.getOwnPropertyDescriptor`-asserting
   eval-code tests.
3. **Symbol keys** deferred both directions (absent/no-op). Buckets:
   `Symbol.*`-keyed eval tests; well-known-symbol protocol tests
   (`Symbol.iterator` on crossed objects ⇒ for-of over a box fails).
4. **Array/exotic identity.** `Array.isArray` false for wrapped compiled
   arrays; boxed QuickJS arrays are not `$Vec`s (no fast indexed path —
   element access still works through the get trap by numeric-string key).
5. **Outward trap errors flatten to `undefined` + debug counter** (module-
   local exception tags, `registry/imports.ts:209`). A QuickJS getter that
   throws is observed by compiled code as `undefined`, not a throw. Fix needs
   a shared-tag or trap-envelope design — future issue.
6. **Tombstoned boxes** (§3.4): live-view death after wrapper-cycle
   collection throws a typed TypeError on later use instead of resurrecting.
7. **Lifetime floors**: boxes/carriers held only by compiled code, and
   cross-heap cycles created by compiled-side writes, reclaim at context
   teardown only (#988).
8. **Unchanged from #4238** (not this issue's regression): direct-eval scope
   ladder and its slice-3 residuals (`var-env-*` ~13, `non-definable-global`
   6, caller `super`/`new.target` ~10, mapped-`arguments` severing, strict
   write-back) — though §1.5's object-global mirroring removes #4238's
   "object-valued caller bindings only primitives" residual for the
   *indirect*/global tier, and callable wrappers un-moot #4238's residual 6:
   eval'd code CAN now call back into compiled code mid-eval, making the
   at-exit global write-back timing observable. Enumerate that as a new,
   measured residual in the slice-3 record here.

### 6. Slice order (3 slices, one Opus implementer each)

**Slice 1 — inward wrappers: read+write on plain data properties, with
identity (L/XL).** `build.sh` table export; shim: classes (finalizer stub +
no gc_mark yet), `qjs_set_membrane_callbacks`, `qjs_new_wrapper`,
`qjs_wrapper_gc_handle`, `qjs_get/set/has/delete_prop_len`,
`qjs_throw_type_error`; exotic hooks get/set/has/delete + get_own_property
(own_keys may return empty this slice); adapter: registry + `gcIds`,
`wrapOutbound`, `__membrane_get/set/has/delete`, seam-arg + globals-mirror
wrapping (§1.5); retention stays context-lifetime (slice 3 fixes); canaries
(a) and the identity half of (c); test cases: inward read/write/identity,
delete/`in`, defineProperty TypeError, Symbol no-op.
*Done-signal:* a compiled object pushed as a global is read AND written by
eval'd code, the compiled side observes the write, and two separate evals see
the same wrapper identity (`(0,eval)("g === h")` where both names mirror the
same GC object) — all under `JS2WASM_EVAL_ENGINE=quickjs`, with the no-flag
suites untouched.

**Slice 2 — outward live views + collapse + calls (L).** Shim:
`qjs_value_ptr`, `qjs_own_keys`, `qjs_new_array`, `qjs_set_prop_idx`,
`__membrane_call` + callable wrapper class + exotic
`get_own_property_names`; adapter: `makeQjsBox` (Proxy), carrier identity
table, `boxInbound` with both collapses (§2.3), function-valued box reads →
carriers, `__membrane_own_keys`; the §2.1 `__extern_method_call`-reaches-
proxy canary; canaries (b), (c); test cases: outward mutation visibility,
method call on box, ownKeys both directions, wrapper-of-box and box-of-
wrapper collapse to originals.
*Done-signal:* acceptance boxes 1 and 2 fully green in the lane; the collapse
canary proves `boxInbound(wrapOutbound(G)) === G` and vice versa.

**Slice 3 — lifetimes: gc_mark, finalizer release, teardown, leak hook (L).**
Shim: edge lists + `qjs_wrapper_add/remove_edge`, real gc_mark + finalizer
(JS_FreeValueRT), `qjs_run_gc`, `__membrane_wrapper_finalized` wiring;
adapter: ownership state machine (§3.1/§3.3), tombstones + typed
use-after-reclaim error, leak getters, `teardown()`; harness `__membrane`
object; canary (d); test cases: drop→runGc→shrink, trap-write cycle
collected pre-teardown, compiled-write cycle NOT collected pre-teardown +
zero after teardown, tombstone error, carrier reclamation (replacing the
slice-2 retain-forever note in the #4238 record — update that file's residual
5). Record the measured leak-accounting numbers and the final residual list
in THIS file.
*Done-signal:* acceptance boxes 3–5 checked with counts quoted here.

### Risks / verify-first probes

- **Cross-module Proxy dispatch is the load-bearing bet of §2.** It rests on
  (a) `$Proxy` rec-group structural canonicalization across the adapter/user
  pair and (b) the closure-call bridge accepting an adapter closure. Both are
  the same class as the proven carrier/accessor crossings, but probe FIRST in
  slice 2: a 10-line canary (adapter returns a box; user module reads one
  property) before building the full handler set. If it fails on a
  base-wrapper cast, the fallback is per-key **accessor properties** on a
  plain box object (snapshot keys at crossing, refresh per crossing —
  `#1888 S5b` accessors are also dispatched by `__extern_get/set`), which
  degrades ownKeys liveness but keeps reads/writes live; note it in §5 if
  taken.
- **`call_indirect` signature match** (§1.3): if the adapter's exports emit
  f64 params anywhere (e.g. a missed annotation), the C call traps with
  "indirect call type mismatch" at the first trap — cheap to catch in the
  slice-1 canary; the fix is annotation discipline, not new compiler surface.
- **gc_mark reentrancy rules**: gc_mark/finalizer C code must not enter the
  adapter (except the two designated callbacks) and the callbacks must not
  call `qjs_*`. Violations deadlock or corrupt the QuickJS GC — put the rule
  in a shim comment block and assert with a C-side `in_gc` flag in debug.
- **Refcount accounting** (§3.1 invariant) is the highest-severity logic
  risk: an edge marked twice or an unowned mark corrupts QuickJS refcounts.
  Keep ALL ownership transitions in two adapter functions
  (`membraneStoreEdge`/`membraneDropEdge`) with a debug counter cross-check
  (`live_edges + table_roots === live_boxes + live_carriers`, asserted in the
  lane after every test).
- **Shared surface**: this issue edits only `scripts/` — no conflict with
  compiler-side lanes; the #4238 slice-2/3 branches DO touch the same two
  provider files, so this issue stacks on the #4238 branch (predecessor-
  stacking rule) and must re-merge it before PR.

### Out of scope (explicit)

- Default flip and parity measurement (#4242); interpreter changes (hard
  constraint — forbidden); quickjs-ng version bump; direct-eval scope ladder
  (#4238 slice 3 owns it); Symbol-key traps; descriptor-fidelity traps;
  shared exception tag / trap error envelope (future issue); `with(S)`
  membrane scope objects; linear lane (#4236 slice 2).

## Premise validation — the outward Proxy claim is CONFIRMED, and it is standalone-only

Verified 2026-08-09 (lead) by direct inspection of emitted WAT for a plain
dynamic-access module (`o[k]` get / set / `k in o`), because the decision
table's "outward live view" row rests entirely on this and slice 2 would be
unbuildable if it were false.

**`target: "standalone"` — CONFIRMED.** The module carries, with no eval and
no Proxy in the source:

| emitted | evidence |
| --- | --- |
| `$$Proxy` struct | fields `ptag i32`, `ptarget (mut anyref)`, `phandler (mut anyref)`, `ptraps`, `revoked (mut i32)` |
| `$$ProxyTraps` struct | all 12 trap fields (`get`/`set`/`has`/`apply`/`deleteProperty`/`getOwnPropertyDescriptor`/`getPrototypeOf`/`setPrototypeOf`/`isExtensible`/`preventExtensions`/`ownKeys`/`defineProperty`) |
| 12 `__proxy_call_*` drivers | `get set has delete gopd gpo spo isext prevext ownkeys define apply` |
| 12 `__proxy_*_dispatch` fns | one per trap (ownkeys has keys+names variants) |
| `__extern_get` / `__extern_set` / `__extern_has` | all present |

So an adapter-minted Proxy IS structurally canonical with the consumer's and
dispatches its trap closures with zero user-codegen change, as the row claims.

**SCOPE LIMIT the row does not state: this is target-specific.** The same
source compiled for the DEFAULT (JS-host) target emits **none** of it — a
2,274-byte module whose dynamic access lowers to a **host import**
`env::__extern_get` (full import list also carries `__box_number`,
`__unbox_number`, `__extern_is_undefined`). There is no in-module MOP to
canonicalize against, so the outward-live-view trick does **not** apply
there. This is fine for this issue — the eval provider lane is standalone,
and a JS-host consumer has a JS runtime available anyway — but the membrane
implementer must not assume cross-target coverage, and any future
"membrane for the JS-host lane" is a separate design.

**Probe trap, recorded so it is not re-hit:** the WAT emits the type as
`$$Proxy` (DOUBLE dollar) and the `ref.test` guards use type INDICES, not
names. The obvious checks — `/\(type \$Proxy\b/` and
`/ref\.test.*\$Proxy/` — therefore both return ZERO on a module that fully
carries the machinery, which reads as a false negative and briefly looked
like the premise had failed. Match on `\$\$Proxy` / enumerate
`\$__proxy_[a-z_]+` identifiers instead.

## Slice 1 — implementation record

Landed 2026-08-09 on `issue-4245-membrane-slice1` (stacked on #4238 slice 3 /
PR #4321). **`src/` is untouched** — every line of this slice is in `scripts/`
and `tests/`, so the interpreter provider, acorn and the IR substrate are
bit-for-bit unchanged and the no-flag path is byte-identical by construction.

### What landed

| file | why |
| --- | --- |
| `scripts/quickjs-artifact/qjs_shim.c` | the membrane itself: two `JSClassDef`s (`CompiledObject` / `CompiledFunction`), the shared `JSClassExoticMethods` table, the non-owning `gc_id → wrapper` dedup array + finalizer, `qjs_set_membrane_callbacks`, `qjs_new_wrapper`, `qjs_wrapper_gc_handle` |
| `scripts/quickjs-artifact/build.sh` | `-Wl,--export-table -Wl,--growable-table` — the trap edge needs the artifact's own `__indirect_function_table` reachable and growable from the harness |
| `scripts/quickjs-eval-provider.mjs` | adapter: pin registry + `qjsWrapOutbound`/`qjsIsMembraneWrappable`, the five `__membrane_*` exports, the GC→QuickJS conversion table's last row, wrapper mirroring in `qjsPushGlobals` / `qjsPushGlobalLexicalCells` / the direct-eval scope snapshot; harness: `bindQuickjsMembraneCallbacks` link step, the `__indirect_function_table` export assertion, and the `membraneProbe` build-time canary |
| `tests/quickjs-eval-membrane.test.ts` | new self-gating lane, 18 cases (read/write/create/identity×2/distinct/call/typeof/callback-arg/`in`/`delete`/defineProperty/Symbol/direct-eval object + closure residual/ABI order/stale-artifact) |
| `tests/quickjs-eval-provider.test.ts` | two #4238 expectations that this slice deliberately RETIRES: the compiled-object refusal and the "object-valued caller binding is shadowed as `undefined`" residual |

### Artifact

The shim changed, so the artifact was rebuilt (reproducibly — a no-change
rebuild first reproduced the old sha bit-for-bit before the edits went in).

| | key | sha256 |
| --- | --- | --- |
| before | `d7ac807e1f14e8e5` | `18caf5889aaaa961f063be31f384f559ff8698a4b12fedaf8aec2524dd84d05f` |
| **after** | **`d8a5a91d6f183b87`** | **`b0662069c241d0430d91c53a3b0e2d1281fd9eb78dd1c93490b0a9dfa70eec5b`** |

1,016,254 bytes raw / 349,808 gzip (was 1,012,154 / 348,364). It still imports
ONLY `wasi_snapshot_preview1`; the new export surface is
`__indirect_function_table` plus the three `qjs_*` wrappers above.

### The trap edge, as built

The plan's §1.3 mechanism works exactly as specified and needed no fallback:
`table.grow(5)` on the artifact's exported function table, five `table.set`s of
the adapter's `__membrane_*` exports, one `qjs_set_membrane_callbacks(...)` with
the slot indices, and C calls them through `((fn_t)(uintptr_t)idx)(…)` — which
clang lowers to `call_indirect` against that table. **No JS closure is on the
trap path.** The all-i32 signatures typecheck at the engine level, so a drift
would be a loud "indirect call type mismatch" on the first trap; none occurred.

The `__membrane_*` ABI is deliberately sentinel-free (the plan's `1`/`2` error
codes are gone): `get`/`call` return an owned handle where `0` means
"undefined" / "throw", and `set`/`has`/`delete` return 1/0. Handle ownership
runs the SAME direction as the shim's ABI note 2 across the callback edge — the
shim mints and frees `h`, `thisH` and every `argv[i]`; the adapter borrows them.

### DECISION: the callable wrapper was pulled FORWARD into slice 1

The spec's §6 puts the callable class and `__membrane_call` in slice 2. Given
slice 3's measurement — 230 of 337 quickjs-only failures are the harness's own
`assert` (182) and `fnGlobalObject` (48) being `ReferenceError` inside eval
bodies — a data-only slice 1 would have moved that bucket by **zero**: the
wrapper would make `assert` *visible* and calling it would still be a TypeError.

The delta measured out small, and that is the actual justification, not the
payoff: the second `JSClassDef` differs from the first by one field (`.call`),
reuses the same exotic table, the same dedup array and the same finalizer;
`__membrane_call` is ~25 lines of adapter TS. The only genuinely new thing is
the invocation itself, and #2928 had already built it —
`__runtime_eval_apply_callable` is a private intrinsic the standalone compiler
lowers to `__apply_closure`, whose cross-module AOT-callable-carrier arm exists
precisely so a separately compiled provider can call back into caller code.
So: pulled forward. Slice 2 keeps the OUTWARD live view (`qjs_value_ptr`,
`makeQjsBox`, the collapses, `own_keys`), which is untouched here.

**That intrinsic is the one silent-failure risk in this slice**, because if the
name-based lowering ever stops firing, the adapter falls back to the stub in its
own source and every call from evaluated code answers `undefined` — green tests,
dead membrane. Two guards: the `20` digit of the build-time `membraneProbe`
canary, and a deliberate check performed while writing this — the stub was
temporarily poisoned to `return 12345` and the canary still read **4321**,
proving the stub is dead code and the intrinsic really fires.

### MEASURED — `language/eval-code/` under the flag

Same scoped set, same container, same command as the #4238 slice-3 A/B:

```
TEST262_TARGET=standalone TEST262_PATH_FILTER='language/eval-code/' \
  JS2WASM_EVAL_ENGINE=quickjs bash scripts/run-test262-vitest.sh
```

| engine | pass / total | |
| --- | --- | --- |
| quickjs BEFORE this slice (#4238 slice 3) | 442 / 816 | 54.2 % |
| **quickjs AFTER this slice** | **560 / 816** | **68.6 %** |
| interpreter (`TEST262_FULL_RUNTIME_EVAL=1`, unchanged) | 779 / 816 | 95.5 % |

**+118 tests.** The whole gain is in the two annexB buckets, which is exactly
where the harness-`assert` dependency lived:

| sub-corpus | qjs before | **qjs after** | interpreter |
| --- | --- | --- | --- |
| `language/eval-code/direct` | 260 / 286 | 260 / 286 | 271 / 286 |
| `language/eval-code/indirect` | 48 / 61 | 48 / 61 | 56 / 61 |
| `annexB/…/eval-code/direct` | 92 / 309 | **155 / 309** | 300 / 309 |
| `annexB/…/eval-code/indirect` | 42 / 160 | **97 / 160** | 152 / 160 |

Bucket 7 is **fully cleared**: zero remaining `assert is not defined` /
`fnGlobalObject is not defined` failures (was 230).

This is short of the slice-3 record's *projected* ceiling of 672, and the
projection itself said why — unblocking a test only lets it reach the thing it
actually tests. The 256 remaining failures bucket as:

| count | shape | owner |
| --- | --- | --- |
| 103 | `Expected SameValue(…)` | mostly annexB B.3.3 value/ordering |
| 64 | "An initialized binding is not created prior to evaluation" | EvalDeclarationInstantiation |
| 32 | "binding is not reinitialized" | EvalDeclarationInstantiation |
| 18 + 14 | "f should be an own property" / `f is not defined` | annexB block-function hoisting |
| ~25 | long tail (redeclaration, `$262.createRealm`, …) | mixed |

i.e. the residual is #4238's **bucket 2** (var-environment fidelity /
`EvalDeclarationInstantiation`, ~102 quickjs-only before this slice and now the
dominant term), not the membrane. That bucket belongs to the #4238 scope-bridge
lane, not to #4245.

Non-regression checks on the same run: `language/*` is unchanged test-for-test
(260/286 and 48/61 both identical), so nothing the membrane touches cost a
previously passing test. `language/eval-code/indirect/realm.js` still fails with
"dereferencing a null pointer [in `__module_init()`]" — pre-existing (that
bucket's count did not move), `$262.createRealm`, not this slice.

### Acceptance criteria — status after slice 1

- [x] **box 1** — a compiled GC object passed in via a runtime-assembled name is
      READ and WRITTEN in evaluated code, the compiled side observes the write,
      and identity is preserved across multiple evals. (Lane cases 1–7; the
      build-time canary asserts the same four properties as one 4-digit reading.)
- [ ] box 2 — outward live view (slice 2).
- [ ] box 3 — lifetimes / leak accounting (slice 3). Retention is
      context-lifetime here, by design: the wrapper finalizer clears the dedup
      slot (so a collected wrapper is never handed out again) but does NOT
      release the adapter's pin, and there is no `gc_mark`.
- [~] box 4 — the lane exists (`tests/quickjs-eval-membrane.test.ts`, 18 cases)
      and is green together with `tests/quickjs-eval-provider.test.ts`
      (46 total). The default-path suites (`issue-2928-refusal-provider`,
      `issue-2960`, `issue-2928-e6-provider-cache`, `issue-1102`, `issue-4162`,
      `issue-2657-raw-wasi-fd-import`) are green with no env set: 73 passed,
      1 skipped.
- [~] box 5 — residuals below; the outward/lifetime ones are still slices 2–3.

### Residuals measured or enumerated by THIS slice

1. **A raw closure VALUE is not callable across the membrane** — and this one is
   NEW information, pinned by a lane case. A compiled *top-level function
   binding* works (the caller wraps it in the #2928 AOT callable carrier before
   it reaches the seam — that is the whole 230-file win). A closure *value* —
   `var f = function(){…}` in a caller's local scope, or a closure read off a
   plain compiled object — is **not** carrier-wrapped by the caller, so it
   crosses as a plain non-callable wrapper and a call is a loud QuickJS
   TypeError. Measured, not assumed: `typeof` answers `"object"` and the call
   throws. An adapter cannot fix this — it cannot invoke another module's
   private closure struct, which is exactly why the carrier exists. **The
   follow-up is caller-side codegen** (carrier-wrap closure values written into
   direct-eval cells and returned by `__extern_get` on non-carrier receivers);
   filing it is deliberately left to the lead, since it edits `src/` and this
   issue's hard constraint says to report before touching it.

   **UPDATE (#4307):** the two halves of this residual turned out to have
   DIFFERENT owners, and only one of them is caller-side.
   - The `var f = function(){…}` half — a local closure reached by direct eval,
     and the same shape at script scope — **is** caller-side and is FIXED by
     #4307 (`__runtime_eval_wrap_callable` at the direct-eval cell push and the
     globals push, plus an AOT-side unwrap on `compileClosureCall`, which
     otherwise TRAPS once a binding holds a carrier). The lane case above is
     retired: it now reads `1042` (typeof "function" + the compiled body's
     value) instead of `12`.
   - The "closure read off a plain compiled object" half is **NOT caller-side
     reachable, and belongs to SLICE 2** — see the subsection immediately below.

   #### Slice 2 input: plain-object reads never reach the owning module

   `__membrane_get` does `const value: any = target[key]` in the **adapter's
   own compiled code**, and for a plain compiled object that read is answered
   **structurally inside the adapter**, by walking the caller's canonical object
   vector directly. The caller's `__extern_get` is never invoked, so there is no
   caller-side codegen on that path to hook — carrier-wrapping "`__extern_get`
   results" (as this residual originally proposed) cannot work.

   Two probes measured on the slice-1 artifact (`d8a5a91d6f183b87`), standalone
   + `JS2WASM_EVAL_ENGINE=quickjs`, each eval source composed through a runtime
   loop so nothing is constant-folded:

   | probe | expected if caller-routed | measured |
   | --- | --- | --- |
   | `var acc = { get g() { side += 1; return 5 } }`, then `(0,eval)("acc.g + 0")` | `5`, and `side === 1` | **`0`, and `side` stays `0`** — the caller's getter never ran |
   | `class C { m() { return 9 } }`, `inst = new C()`, then `(0,eval)("typeof inst.m")` | `"function"` | **`"undefined"`** — the prototype chain is never consulted |
   | control: `var ctl = { s: "ok" }`, `(0,eval)("ctl.s + '!'").length` | `3` | `3` (own data property, structural read works) |

   So slice 2's `__membrane_get` needs to **delegate the read back to the module
   that owns the object** — the data-side counterpart of the callable carrier —
   rather than reading the vector itself. Getting that right buys three things
   at once that are currently silently wrong, not merely missing: accessors run,
   the prototype chain resolves, and a closure held as an object property comes
   back through the caller's `__extern_get`, where the #4307 carrier wrap
   already exists (`syncedPropertyGetTrampolineBody` wraps closure results
   today, but only for a CARRIER receiver).
2. **Enumeration is empty** — `get_own_property_names` is NULL this slice, so
   `Object.keys(wrapper)` / `for…in` over a wrapper yields nothing. Slice 2
   (`__membrane_own_keys` + `qjs_new_array`/`qjs_set_prop_idx`).
3. **Descriptor flags are synthesized** —
   `{writable, enumerable, configurable} = true` for anything present;
   `Object.defineProperty` on a wrapper is a typed TypeError rather than an
   approximation (lane case).
4. **Symbol keys are absent / no-op** in both directions, detected via
   `JS_AtomToValue` + `JS_IsSymbol` so distinct symbols can never alias onto one
   string key. A lane case asserts the no-op is silent, not a trap.
5. **No prototype crossing** — the wrapper's own prototype is the class's
   (null), and every get is answered by the trap, so the compiled object's real
   chain never appears. `instanceof` across heaps stays meaningless.
6. **A compiled callable that THROWS unwinds past QuickJS's frames.** Wasm
   exception tags are module-local and standalone emits single-tag catches, so
   the caller module's exception propagates from the AOT body straight out
   through QuickJS's C frames to the caller's own `try`. The observable outcome
   is right for the dominant case (`assert(false)` inside eval fails the test,
   catchable by the caller), but a `try/catch` written *inside the evaluated
   source* does NOT catch it, and QuickJS's per-call bookkeeping is skipped on
   that path. The context is per-instantiation, so the damage is bounded.
7. **Retention is context-lifetime** on the compiled side (box 3 above).
8. `eval` / `Function` are excluded from wrapper mirroring on purpose — the
   memoized intrinsic markers must stay QuickJS's own natives, or evaluated
   code's `eval(...)` would route back out into the compiled marker and re-enter
   the provider mid-evaluation.

### Deviations from the plan

- **Callable class + `__membrane_call` pulled forward from slice 2** (above).
- **Sentinel-free callback ABI** instead of the plan's `0`/`1`/`2` codes.
- **Ownership of trap arguments moved to the shim** (the plan had the adapter
  freeing `argv[i]`); C created them, so C frees them, on every path.
- **`qjs_get/set/has/delete_prop_len`, `qjs_throw_type_error`, `qjs_run_gc` and
  `qjs_own_keys` were NOT added.** They serve the outward direction and the
  lifetime protocol; adding them now would grow the artifact's ABI surface for
  code no caller has yet.
- **Classes are registered lazily** from `qjs_new_wrapper` via `JS_GetRuntime` +
  `JS_IsRegisteredClass`, rather than by an explicit adapter-called init — it
  removes an ordering obligation from the link step.
- **Direct-eval scope snapshots also wrap** (the plan named only the globals
  mirror in slice 1); it is the same one-line predicate, and it is what makes a
  sloppy caller's local object live inside `with (S)`.

## Slice 2 — implementation record

Implementer: senior-dev, 2026-08-10. Branch `issue-4245-membrane-slice2`,
stacked on `issue-4308-slice-b-edi` at `2aa44ab21` (PR #4343) → slice A
`2c8b8f3fd` (PR #4340) → membrane slice 1 `e8e43ee86` (PR #4335) → #4321 →
#4319. **Adapter-only**: `scripts/quickjs-eval-provider.mjs` +
`tests/quickjs-eval-membrane.test.ts`. No `src/` change, no `qjs_shim.c` change.

### Artifact — NOT moved

The slice was authorized to move the artifact and did not need to. Every
capability below is expressible over the shim exports slice 1 already had
(`qjs_get_prop_str` / `qjs_set_prop_str` / `qjs_call` / `qjs_wrapper_gc_handle`),
with own-key enumeration and `delete` done by realm-side helper functions
installed once per context — the same "keep it in QuickJS, not in C" discipline
`qjsEnsureDirectHelpers` already used. So the plan's `qjs_own_keys`,
`qjs_new_array`, `qjs_set_prop_idx`, `qjs_value_ptr` and `qjs_*_prop_len` were
NOT added.

| | key | sha256 |
| --- | --- | --- |
| before | `d8a5a91d6f183b87` | `b0662069c241d043…` |
| **after** | `d8a5a91d6f183b87` | `b0662069c241d043…` (identical) |

### Measured result (tier-pinned, this tree)

`TEST262_TARGET=standalone TEST262_PATH_FILTER='language/eval-code/'`, 816 files:

| run | pass / 816 |
| --- | --- |
| quickjs, pre-slice-2 (base = `2aa44ab21`) | **710** |
| quickjs, post-slice-2 | **758** |
| interpreter (`TEST262_FULL_RUNTIME_EVAL=1`) | **779** (unchanged) |

- **+48, exactly the projected cluster.** The 710 baseline was re-measured on
  this tree before any edit and reproduced slice B's number exactly.
- **Regressions: 0**, diffed test-for-test over all 816 files. The diff also
  reports **0 error-text changes** among the still-failing files, so nothing
  moved sideways either.
- Gains, by cluster — the three slice B named, complete:

| n | cluster |
| --- | --- |
| 16 | `global:init` (d+i) |
| 16 | `global:existing-global-init` (d+i) |
| 16 | `global:existing-non-enumerable-global-init` (d+i) |

- The quickjs-only gap is now **23 files** (was 71): 8 `func:existing-fn-update`
  + 8 `func:no-skip-param` (slice C), 2 `lang:lex-env-distinct-cls` + 2
  `lang:global-env-rec-eval` (pre-existing), 3 `lang:var-env-var-strict-*`
  (slice D). Correction to slice B's residual table: the 16
  `func:existing-var-update` files it attributed to slice C are
  **both-engines** failures, so they are not part of the parity gap at all.

### What shipped

**1. The outward box is a MIRRORED `$Object`, not an opaque handle box.** A
plain QuickJS object crossing out is a real compiled object carrying that
object's own string-keyed properties (values converted outward, so a nested
object is a box and a function is a carrier), with enumerability reproduced from
the QuickJS descriptor. `__qjs_handle__` is gone — it was write-only, never read,
and it was the whole of the reported defect.

**2. It is kept live by a bidirectional sync at seam granularity.** The boxes
ride the same push/pull discipline as the globals mirror: `qjsSyncBoxes(c, true)`
before entering QuickJS (`qjsEvaluate`, `__runtime_apply_interpreted`) and
`qjsSyncBoxes(c, false)` on every exit **including the throwing one**. A
compiled-side write is detected as `box[k] !== last[k]` against a per-key
baseline recorded at the previous sync, so an evaluation's own mutations are
never clobbered by a stale mirror. Key creation and deletion propagate both ways.

**3. `qjs_wrapper_gc_handle` finally has a caller — the outward COLLAPSE.** It
had been exported by the shim and declared in the externs since slice 1 with no
use on this path, so a compiled object that crossed inward as a membrane wrapper
and was handed straight back to a compiled function (`verifyProperty(o, …)`, a
callback argument) lost its identity: `===` failed and property work landed on a
stand-in. `qjsPublish` now collapses a wrapper handle to `gcRegistry[id]` first.

**4. The globals pull widened from FUNCTION to any non-callable OBJECT.** This
is half the slice, and the descriptor work is worth **zero** without it — which
the measurement showed rather than the reasoning. With only items 1–3 the run
read **726/816 (+16)**: the `global:init` cluster landed and the two `existing-*`
clusters moved from `Invalid descriptor field: __qjs_handle__` to
`TypeError: Cannot convert undefined or null to object`. Those tests do
`var global = fnGlobalObject();` **inside** the eval and then call
`verifyProperty(global, "f", …)` from **top-level compiled code** after it
returns; with objects excluded from the pull the compiled `global` stayed
`undefined` and `Object.getOwnPropertyDescriptor` threw. Slice B's wrapper guard
(`!qjsIsMembraneWrapperHandle(h)`) still protects the caller's own objects from
being downgraded to boxes, and the intrinsic-marker guard is unchanged.

### The two designs that were built, measured, and REJECTED

Both are recorded because both are what the plan called for, and the reason each
fails is a property of the compiled MOP that is not visible from reading it.

**(a) The `Proxy` box (the decision table's choice) — rejected.** The premise
holds as far as it was validated: an adapter-minted `Proxy` IS structurally
canonical with the caller's `$Proxy`, and the caller's `__extern_get`,
`__extern_set`, `__extern_has` and `__getOwnPropertyNames` front-guards do
dispatch its traps cross-module. Measured on a probe: a property read returned
41 through the `get` trap, and `Object.getOwnPropertyNames` returned the
`ownKeys` trap's list.

What the premise validation did not cover is **`__hasOwnProperty` /
`__object_hasOwn`, which have NO `$Proxy` arm** (`object-runtime.ts`,
`emitHasOwn` — it `ref.test`s `$Object`, misses, and falls through the
carrier-bag arm to 0). Measured: `Object.hasOwn(proxyBox, "a")` → **false**,
control on a plain object → true. That is fatal in the specific way this
workstream keeps paying for: test262's `verifyProperty` gates **every**
descriptor check behind `__hasOwnProperty(desc, field)`, so a Proxy box makes
the whole helper a silent no-op — the 48 target files would have gone GREEN
having verified nothing, and a totals-only reading would have called that a
complete success.

**(b) Per-key ACCESSOR properties (the plan's own stated fallback) — also
rejected.** The accessor arms of `__extern_get`/`__extern_set` dispatch through
`__call_accessor_get` → `__call_fn_method_0`, whose only cross-module
front-guard is the **AOT-callable carrier** (#4197). The provider→AOT
*interpreted-callback* marker is recognised by `__apply_closure` alone, and a raw
adapter closure only lands if the caller module happens to carry a structurally
identical arity-0 closure shape. Measured, in this order:

| attempt | result |
| --- | --- |
| `get:` given a factory-produced closure value | no accessor installed at all — gOPD reports a data property. This is a call-site routing rule and it reproduces IN-module: `emitAccessorFn` handles only a literal function expression or an identifier reference |
| `get:` given a literal function expression over a `const` key | accessor installed (gOPD reports `get`), call returns **null** |
| `get:` given the interpreted-callback marker via an identifier reference | accessor installed, call returns **null** |

**Follow-up for the lead (`src/`, out of this issue's scope):** adding a `$Proxy`
arm to `__hasOwnProperty`/`__object_hasOwn` would make a Proxy box viable and
would also fix `Object.prototype.hasOwnProperty` on any user Proxy, which is a
correctness gap independent of eval. Adding the interpreted-callback guard to
`__call_fn_method_N` (it already carries the AOT-carrier one) would make
provider-owned accessors work. Neither was attempted here — this issue's hard
constraint says to report before touching `src/`.

### Anti-vacuity — how each new path is proven live

- **Build-time canary** (`outwardProbe`, expected `6543`): 6000 = the box
  reports the QuickJS object's own keys to `getOwnPropertyNames`/`hasOwn` (the
  digit that catches exactly the Proxy failure above — a box that passes every
  downstream assertion by answering "no own properties"), 500 = a value read off
  it is the real one, 40 = a LATER evaluation's mutation is visible, 3 = a
  compiled-side write reached QuickJS. **Verified non-vacuous**: poisoning
  `qjsBoxKeySpec` to return `""` fails the build with
  `returned 3, expected 6543`.
- **Lane cases** (10 new, `tests/quickjs-eval-membrane.test.ts`, 43 total, green
  together with `tests/quickjs-eval-provider.test.ts` — 71 passed). Two of them
  assert `verifyProperty`'s *preconditions* (`ownKeys` counts exactly 3,
  `hasOwn` answers true) rather than its verdict, and one asserts
  `configurable: false` — a value a synthesized all-true descriptor cannot
  produce. **Verified non-vacuous**: poisoning `qjsBoxReadValue` to answer
  `12345` for numbers turns 4 of the 10 red.
- Every eval source in the lane and the canary is composed through a runtime
  loop, so `tryStaticEvalInline` cannot fold it.

### Residuals — what the outward view does NOT give

1. **Liveness is at SEAM GRANULARITY, not per-read.** A QuickJS getter with side
   effects runs at sync time rather than at compiled-read time, and a mutation
   made and observed strictly between two crossings is invisible. Genuine
   per-read liveness needs one of the two `src/` follow-ups above.
2. **Own properties only — the prototype chain does not cross outward.**
   `box.name` on a boxed Error, `arr.join`, and every inherited method read
   `undefined`. This is deliberate and load-bearing rather than an omission:
   flattening inherited names onto the box would put `hasOwnProperty`,
   `toString`, … on a descriptor object and reintroduce
   `Invalid descriptor field: …` for a different name.
3. **Symbol keys still absent** in both directions (`getOwnPropertyNames` never
   reports them) — unchanged from slice 1.
4. **A boxed QuickJS Array is not a compiled array.** `Array.isArray(box)` is
   false; `length` and the index keys are ordinary mirrored properties, so
   indexed reads and `.length` work but there is no `$Vec` fast path and no
   `for…of`.
5. **Non-configurable / non-writable QuickJS properties are mirrored as
   writable+configurable** data properties — only *enumerability* is reproduced.
   A compiled-side write to a QuickJS non-writable property is accepted locally
   and then silently dropped by QuickJS at the next push.
6. **Sync cost is O(live boxes × keys) per crossing**, and boxes are retained for
   the context lifetime until slice 3's release protocol exists. Bounded in
   practice by one context per test module; worth re-measuring if a long-lived
   context ever accumulates many boxes.
7. **Cycles are safe but not collected.** A self-referential object mirrors
   without recursing (the registry row is inserted before the pull, so the nested
   publish hits it) and a lane case pins that — but reclamation is still slice 3.

### Acceptance criteria — status after slice 2

- [x] **box 1** — inward read/write/identity (slice 1), unchanged.
- [x] **box 2** — an object created inside eval, returned to compiled code and
      mutated by a LATER eval shows the mutation to compiled-side dynamic reads
      (`liveProbe`), and the reverse direction works too (`writeBackProbe`).
      Identity: one QuickJS object read by two evals is one box
      (`boxIdentityProbe`), and a compiled object round-trips to itself
      (`collapseProbe`).
- [ ] box 3 — lifetimes / leak accounting (slice 3). Retention is still
      context-lifetime, by design.
- [x] box 4 — the lane covers the outward cases; the default path is
      byte-identical by construction (no `src/` change at all).
- [~] box 5 — residuals above; the lifetime ones are slice 3's.
