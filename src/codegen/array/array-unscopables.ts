// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6771 S5) `Array.prototype[@@unscopables]`, `--target standalone`.
 *
 * §23.1.3.41: an own data property `{[[Writable]]: false, [[Enumerable]]:
 * false, [[Configurable]]: true}` of `%Array.prototype%` whose value is an
 * OrdinaryObjectCreate(null) object with one `true` data property per
 * listed method. The Array `$NativeProto` glue seeded only its string members
 * and the `@@iterator` alias, so the property was absent — `hasOwnProperty`
 * false, `getOwnPropertyDescriptor` undefined, and the read answered a value
 * whose prototype was not `null` (`Symbol.unscopables/{prop-desc,value}.js`).
 *
 * The entry rides the brand companion like `Symbol.toStringTag`
 * (`NativeProtoBuiltinGlue.symbolDataProps`), so reads, own checks,
 * descriptors, writes (non-writable: a sloppy no-op) and `delete`
 * (configurable) all see one mutable entry. The object is built ONCE, inside
 * the seeder, so every read answers the same identity.
 */
import type { Instr } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { PROTOTYPE_SEED_FLAGS } from "../../runtime/wasmgc/values/prototype-seeder-bodies.js";
import { addStringConstantGlobal, stringConstantExternrefInstrs } from "../helpers/core-delegates.js"; // (#6797) late-bound core

/** `WELL_KNOWN_SYMBOLS.unscopables` (builtin-value-read.ts). */
const UNSCOPABLES_SYMBOL_ID = 11;

/** §23.1.3.41 steps 2–17, in spec order. */
const UNSCOPABLE_ARRAY_METHODS = [
  "at",
  "copyWithin",
  "entries",
  "fill",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flat",
  "flatMap",
  "includes",
  "keys",
  "toReversed",
  "toSorted",
  "toSpliced",
  "values",
] as const;

/** CreateDataProperty's `{writable, enumerable, configurable}` all true (the array-species word). */
const CREATE_DATA_PROPERTY_FLAGS = 0b1011_1111;

/** The unscopables object as an externref operand, or `undefined` without the natives. */
function unscopablesObjectInstrs(ctx: CodegenContext, _seedFctx: FunctionContext): Instr[] | undefined {
  const createIdx = ctx.funcMap.get("__object_create");
  const defineIdx = ctx.funcMap.get("__defineProperty_value");
  const boxBooleanIdx = ctx.funcMap.get("__box_boolean");
  if (createIdx === undefined || defineIdx === undefined || boxBooleanIdx === undefined) return undefined;
  // OrdinaryObjectCreate(null): `Object.getPrototypeOf(unscopables) === null`.
  const out: Instr[] = [{ op: "ref.null.extern" }, { op: "call", funcIdx: createIdx }];
  for (const name of UNSCOPABLE_ARRAY_METHODS) {
    addStringConstantGlobal(ctx, name);
    out.push(
      ...stringConstantExternrefInstrs(ctx, name),
      { op: "i32.const", value: 1 },
      { op: "call", funcIdx: boxBooleanIdx },
      { op: "f64.const", value: CREATE_DATA_PROPERTY_FLAGS },
      // `__defineProperty_value` returns its receiver: the chain stays on the stack.
      { op: "call", funcIdx: defineIdx },
    );
  }
  return out;
}

/** The Array glue's `symbolDataProps`. */
export const ARRAY_PROTO_SYMBOL_DATA_PROPS = [
  { id: UNSCOPABLES_SYMBOL_ID, flags: PROTOTYPE_SEED_FLAGS.symbolTag, value: unscopablesObjectInstrs },
] as const;
