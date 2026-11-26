// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The Property Descriptor record between a descriptor object and the realm's descriptor pack:
 * ToPropertyDescriptor (§6.2.6.5), FromPropertyDescriptor (§6.2.6.4) and DefinePropertyOrThrow (§7.3.8). The record is
 * the pack's own encoding (`ORDINARY_OBJECT_DESCRIPTOR_ENCODING`): one word of attribute values and presence bits,
 * beside the value, getter and setter. Every read and define goes through the kernel's roles, which serve ordinary
 * and function objects alike (`bag`), so the define logic stays the pack's ValidateAndApplyPropertyDescriptor.
 */
import type { FuncHandle, Instr, LocalDef, TypeHandle } from "../../../wasm/model/instructions.js";
import { buildClosureUndefinedTest } from "./closure-receiver-bodies.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "./ordinary-object-descriptor-common.js";
import type { SourceObjectDefinition } from "./source-object-bodies.js";

export interface DescriptorRecordOperands {
  readonly objectTypeIdx: TypeHandle;
  readonly errorTypeIdx: TypeHandle;
  readonly anyValueTypeIdx: TypeHandle;
  readonly boxedBooleanTypeIdx: TypeHandle;
  /** The kernel's roles: the function-object test, HasProperty, [[Get]] and the two defines over `bag`. */
  readonly match: FuncHandle;
  readonly has: FuncHandle;
  readonly get: FuncHandle;
  readonly defineData: FuncHandle;
  readonly defineAccessor: FuncHandle;
  readonly undefinedValue: readonly Instr[];
  /** The externref of a realm string literal. */
  readonly key: (text: string) => Instr[];
  /** A thrown TypeError with `message`, under the program's exception tag. */
  readonly typeError: (message: string) => Instr[];
}

const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const n = (value: number): Instr => ({ op: "i32.const", value });
const call = (funcIdx: FuncHandle): Instr => ({ op: "call", funcIdx });
const when = (then: Instr[]): Instr => ({ op: "if", blockType: { kind: "empty" }, then });

/** Whether the carrier in `local` is an object the kernel's roles serve: an ordinary object or a function object. */
function isServedObject(d: DescriptorRecordOperands, local: number): Instr[] {
  return [
    get(local),
    call(d.match),
    get(local),
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: d.objectTypeIdx },
    { op: "i32.or" },
  ];
}

/**
 * [[Get]] of `key` on the object in `object` into `result`. A getter is a source closure the realm cannot call until
 * slice O2 (kernel status 3): the run-time abort, never a skipped read.
 */
export function getOrAbort(d: DescriptorRecordOperands, object: number, key: Instr[], result: number): Instr[] {
  return [
    get(object),
    ...key,
    get(object),
    call(d.get),
    set(result),
    n(3),
    { op: "i32.eq" },
    when([{ op: "unreachable" }]),
  ];
}

/** The TypeError messages of ToPropertyDescriptor (V8's, without the offending value). */
const DESCRIPTOR_RECORD_MESSAGES = {
  notObject: "Property description must be an object",
  getter: "Getter must be a function",
  setter: "Setter must be a function",
  mixed: "Invalid property descriptor. Cannot both specify accessors and a value or writable attribute",
} as const;

/** The six fields in the specification's order, each with its presence bit and, for a Boolean field, its value bit. */
const FIELDS = [
  { name: "enumerable", present: flags.enumerableSpecified, flag: flags.enumerable },
  { name: "configurable", present: flags.configurableSpecified, flag: flags.configurable },
  { name: "value", present: flags.hasValue, slot: "value" },
  { name: "writable", present: flags.writableSpecified, flag: flags.writable },
  { name: "get", present: flags.getterSpecified, slot: "getter", accessor: "getter" },
  { name: "set", present: flags.setterSpecified, slot: "setter", accessor: "setter" },
] as const;

/** The realm string literals the record's bodies read: the field names and the TypeError messages. */
export const DESCRIPTOR_RECORD_LITERALS: readonly string[] = [
  ...FIELDS.map((row) => row.name),
  ...Object.values(DESCRIPTOR_RECORD_MESSAGES),
];

/**
 * ToPropertyDescriptor(attributes) -> (word, value, get, set). A non-object is a TypeError; the realm's error object
 * (whose properties the kernel does not serve) is the run-time abort. Each present field is read once (HasProperty,
 * then Get); a flag is its value's ToBoolean (`toBoolean`); `get` / `set` must be callable or `undefined`; accessor and
 * data fields together are a TypeError.
 */
export function buildToPropertyDescriptorDefinition(
  d: DescriptorRecordOperands,
  toBoolean: FuncHandle,
): SourceObjectDefinition {
  const record = descriptorRecordLocals(1);
  const [word, value, getter, setter] = record.slots as [number, number, number, number];
  const field = 5;
  const slots = { value, getter, setter };
  const addBit = (bit: number): Instr[] => [get(word), n(bit), { op: "i32.or" }, set(word)];
  const readField = (row: (typeof FIELDS)[number]): Instr[] => {
    const use: Instr[] =
      "flag" in row
        ? [get(field), call(toBoolean), when(addBit(row.flag))]
        : "accessor" in row
          ? [
              get(field),
              call(d.match),
              ...buildClosureUndefinedTest(field, d.anyValueTypeIdx),
              { op: "i32.or" },
              { op: "i32.eqz" },
              when(d.typeError(DESCRIPTOR_RECORD_MESSAGES[row.accessor])),
              get(field),
              set(slots[row.slot]),
            ]
          : [get(field), set(slots[row.slot])];
    return [
      get(0),
      ...d.key(row.name),
      call(d.has),
      n(1),
      { op: "i32.eq" },
      when([...addBit(row.present), ...getOrAbort(d, 0, d.key(row.name), field), ...use]),
    ];
  };
  const bits = (mask: number): Instr[] => [get(word), n(mask), { op: "i32.and" }, n(0), { op: "i32.ne" }];
  return {
    locals: [...record.locals, { name: "field", type: { kind: "externref" } }],
    body: [
      ...isServedObject(d, 0),
      { op: "i32.eqz" },
      when([
        get(0),
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: d.errorTypeIdx },
        when([{ op: "unreachable" }]),
        ...d.typeError(DESCRIPTOR_RECORD_MESSAGES.notObject),
      ]),
      ...FIELDS.flatMap(readField),
      ...bits(flags.getterSpecified | flags.setterSpecified),
      ...bits(flags.hasValue | flags.writableSpecified),
      { op: "i32.and" },
      when(d.typeError(DESCRIPTOR_RECORD_MESSAGES.mixed)),
      ...record.slots.map(get),
    ],
  };
}

/** The four locals (word, value, getter, setter) a record occupies from `first` on. */
export function descriptorRecordLocals(first: number): { readonly locals: LocalDef[]; readonly slots: number[] } {
  return {
    locals: [
      { name: "word", type: { kind: "i32" } },
      ...["value", "getter", "setter"].map((name): LocalDef => ({ name, type: { kind: "externref" } })),
    ],
    slots: [first, first + 1, first + 2, first + 3],
  };
}

/** Pop a record (word, value, get, set) off the stack into its four `slots`. */
export function storeDescriptorRecord(slots: readonly number[]): Instr[] {
  return [...slots].reverse().map(set);
}

/**
 * DefinePropertyOrThrow(target, key, record): an accessor record (a getter or setter present) is the pack's accessor
 * define, any other (data or generic) its data define, which keeps an accessor for a generic record. A rejection is
 * the pack's TypeError.
 */
export function definePropertyOrThrow(
  d: DescriptorRecordOperands,
  target: Instr[],
  key: Instr[],
  [word, value, getter, setter]: readonly number[],
): Instr[] {
  const flagsWord: Instr[] = [get(word!), { op: "f64.convert_i32_u" }];
  return [
    get(word!),
    n(flags.getterSpecified | flags.setterSpecified),
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...target, ...key, get(getter!), get(setter!), ...flagsWord, call(d.defineAccessor), { op: "drop" }],
      else: [...target, ...key, get(value!), ...flagsWord, call(d.defineData), { op: "drop" }],
    },
  ];
}

/**
 * FromPropertyDescriptor of the own property the kernel's `ownDescriptor` left in `[entryFlags, value, getter,
 * setter]`, onto the fresh ordinary object in `result`: `value` and `writable`, or `get` and `set` (an absent half is
 * `undefined`), then `enumerable` and `configurable`, each an enumerable, writable, configurable data property.
 */
export function fromPropertyDescriptor(
  d: DescriptorRecordOperands,
  defineOwn: (name: string, value: Instr[]) => Instr[],
  [entryFlags, value, getter, setter]: readonly number[],
): Instr[] {
  const flag = (bit: number): Instr[] => [
    get(entryFlags!),
    n(bit),
    { op: "i32.and" },
    n(0),
    { op: "i32.ne" },
    { op: "struct.new", typeIdx: d.boxedBooleanTypeIdx },
    { op: "extern.convert_any" },
  ];
  const half = (local: number): Instr[] => [
    get(local),
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [...d.undefinedValue],
      else: [get(local)],
    },
  ];
  return [
    get(entryFlags!),
    n(flags.accessor),
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...defineOwn("get", half(getter!)), ...defineOwn("set", half(setter!))],
      else: [...defineOwn("value", [get(value!)]), ...defineOwn("writable", flag(flags.writable))],
    },
    ...defineOwn("enumerable", flag(flags.enumerable)),
    ...defineOwn("configurable", flag(flags.configurable)),
  ];
}
