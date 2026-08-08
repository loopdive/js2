---
id: 4241
title: "QuickJS eval membrane — live cross-heap object access both directions + cycle-safe lifetimes (gc_mark), replacing slice-2's copy/box tier"
status: ready
sprint: current
created: 2026-08-08
updated: 2026-08-08
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
# id 4241 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-08 (gh CLI unavailable; pr_scan=degraded). Equivalent open-PR scan
# via the GitHub MCP at reservation time: sole open PR was PR 4250 (#4238
# slice 1, edits the existing 4238 issue file, introduces no new issue ids).
# The id coincides with a merged PR number — shared sequence, not a namespace
# (precedent: 4235/4236/4237).
---

# #4241 — QuickJS eval membrane: live cross-heap objects + cycle-safe lifetimes

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
| `define_own_property` | **NOT trapped** — `JS_ThrowTypeError(ctx, "Object.defineProperty on a compiled object inside eval is not supported (#4241)")`. Loud beats approximated. NOTE: plain assignment does NOT land here because `set_property` below is implemented; only reflective defineProperty does. |
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
| tombstone hazard | a box whose ownership had moved to a wrapper edge dies with that wrapper's cycle; if compiled code still holds the box, every later trap on it throws a typed `TypeError("quickjs object was reclaimed with its wrapper cycle (#4241)")` — loud, not dangling. Enumerated residual (§5); `JS2WASM_QJS_MEMBRANE_PIN_ALL=1` (adapter env baked at build? no — read via a shim-settable flag from the harness) disables ownership transfer entirely for debugging (everything strong until teardown, no tombstones, more leaks). |

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
