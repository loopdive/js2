// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4241) The closure-struct HEADER layout — the single source of truth for the
 * fields every struct in the funcref-wrapper root hierarchy carries before its
 * captures, and for the predicate that recognises that header.
 *
 * ## Why this is its own module
 * The layout used to be stated in TWO places that could not see each other: the
 * mint-site constants in `funcref-wrapper-types.ts`, and a hand-written
 * `type.fields.length === 2 && fields[0] is funcref && fields[1] is i32`
 * validator inside `program-abi-type-planning.ts`'s IR closure-support check.
 * Adding the `$bag` slot satisfied the constants and silently violated the
 * validator, which does not warn — it THROWS, so all five async functions in
 * `website/playground/examples/js/async.ts` failed IR-first with
 * "non-canonical physical wrapper root" and the `check:ir-only` readiness gate
 * exited 1. Nothing in the type system connected the two statements.
 *
 * `funcref-wrapper-types.ts` cannot host the predicate, because it imports the
 * codegen barrel (`../index.js`) and `program-abi-type-planning.ts` is reachable
 * from that barrel — importing it there would close an initialization cycle
 * around `const` exports. So this module is a LEAF, importing only TYPES, for
 * the same reason and in the same shape as `closure-classifier.ts`: one
 * definition, many consumers, never two divergent copies.
 *
 * ## The layout
 * ```
 *   0  func    funcref     the lifted function reference
 *   1  $arity  i32         (#3673) declared user formal count
 *   2  $bag    externref   (#4241) carrier-intrinsic expando bag, mutable,
 *                          null until the carrier grows its first property
 *   3+ captures / TDZ flag cells / __constructible / subtype-specific fields
 * ```
 * Every capture read/write and TDZ-slot index derives from
 * {@link CLOSURE_CAPTURE_FIELD_BASE}, never a bare literal — and now so does
 * every VALIDATOR of the header.
 */
import type { FieldDef, Instr, ValType } from "../../ir/types.js";

/** Field 0 — the lifted function reference. */
export const CLOSURE_FUNC_FIELD_IDX = 0;
/** Field 1 — (#3673) the closure's declared user formal count. */
export const CLOSURE_ARITY_FIELD_IDX = 1;
/** Field 2 — (#4241) the carrier-intrinsic expando-bag slot. */
export const CLOSURE_BAG_FIELD_IDX = 2;
/** First capture field. Also the header's field COUNT, by construction. */
export const CLOSURE_CAPTURE_FIELD_BASE = 3;

/** The `$arity` field definition — shared by every closure-struct mint site. */
export function closureArityField(): { name: string; type: ValType; mutable: false } {
  return { name: "$arity", type: { kind: "i32" }, mutable: false };
}

/**
 * The `$bag` field definition — shared by every closure-struct mint site.
 * MUTABLE, so a WasmGC subtype must redeclare it with the identical type and
 * mutability (field types are invariant for mutable fields); using this one
 * factory everywhere is what guarantees that. The `$` prefix keeps it out of
 * name enumeration and getter emission, matching `$arity` and `$shape`.
 */
/**
 * (#4241) The field NAME of the carrier-intrinsic expando bag. Exported so
 * every consumer resolves the slot by NAME rather than by index — the slot does
 * not stay last (`property-access-dispatch.ts` appends fields to already-
 * registered structs) and it sits at different indices in different carrier
 * families (index 2 in the closure header, appended in an instance carrier).
 */
export const INSTANCE_BAG_FIELD = "$bag";

export function closureBagField(): { name: string; type: ValType; mutable: true } {
  return { name: "$bag", type: { kind: "externref" }, mutable: true };
}

/**
 * The `struct.new` operand for a freshly-minted closure's `$bag` slot. Sits
 * between the `$arity` i32 and the first capture at EVERY closure allocation
 * site — a missed site is a loud `struct.new` arity/type validation failure,
 * never a silent wrong answer.
 */
export function closureBagInitInstr(): Instr {
  return { op: "ref.null.extern" };
}

/**
 * Does `fields` START with the canonical closure header? True for a bare
 * wrapper root and for any subtype that correctly redeclares the header before
 * its own fields.
 *
 * Checked by KIND rather than by identity with the factories above, because the
 * consumers that ask this question are validating types the allocator already
 * built and canonicalized — a structural question, not a provenance one.
 */
export function hasClosureHeaderPrefix(fields: readonly (FieldDef | undefined)[]): boolean {
  return (
    fields.length >= CLOSURE_CAPTURE_FIELD_BASE &&
    fields[CLOSURE_FUNC_FIELD_IDX]?.type.kind === "funcref" &&
    fields[CLOSURE_ARITY_FIELD_IDX]?.type.kind === "i32" &&
    fields[CLOSURE_BAG_FIELD_IDX]?.type.kind === "externref"
  );
}

/**
 * Is `fields` EXACTLY the canonical header and nothing else — i.e. a bare
 * wrapper root / signature wrapper with no captures?
 */
export function isCanonicalClosureHeader(fields: readonly (FieldDef | undefined)[]): boolean {
  return fields.length === CLOSURE_CAPTURE_FIELD_BASE && hasClosureHeaderPrefix(fields);
}

/**
 * The field count a captured subtype must have for `captureCount` captures:
 * the header plus one field per capture.
 */
export function closureSubtypeFieldCount(captureCount: number): number {
  return CLOSURE_CAPTURE_FIELD_BASE + captureCount;
}
