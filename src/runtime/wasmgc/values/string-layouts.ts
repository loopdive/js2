// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { TypeDef } from "../../../wasm/model/module-records.js";

export interface NativeStringLayout {
  readonly nativeStrDataTypeIdx: number;
  readonly anyStrTypeIdx: number;
  readonly nativeStrTypeIdx: number;
  readonly consStrTypeIdx: number;
  readonly hashedStrTypeIdx: number;
  readonly utf8StrDataTypeIdx: number;
  readonly utf8StrTypeIdx: number;
}

export function createErrorStructType(): TypeDef {
  return {
    kind: "struct",
    name: "$Error_struct",
    fields: [
      { name: "tag", type: { kind: "i32" }, mutable: false },
      { name: "message", type: { kind: "externref" }, mutable: true },
      // (#4485) Mutable since the §20.5.3.4 own-`name` slice: `err.name = "X"`
      // is an ordinary writable own-property write (`Error.prototype.name` is
      // `{writable:true}`), and the standalone `.name` READ is a hard
      // `struct.get` of this field, so a write that landed anywhere else was
      // simply invisible — `e.name = ""; e.name` read back `"Error"`. Same
      // rationale as `stack` below; the field index is unchanged, so no other
      // reader moves.
      { name: "name", type: { kind: "externref" }, mutable: true },
      // (#1536) $stack — fieldIdx 3, kept AFTER message(1)/name(2) so their
      // indices stay stable. `error.stack` is non-standard (no normative
      // test262 coverage); materializing a real stack trace needs no Wasm
      // primitive, so standalone constructs it as `ref.null.extern` (reads
      // back as `undefined`, not a trap). Mutable so a future `err.stack = …`
      // write can land here without a struct-type change.
      { name: "stack", type: { kind: "externref" }, mutable: true },
      // (#2188) $userClassId — fieldIdx 4. Per-user-Error-subclass brand that
      // distinguishes sibling `extends Error` classes which all share the SAME
      // builtin parent `$tag` (field 0). `__new_<Parent>` writes the sentinel
      // `-1` (a plain builtin Error / the shared parent ctor has no user-class
      // brand); the subclass `super()` site overwrites it with the subclass's
      // `classTagMap` id (see emitSetSubclassUserBrand in class-bodies.ts). The
      // standalone `instanceof <UserSubclass>` path reads this field instead of
      // the shared builtin tag, so `(new A) instanceof B` is false for distinct
      // siblings A,B. Mutable: the brand is written AFTER struct.new at the
      // per-subclass construction site, not baked into the shared parent ctor.
      // Kept LAST so fields 0..3 stay stable.
      { name: "userClassId", type: { kind: "i32" }, mutable: true },
      // (#2101a R5) $props — fieldIdx 5. Backing store for user-declared OWN
      // fields on an externref-backed Error subclass (`class A extends Error {
      // code = 0 }`). Such an instance IS this `$Error_struct` (no per-subclass
      // WasmGC struct), so own fields have nowhere to live — `this.code = …`
      // previously cast `this` to the vestigial `$A` struct and trapped. Holds
      // an externref to an open `$Object` (the LANDED object-runtime), lazily
      // allocated via `__new_plain_object()` on the first own-field write;
      // reads/writes route through `__extern_get`/`__extern_set`. `ref.null`
      // until first written. Stored as externref (not `ref null $Object`) to
      // avoid a forward type-reference to `$Object` here — `$Object` is
      // registered lazily by the object-runtime, which may run AFTER this
      // struct. Kept LAST so fields 0..4 stay stable.
      { name: "props", type: { kind: "externref" }, mutable: true },
    ],
  };
}

export function createStringDataType(): TypeDef {
  return {
    kind: "array",
    name: "__str_data",
    element: { kind: "i16" },
    mutable: true,
  };
}

export function createAnyStringType(): TypeDef {
  return {
    kind: "struct",
    name: "AnyString",
    fields: [{ name: "len", type: { kind: "i32" }, mutable: false }],
    superTypeIdx: -1,
  };
}

export function createNativeStringType(layout: NativeStringLayout): TypeDef {
  return {
    kind: "struct",
    name: "NativeString",
    fields: [
      { name: "len", type: { kind: "i32" }, mutable: false },
      { name: "off", type: { kind: "i32" }, mutable: false },
      { name: "data", type: { kind: "ref", typeIdx: layout.nativeStrDataTypeIdx }, mutable: false },
    ],
    superTypeIdx: layout.anyStrTypeIdx,
  };
}

export function createConsStringType(layout: NativeStringLayout): TypeDef {
  return {
    kind: "struct",
    name: "ConsString",
    fields: [
      { name: "len", type: { kind: "i32" }, mutable: false },
      // (#3673) left/right are mutable so `__str_flatten` can memoize: after
      // flattening a rope it rewrites the cons in place to (left=flat result,
      // right=""), turning every later flatten of the same rope into a two-
      // field fast path instead of an O(len) re-copy. `len` stays immutable —
      // the rewrite preserves the total length.
      { name: "left", type: { kind: "ref", typeIdx: layout.anyStrTypeIdx }, mutable: true },
      { name: "right", type: { kind: "ref", typeIdx: layout.anyStrTypeIdx }, mutable: true },
    ],
    superTypeIdx: layout.anyStrTypeIdx,
  };
}

export function createHashedStringType(layout: NativeStringLayout): TypeDef {
  return {
    kind: "struct",
    name: "HashedString",
    fields: [
      { name: "len", type: { kind: "i32" }, mutable: false },
      { name: "off", type: { kind: "i32" }, mutable: false },
      { name: "data", type: { kind: "ref", typeIdx: layout.nativeStrDataTypeIdx }, mutable: false },
      { name: "hash", type: { kind: "i32" }, mutable: true },
      { name: "cacheGen", type: { kind: "i32" }, mutable: true },
      { name: "cacheOwner", type: { kind: "anyref" }, mutable: true },
      { name: "cacheEntry", type: { kind: "anyref" }, mutable: true },
      // (#3673 round 21) the owner's props ARRAY at population time — a grow
      // replaces the array, so `ref.eq` on it is a per-object staleness check
      // (replaces the global `__obj_table_gen`, whose bump on ANY object's
      // grow cold-started every cache twice per parse via acorn's options
      // build). Field 4 degrades to a populated flag (0/1).
      { name: "cacheProps", type: { kind: "anyref" }, mutable: true },
    ],
    superTypeIdx: layout.nativeStrTypeIdx,
  };
}

export function createUtf8StringDataType(): TypeDef {
  return {
    kind: "array",
    name: "__str_data_u8",
    element: { kind: "i8" },
    mutable: true,
  };
}

export function createUtf8StringType(layout: NativeStringLayout): TypeDef {
  return {
    kind: "struct",
    name: "Utf8String",
    fields: [
      // JS-visible code-unit (UTF-16) length — preserves observable
      // `.length` / indexing / comparison semantics (issue Non-goals).
      { name: "len", type: { kind: "i32" }, mutable: false },
      // Canonical-ABI byte length (>= len for multi-byte scalars; == len for ascii).
      { name: "byteLen", type: { kind: "i32" }, mutable: false },
      { name: "off", type: { kind: "i32" }, mutable: false },
      { name: "data", type: { kind: "ref", typeIdx: layout.utf8StrDataTypeIdx }, mutable: false },
    ],
    superTypeIdx: layout.anyStrTypeIdx,
  };
}
