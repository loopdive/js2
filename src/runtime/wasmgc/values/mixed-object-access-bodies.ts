// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "./ordinary-object-descriptor-common.js";

/** Internal results, not a scalar JavaScript Get/Has ABI. */
export const MIXED_ACCESS_STATUS = Object.freeze({ absent: 0, present: 1, unready: 2, unsupported: 3 });
export interface MixedObjectCarrier {
  readonly kind: "ordinary" | "wrapper" | "string" | "source" | "native" | "object-prototype";
  readonly typeIdx: number;
  readonly stateField?: number;
  readonly native?: {
    readonly metadataId: number;
    readonly liftedTypeIdx: number;
    readonly singleton: number;
    readonly singletonExtern: boolean;
  };
}
export interface MixedObjectAccessOperands {
  readonly objectTypeIdx: number;
  readonly entryTypeIdx: number;
  readonly stateTypeIdx: number;
  readonly anyStringTypeIdx: number;
  readonly symbolTypeIdx: number;
  readonly realm: number;
  readonly objectPrototype: number;
  readonly metadataTypes: readonly number[];
  /** String precedes ordinary storage; metadata families precede source families. */
  readonly carriers: readonly MixedObjectCarrier[];
  readonly classify: FuncHandle;
  readonly own: FuncHandle;
  readonly lookup: FuncHandle;
  readonly getPrototypeOf: FuncHandle;
  readonly findOrdinary: FuncHandle;
  readonly findString: FuncHandle;
}
export type MixedObjectDefinition = { locals: LocalDef[]; body: Instr[] };
function data(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(input))
  )
    throw Error("mixed object bodies: plain data operands required");
  const fields = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(fields)) {
    if (
      typeof key !== "string" ||
      ![...required, ...optional].includes(key) ||
      !Object.hasOwn(fields[key]!, "value") ||
      !fields[key]!.enumerable
    )
      throw Error("mixed object bodies: unknown/hidden/accessor operand");
  }
  if (required.some((key) => !Object.hasOwn(fields, key))) throw Error("mixed object bodies: missing operand");
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]));
}
function coordinate(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw Error("mixed object bodies: invalid coordinate");
}
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    throw Error("mixed object bodies: dense rows required");
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== value.length + 1) throw Error("mixed object bodies: sparse or extended rows");
  return Array.from({ length: value.length }, (_, i) => {
    const field = fields[String(i)];
    if (!field || !Object.hasOwn(field, "value") || !field.enumerable) throw Error("mixed object bodies: non-data row");
    return field.value;
  });
}
function operands(input: MixedObjectAccessOperands): MixedObjectAccessOperands {
  const keys = [
    "objectTypeIdx",
    "entryTypeIdx",
    "stateTypeIdx",
    "anyStringTypeIdx",
    "symbolTypeIdx",
    "realm",
    "objectPrototype",
    "classify",
    "own",
    "lookup",
    "getPrototypeOf",
    "findOrdinary",
    "findString",
  ];
  const d = data(input, [...keys, "carriers", "metadataTypes"]);
  keys.forEach((key) => coordinate(d[key]));
  const metadataTypes = rows(d.metadataTypes);
  metadataTypes.forEach(coordinate);
  const carriers = rows(d.carriers).map((row) => {
    const c = data(row, ["kind", "typeIdx"], ["stateField", "native"]);
    coordinate(c.typeIdx);
    if (!["ordinary", "wrapper", "string", "source", "native", "object-prototype"].includes(c.kind as string))
      throw Error("mixed object bodies: unknown family");
    if (["ordinary", "wrapper", "string", "source"].includes(c.kind as string)) {
      coordinate(c.stateField);
      if (
        c.native !== undefined ||
        (c.kind === "ordinary" && c.stateField !== 6) ||
        (["wrapper", "string"].includes(c.kind as string) && c.stateField !== 7) ||
        (c.kind === "source" && c.stateField < 3)
      )
        throw Error("mixed object bodies: invalid state tail");
    } else if (Object.hasOwn(c, "stateField")) throw Error("mixed object bodies: unexpected state tail");
    if (c.kind === "native") {
      const entry = data(c.native, ["metadataId", "liftedTypeIdx", "singleton", "singletonExtern"]);
      [entry.metadataId, entry.liftedTypeIdx, entry.singleton].forEach(coordinate);
      if (typeof entry.singletonExtern !== "boolean")
        throw Error("mixed object bodies: invalid singleton representation");
      c.native = entry;
    } else if (Object.hasOwn(c, "native")) throw Error("mixed object bodies: unexpected native entry");
    return c;
  });
  if (carriers.filter((c) => c.kind === "string").length !== 1 || carriers[0]?.kind !== "string")
    throw Error("mixed object bodies: String family must precede storage");
  return { ...d, carriers, metadataTypes } as unknown as MixedObjectAccessOperands;
}
const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const n = (value: number): Instr => ({ op: "i32.const", value });
const call = (funcIdx: FuncHandle): Instr => ({ op: "call", funcIdx });
const global = (index: number): Instr => ({ op: "global.get", index });
const ext = { kind: "externref" } as const,
  i32 = { kind: "i32" } as const,
  empty = { kind: "empty" } as const;
const ret = (...body: Instr[]): Instr[] => [...body, { op: "return" }];
const when = (condition: Instr[], then: Instr[]): Instr[] => [...condition, { op: "if", blockType: empty, then }];
const cast = (local: number, typeIdx: number): Instr[] => [
  get(local),
  { op: "any.convert_extern" },
  { op: "ref.cast", typeIdx },
];
const field = (local: number, typeIdx: number, fieldIdx: number): Instr[] => [
  ...cast(local, typeIdx),
  { op: "struct.get", typeIdx, fieldIdx },
];
const state = (d: MixedObjectAccessOperands, c: MixedObjectCarrier, local = 0): Instr[] =>
  field(local, c.typeIdx, c.stateField!);
const gap = (local: number): Instr[] => [
  get(local),
  n(-2),
  { op: "i32.eq" },
  { op: "if", blockType: { kind: "val", type: i32 }, then: [n(2)], else: [n(3)] },
];
const missing = (d: MixedObjectAccessOperands, status: Instr[]): Instr[] =>
  ret(...status, { op: "ref.null", typeIdx: d.entryTypeIdx });
const identity = (a: Instr[], b: Instr[]): Instr[] => [
  ...a,
  { op: "any.convert_extern" },
  { op: "ref.cast_null", typeIdx: -19 },
  ...b,
  { op: "any.convert_extern" },
  { op: "ref.cast_null", typeIdx: -19 },
  { op: "ref.eq" },
];
function carrierArm(local: number, ordinal: number, body: Instr[]): Instr[] {
  return when([get(local), n(ordinal + 1), { op: "i32.eq" }], body);
}
function ownBag(d: MixedObjectAccessOperands, c: MixedObjectCarrier): Instr[] {
  return c.kind === "native" || c.kind === "source" ? field(0, c.typeIdx, 2) : [get(0)];
}

/** Exact carrier/realm checks precede every private field read. -2 is pending authority. */
export function buildMixedObjectClassify(input: MixedObjectAccessOperands): MixedObjectDefinition {
  const d = operands(input);
  const native = d.carriers.filter((c) => c.kind === "native"),
    other = d.carriers.filter((c) => c.kind !== "native" && c.kind !== "source"),
    source = d.carriers.filter((c) => c.kind === "source");
  const arm = (c: MixedObjectCarrier): Instr[] => {
    let checks: Instr[];
    if (c.kind === "native") {
      const e = c.native!;
      checks = [
        ...field(0, c.typeIdx, 4),
        n(e.metadataId),
        { op: "i32.eq" },
        ...field(0, c.typeIdx, 6),
        global(d.realm),
        { op: "ref.eq" },
        { op: "i32.and" },
        ...cast(0, c.typeIdx),
        global(e.singleton),
        ...(e.singletonExtern
          ? ([{ op: "any.convert_extern" }, { op: "ref.cast_null", typeIdx: c.typeIdx }] as Instr[])
          : []),
        { op: "ref.eq" },
        { op: "i32.and" },
        ...field(0, c.typeIdx, 0),
        { op: "ref.test", typeIdx: e.liftedTypeIdx },
        { op: "i32.and" },
      ];
    } else if (c.kind === "object-prototype") {
      checks = [...cast(0, c.typeIdx), global(d.objectPrototype), { op: "ref.eq" }];
    } else {
      checks = [
        ...state(d, c),
        { op: "struct.get", typeIdx: d.stateTypeIdx, fieldIdx: 1 },
        global(d.realm),
        { op: "ref.eq" },
      ];
    }
    const matched = when(checks, ret(n(c.kind === "source" ? -2 : d.carriers.indexOf(c) + 1)));
    return when(
      [get(0), { op: "any.convert_extern" }, { op: "ref.test", typeIdx: c.typeIdx }],
      c.native?.singletonExtern
        ? when(
            [global(c.native.singleton), { op: "any.convert_extern" }, { op: "ref.test", typeIdx: c.typeIdx }],
            matched,
          )
        : matched,
    );
  };
  return {
    locals: [],
    body: [
      ...when([global(d.realm), { op: "ref.is_null" }], ret(n(-2))),
      ...other.flatMap(arm),
      ...native.flatMap(arm),
      // Never let an unknown builtin metadata subtype become a source function.
      ...d.metadataTypes.flatMap((typeIdx) =>
        when([get(0), { op: "any.convert_extern" }, { op: "ref.test", typeIdx }], ret(n(0))),
      ),
      ...source.flatMap(arm),
      n(0),
    ],
  };
}

/** Actual own entries only. Incomplete intrinsic/source misses are unready, never absence. */
export function buildMixedObjectOwn(input: MixedObjectAccessOperands): MixedObjectDefinition {
  const d = operands(input);
  return {
    locals: [
      { name: "family", type: i32 },
      { name: "bag", type: ext },
      { name: "entry", type: { kind: "ref_null", typeIdx: d.entryTypeIdx } },
    ],
    body: [
      get(0),
      call(d.classify),
      { op: "local.tee", index: 2 },
      n(0),
      { op: "i32.le_s" },
      { op: "if", blockType: empty, then: missing(d, gap(2)) },
      ...when(
        [
          get(1),
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: d.anyStringTypeIdx },
          get(1),
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: d.symbolTypeIdx },
          { op: "i32.or" },
          { op: "i32.eqz" },
        ],
        missing(d, [n(3)]),
      ),
      ...d.carriers.flatMap((c, ordinal) =>
        carrierArm(2, ordinal, [
          ...ownBag(d, c),
          set(3),
          ...when([get(3), { op: "ref.is_null" }], missing(d, [n(2)])),
          ...when(
            [get(3), { op: "any.convert_extern" }, { op: "ref.test", typeIdx: d.objectTypeIdx }, { op: "i32.eqz" }],
            missing(d, [n(3)]),
          ),
          ...cast(3, d.objectTypeIdx),
          get(1),
          call(c.kind === "string" ? d.findString : d.findOrdinary),
          set(4),
          ...when(
            [get(4), { op: "ref.is_null" }],
            missing(d, [n(["native", "source", "object-prototype"].includes(c.kind) ? 2 : 0)]),
          ),
          ...ret(n(1), get(4)),
        ]),
      ),
      { op: "unreachable" },
    ],
  };
}

/** Actual parent identity. A successful null result is distinct from an unready result. */
export function buildMixedObjectGetPrototype(input: MixedObjectAccessOperands): MixedObjectDefinition {
  const d = operands(input);
  return {
    locals: [{ name: "family", type: i32 }],
    body: [
      get(0),
      call(d.classify),
      { op: "local.tee", index: 1 },
      n(0),
      { op: "i32.le_s" },
      { op: "if", blockType: empty, then: ret(...gap(1), { op: "ref.null", typeIdx: -17 }) },
      ...d.carriers.flatMap((c, ordinal) =>
        carrierArm(
          1,
          ordinal,
          ret(
            n(1),
            ...(c.kind === "object-prototype"
              ? ([{ op: "ref.null", typeIdx: -17 }] as Instr[])
              : c.kind === "native"
                ? field(0, c.typeIdx, 5)
                : ([...state(d, c), { op: "struct.get", typeIdx: d.stateTypeIdx, fieldIdx: 0 }] as Instr[])),
          ),
        ),
      ),
      { op: "unreachable" },
    ],
  };
}

/** A slow cursor detects malformed existing cycles without a depth/argument-count limit. */
function advanceSlow(
  d: MixedObjectAccessOperands,
  slow: number,
  ticks: number,
  status: number,
  failure: Instr[],
): Instr[] {
  return [
    get(ticks),
    n(1),
    { op: "i32.xor" },
    { op: "local.tee", index: ticks },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: empty,
      then: [
        get(slow),
        call(d.getPrototypeOf),
        set(slow),
        set(status),
        ...when([get(status), n(1), { op: "i32.ne" }], failure),
      ],
    },
  ];
}
export function buildMixedObjectLookup(input: MixedObjectAccessOperands): MixedObjectDefinition {
  const d = operands(input);
  const failed = missing(d, [get(4)]);
  return {
    locals: [
      { name: "cursor", type: ext },
      { name: "entry", type: { kind: "ref_null", typeIdx: d.entryTypeIdx } },
      { name: "status", type: i32 },
      { name: "slow", type: ext },
      { name: "ticks", type: i32 },
    ],
    body: [
      get(0),
      set(2),
      get(0),
      set(5),
      {
        op: "loop",
        blockType: empty,
        body: [
          get(2),
          get(1),
          call(d.own),
          set(3),
          { op: "local.tee", index: 4 },
          ...when([], ret(get(4), get(3))),
          get(2),
          call(d.getPrototypeOf),
          set(2),
          set(4),
          ...when([get(4), n(1), { op: "i32.ne" }], failed),
          ...when([get(2), { op: "ref.is_null" }], missing(d, [n(0)])),
          get(2),
          call(d.classify),
          { op: "local.tee", index: 4 },
          n(0),
          { op: "i32.le_s" },
          { op: "if", blockType: empty, then: missing(d, gap(4)) },
          ...advanceSlow(d, 5, 6, 4, failed),
          ...when(identity([get(2)], [get(5)]), missing(d, [n(3)])),
          { op: "br", depth: 0 },
        ],
      },
      { op: "unreachable" },
    ],
  };
}
/** Has preserves gaps and never reads a returned entry's value or calls its getter. */
export function buildMixedObjectHas(input: MixedObjectAccessOperands): MixedObjectDefinition {
  const d = operands(input);
  return { locals: [], body: [get(0), get(1), call(d.lookup), { op: "drop" }] };
}

/** SetPrototypeOf: SameValue first, immutable Object.prototype, extensibility, then complete cycle check. */
export function buildMixedObjectSetPrototype(input: MixedObjectAccessOperands): MixedObjectDefinition {
  const d = operands(input);
  const failed = ret(get(5));
  const mutation = (c: MixedObjectCarrier): Instr[] =>
    c.kind === "native"
      ? [...cast(0, c.typeIdx), get(1), { op: "struct.set", typeIdx: c.typeIdx, fieldIdx: 5 }]
      : [...state(d, c), get(1), { op: "struct.set", typeIdx: d.stateTypeIdx, fieldIdx: 0 }];
  return {
    locals: [
      { name: "family", type: i32 },
      { name: "cursor", type: ext },
      { name: "bag", type: ext },
      { name: "status", type: i32 },
      { name: "slow", type: ext },
      { name: "ticks", type: i32 },
    ],
    body: [
      get(0),
      call(d.classify),
      { op: "local.tee", index: 2 },
      n(0),
      { op: "i32.le_s" },
      { op: "if", blockType: empty, then: ret(...gap(2)) },
      get(0),
      call(d.getPrototypeOf),
      set(3),
      set(5),
      ...when([get(5), n(1), { op: "i32.ne" }], failed),
      // Authenticated parents are internal references/null. Unknown stored links are refused by the walk below.
      ...when([get(3), { op: "ref.is_null" }], when([get(1), { op: "ref.is_null" }], ret(n(1)))),
      ...when(
        [
          get(3),
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: -19 },
          get(1),
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: -19 },
          { op: "i32.and" },
        ],
        when(identity([get(3)], [get(1)]), ret(n(1))),
      ),
      ...d.carriers.flatMap((c, ordinal) =>
        carrierArm(
          2,
          ordinal,
          c.kind === "object-prototype"
            ? ret(n(0))
            : [
                ...ownBag(d, c),
                set(4),
                ...when([get(4), { op: "ref.is_null" }], ret(n(2))),
                ...when(
                  [
                    get(4),
                    { op: "any.convert_extern" },
                    { op: "ref.test", typeIdx: d.objectTypeIdx },
                    { op: "i32.eqz" },
                  ],
                  ret(n(3)),
                ),
                ...when([...field(4, d.objectTypeIdx, 4), n(flags.nonExtensible), { op: "i32.and" }], ret(n(0))),
              ],
        ),
      ),
      get(1),
      set(3),
      get(1),
      set(6),
      {
        op: "block",
        blockType: empty,
        body: [
          {
            op: "loop",
            blockType: empty,
            body: [
              get(3),
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              get(3),
              call(d.classify),
              { op: "local.tee", index: 5 },
              n(0),
              { op: "i32.le_s" },
              { op: "if", blockType: empty, then: ret(...gap(5)) },
              ...when(identity([get(3)], [get(0)]), ret(n(0))),
              get(3),
              call(d.getPrototypeOf),
              set(3),
              set(5),
              ...when([get(5), n(1), { op: "i32.ne" }], failed),
              get(3),
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              ...advanceSlow(d, 6, 7, 5, failed),
              // Validate the next carrier before using GC identity (externrefs can be foreign values).
              get(3),
              call(d.classify),
              { op: "local.tee", index: 5 },
              n(0),
              { op: "i32.le_s" },
              { op: "if", blockType: empty, then: ret(...gap(5)) },
              ...when(identity([get(3)], [get(6)]), ret(n(3))),
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      ...d.carriers.flatMap((c, ordinal) =>
        c.kind === "object-prototype" ? [] : carrierArm(2, ordinal, [...mutation(c), ...ret(n(1))]),
      ),
      { op: "unreachable" },
    ],
  };
}

export interface MixedObjectGetOperands {
  readonly entryTypeIdx: number;
  readonly vectorTypeIdx: number;
  readonly undefinedGlobal: number;
  readonly lookup: FuncHandle;
  readonly newVector: FuncHandle;
  /** Actual mixed Call, never a signature-only production completion certificate. */
  readonly call: FuncHandle;
}
/** Pure algorithm builder. Its production owner awaits the genuine mixed invocation owner. */
export function buildMixedObjectGet(input: MixedObjectGetOperands): MixedObjectDefinition {
  const d = data(input, [
    "entryTypeIdx",
    "vectorTypeIdx",
    "undefinedGlobal",
    "lookup",
    "newVector",
    "call",
  ]) as unknown as MixedObjectGetOperands;
  Object.values(d).forEach(coordinate);
  const undefinedValue: Instr[] = [global(d.undefinedGlobal), { op: "extern.convert_any" }];
  const read = (fieldIdx: number): Instr[] => [
    get(3),
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: d.entryTypeIdx, fieldIdx },
  ];
  return {
    locals: [
      { name: "entry", type: { kind: "ref_null", typeIdx: d.entryTypeIdx } },
      { name: "status", type: i32 },
      { name: "getter", type: ext },
    ],
    body: [
      get(0),
      get(1),
      call(d.lookup),
      set(3),
      set(4),
      ...when([get(4), n(1), { op: "i32.ne" }], ret(get(4), ...undefinedValue)),
      ...when(
        [...read(2), n(flags.accessor), { op: "i32.and" }],
        [
          ...read(4),
          { op: "extern.convert_any" },
          { op: "local.tee", index: 5 },
          { op: "ref.is_null" },
          { op: "if", blockType: empty, then: ret(n(1), ...undefinedValue) },
          ...ret(
            n(1),
            get(5),
            get(2),
            call(d.newVector),
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: d.vectorTypeIdx },
            call(d.call),
          ),
        ],
      ),
      n(1),
      ...read(1),
      { op: "extern.convert_any" },
    ],
  };
}
