// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";

/** The registered name read, in either the host or native string representation. */
export type ErrorNameValue =
  | { readonly kind: "global"; readonly index: number; readonly representation: "gc" | "externref" }
  | { readonly kind: "callable"; readonly handle: number; readonly representation: "gc" }
  | { readonly kind: "legacy-missing" };

/**
 * (#6651 cluster C) The `message` slot producer.
 *
 * §20.5.1.1 step 3 defines `message` **only when the argument is not
 * `undefined`**, so `new Error()` and `new Error(undefined)` have no own
 * `message` while `new Error("m")` does. `fillErrorStructMessageOwnPropArms`
 * already answers `hasOwnProperty`/gOPD/`delete` from "field 1 is non-null",
 * which makes this the one place the distinction has to be made.
 *
 * The plain `local.get 0` is correct only when the caller can pass an absent
 * argument as a NULL externref. A derived builtin subclass cannot: the
 * implicit `class Err extends TypeError {}` forwarder has a fixed arity, so
 * `new Err()` pads slot 0 with the canonical `undefined` singleton and the
 * field came out non-null. Callers that can tell the two apart pass a
 * `messageSlot` that maps `undefined` back to null.
 */
export function buildErrorConstructorBody(
  structIdx: number,
  tagValue: number,
  argCount: number,
  name: ErrorNameValue,
  /** Replaces the bare `local.get 0` read of the message argument. */
  messageSlot?: readonly Instr[],
): Instr[] {
  const nameInstrs: Instr[] =
    name.kind === "legacy-missing"
      ? [{ op: "ref.null.extern" }]
      : name.kind === "global"
        ? [{ op: "global.get", index: name.index }]
        : [{ op: "call", funcIdx: name.handle }];
  if (name.kind !== "legacy-missing" && name.representation === "gc") nameInstrs.push({ op: "extern.convert_any" });
  const messageInstrs: Instr[] =
    argCount > 0
      ? messageSlot !== undefined
        ? [...messageSlot]
        : [{ op: "local.get", index: 0 }]
      : [{ op: "ref.null.extern" }];
  return [
    { op: "i32.const", value: tagValue },
    ...messageInstrs,
    ...nameInstrs,
    // Preserve the existing stack initializer and lazy property bag.
    { op: "ref.null.extern" },
    { op: "i32.const", value: -1 },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: structIdx },
    { op: "extern.convert_any" },
  ];
}

/**
 * (#6651 cluster C) Map an `undefined` message argument back to a NULL field.
 *
 * ## The defect, measured on this branch's base (standalone, `.tmp/w6651C/e2.ts`)
 *
 * | probe | base | node |
 * | --- | --- | --- |
 * | `new TypeError().hasOwnProperty("message")` | false | false |
 * | `class Err extends TypeError {}; new Err().hasOwnProperty("message")` | **true** | false |
 *
 * The two disagree because they reach `__new_TypeError` differently. A direct
 * `new TypeError()` is lowered with `argCount === 0`, so the builder stores
 * `ref.null.extern` in field 1 and every own-property surface
 * (`fillErrorStructMessageOwnPropArms`) correctly reports absence. The derived
 * subclass goes through a fixed-arity forwarder — `Err_new : (externref) ->
 * externref` — and `new Err()` pads slot 0 with the canonical `undefined`
 * singleton (`global.get $undefined`, WAT-verified). That is a NON-null
 * externref, so the same field said "present".
 *
 * Which is why the fix belongs here and not in the forwarder: passing
 * `undefined` to `super()` is exactly what the default derived constructor
 * does (§15.7.14 — `constructor(...args) { super(...args) }` with zero args),
 * so the value is right and the CONSTRUCTOR is the step that must ignore it.
 * §20.5.1.1 step 3: *"If message is not undefined, then … CreateNonEnumerable
 * DataPropertyOrThrow(O, "message", msg)"*.
 *
 * ## Narrowing
 *
 * Only the tag-1 `$AnyValue` box — the one canonical `undefined` — is mapped to
 * null. A `$BoxedNumber` carrying the UNDEF_F64 sentinel is NOT tested for:
 * that arm exists in `buildIsUndefinedExternBody` for values that have crossed
 * an f64 slot, which a message argument has not, and testing it would cost a
 * second branch in every error construction for a shape no row produces.
 * Absent-not-wrong: an unrecognised carrier keeps today's behaviour exactly.
 *
 * Returns `undefined` when the constructor takes no message argument: its body
 * already stores `ref.null.extern`. A module with no `$AnyValue` type (host/gc
 * lane, or a native-first module that never reserved it) has no `undefined` box
 * to test, so the caller does not ask (`fillErrorCtorUndefinedMessage`).
 */
export function buildUndefinedAwareMessageSlot(
  anyTypeIdx: number,
  argCount: number,
  existingLocalCount: number,
): { instrs: Instr[]; locals: LocalDef[] } | undefined {
  if (argCount <= 0) return undefined;
  // APPENDED after the params and any existing locals, so every index already
  // baked into the body keeps its meaning.
  const scratch = argCount + existingLocalCount;
  return {
    locals: [{ name: "__errmsg_any", type: { kind: "anyref" } }],
    instrs: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: scratch },
      { op: "ref.test", typeIdx: anyTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [
          { op: "local.get", index: scratch },
          { op: "ref.cast", typeIdx: anyTypeIdx },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
          { op: "i32.const", value: 1 },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [{ op: "ref.null.extern" }],
            else: [{ op: "local.get", index: 0 }],
          },
        ],
        else: [{ op: "local.get", index: 0 }],
      },
    ],
  };
}
