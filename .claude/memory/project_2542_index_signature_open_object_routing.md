---
name: project_2542_index_signature_open_object_routing
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

#2542 (MERGED, PR #1830): standalone `o[k]` read/write by a runtime string key
returned 0 / dropped for **index-signature objects** (`{ [s: string]: T }`).

Root cause was a REPRESENTATION mismatch, not a missing runtime. The native
open-`$Object` machinery (`__new_plain_object`/`__extern_get`/`__extern_set`/
`__obj_find`, all defined Wasm fns, zero host imports) already does string-keyed
[[Get]]/[[Set]]. But (1) an index-sig literal `{a:5,b:7}` built a CLOSED nominal
struct (`__extern_get`'s `ref.test $Object` can't match it → read 0); (2) the
index-sig TYPE has empty `getProperties()` so it resolved to an EMPTY struct →
param/return guard-cast to null.

Fix (3 `ctx.standalone`-scoped routing changes, mirrors #1901's open-`$Object`
route): a PURE string-index-signature type (no own named props — anonymous,
type-alias, OR interface) routes to the open `$Object`:
- `literals.ts compileObjectLiteral`: extend the #1901 non-empty gate + the
  empty-`{}` `__new_plain_object` arm to fire on a `getIndexInfoOfType(ctxType,
  ts.IndexKind.String)` contextual type with 0 own props.
- `index.ts resolveWasmType`: such a type → externref, placed BEFORE the
  named-struct lookup (so a pure-index-sig *interface*, already registered as an
  empty struct by `collectInterface`, still resolves to externref — the empty
  struct stays registered but is never used as a value type, so NO type-index
  shift).
- `index.ts ensureStructForType`: skip registering it as an empty struct.

A MIXED `{ a: number; [s: string]: T }` (own named props) is EXCLUDED — it keeps
its concrete struct (static shape consumers read by field). gc/host/wasi
byte-identical. See [[project_standalone_any_string_value_read_substrate]].

Still-open sibling: an `any`-typed empty `{}` then dynamic write
(`const o:any={}; o.x=9`) does NOT persist — a separate empty-`{}` open-object
gap that `hasOwnProperty` shares; out of #2542 scope.
