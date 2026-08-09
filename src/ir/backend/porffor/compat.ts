// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Porffor commit whose internal IR surface this adapter understands. */
export const PORFFOR_IR_COMMIT = "257e8437bea2f00c8a1453a325561071d32be9cd";

export const PORFFOR_TYPE_ENTRIES = [
  ["none", 0],
  ["f64", 1],
  ["i32", 2],
  ["u32", 3],
  ["i64", 4],
  ["u64", 5],
  ["jsval", 6],
  ["ptr", 7],
] as const;

export const PORFFOR_EFFECT_ENTRIES = [
  ["none", 0],
  ["readMem", 1],
  ["writeMem", 2],
  ["call", 4],
  ["readGlobal", 8],
  ["writeLocal", 16],
] as const;

export const PORFFOR_KIND_NAMES = [
  "Const",
  "JvConst",
  "DataRef",
  "Local",
  "Global",
  "DeclLocal",
  "Assign",
  "Bin",
  "Un",
  "Select",
  "Convert",
  "Reinterpret",
  "Canon",
  "Box",
  "JvType",
  "JvNum",
  "JvPtr",
  "JvBits",
  "JvFromBits",
  "JvIsNum",
  "Eq",
  "Add",
  "Cmp",
  "JvTruthy",
  "Load",
  "Store",
  "MemCopy",
  "MemFill",
  "If",
  "Loop",
  "Break",
  "Continue",
  "Block",
  "Switch",
  "TypeSwitch",
  "Return",
  "Unreachable",
  "Call",
  "CallDynamic",
  "Try",
  "Throw",
  "ThrowNew",
  "Await",
  "Yield",
  "Alloc",
  "GcBarrier",
  "ArrGet",
  "ArrSet",
  "ArrLenSet",
  "LenGet",
  "LenSet",
  "RawC",
  "Reserved",
  "JvFalsy",
  "JvNullish",
] as const;

export const PORFFOR_NODE_SLOT_ENTRIES = [
  ["N_KIND", 0],
  ["N_TYPE", 1],
  ["N_FX", 2],
  ["N_A", 3],
  ["N_B", 4],
  ["N_C", 5],
] as const;

export const PORFFOR_RENDERER_FIELDS = ["funcs", "data", "globals", "entry", "prefs", "usedTypes"] as const;
export const PORFFOR_FUNCTION_FIELDS = ["name", "index", "params", "retType", "locals", "body"] as const;

export type PorfforNode = readonly [kind: number, type: number, effects: number, a: unknown, b: unknown, c: unknown];

export interface PorfforParamRecord {
  readonly name: string;
  readonly type: number;
}

export interface PorfforLocalRecord {
  readonly type: number;
  readonly metadata?: unknown;
}

export interface PorfforFunctionRecord {
  readonly name: string;
  readonly index: number;
  readonly params: readonly PorfforParamRecord[];
  readonly retType: number;
  readonly locals: Readonly<Record<string, PorfforLocalRecord>>;
  readonly body: readonly PorfforNode[];
  readonly jsName?: string;
  readonly jsLength?: number;
  readonly returnType?: number;
  readonly async?: boolean;
  readonly generator?: boolean;
  readonly coroInit?: boolean;
  readonly constr?: boolean;
  readonly indirect?: boolean;
}

export interface PorfforGlobalRecord {
  readonly name: string;
  readonly type: number;
}

export interface PorfforRendererInput {
  readonly funcs: readonly (PorfforFunctionRecord | null | undefined)[];
  readonly data: readonly unknown[];
  readonly globals: readonly PorfforGlobalRecord[];
  readonly entry: string | null;
  readonly prefs: Readonly<Record<string, unknown>>;
  readonly usedTypes: ReadonlySet<number> | null;
}

export type PorfforRendererOutput =
  | string
  | {
      readonly c: string;
      readonly threads?: boolean;
      readonly nativeFetch?: boolean;
    };

export interface PorfforIrModule {
  readonly K: Readonly<Record<string, number>>;
  readonly KNames: readonly string[];
  readonly T: Readonly<Record<string, number>>;
  readonly FX: Readonly<Record<string, number>>;
  readonly N_KIND: number;
  readonly N_TYPE: number;
  readonly N_FX: number;
  readonly N_A: number;
  readonly N_B: number;
  readonly N_C: number;
  readonly Const: (type: number, literal: unknown) => PorfforNode;
  readonly Alloc: (bytes: PorfforNode, typeId: number) => PorfforNode;
  readonly [exportName: string]: unknown;
}

export type PorfforRenderer = (input: PorfforRendererInput) => PorfforRendererOutput;

export class PorfforCompatibilityError extends Error {
  readonly expectedCommit = PORFFOR_IR_COMMIT;

  constructor(
    detail: string,
    readonly actualCommit?: string,
    options?: ErrorOptions,
  ) {
    const detected = actualCommit ? ` Detected commit ${actualCommit}.` : "";
    super(
      `Porffor compatibility mismatch: ${detail}\n` +
        `Expected pinned commit ${PORFFOR_IR_COMMIT}.${detected}\n` +
        "Initialize vendor/Porffor at the pinned commit, or update the JS2 Porffor compatibility fingerprint and adapter together.",
      options,
    );
    this.name = "PorfforCompatibilityError";
  }
}

/** Validate the checked-out commit before loading unstable Porffor internals. */
export function assertPorfforCommit(actualCommit: string): void {
  if (actualCommit !== PORFFOR_IR_COMMIT) {
    throw new PorfforCompatibilityError("the checked-out commit does not match the supported IR schema", actualCommit);
  }
}

/** Validate Porffor's unstable enum tables and six-slot node layout. */
export function assertPorfforIrCompatibility(
  candidate: unknown,
  actualCommit = PORFFOR_IR_COMMIT,
): asserts candidate is PorfforIrModule {
  assertPorfforCommit(actualCommit);
  const module = requireRecord(candidate, "IR module", actualCommit);

  assertEnum("T", module.T, PORFFOR_TYPE_ENTRIES, actualCommit);
  assertEnum("FX", module.FX, PORFFOR_EFFECT_ENTRIES, actualCommit);
  const kindEntries = PORFFOR_KIND_NAMES.map((name, value) => [name, value] as const);
  assertEnum("K", module.K, kindEntries, actualCommit);

  for (const [slot, expected] of PORFFOR_NODE_SLOT_ENTRIES) {
    if (module[slot] !== expected) {
      throw new PorfforCompatibilityError(
        `node slot ${slot} expected ${expected}, received ${describe(module[slot])}`,
        actualCommit,
      );
    }
  }

  if (!Array.isArray(module.KNames)) {
    throw new PorfforCompatibilityError("KNames must be an array indexed by K values", actualCommit);
  }
  for (let i = 0; i < PORFFOR_KIND_NAMES.length; i++) {
    if (module.KNames[i] !== PORFFOR_KIND_NAMES[i]) {
      throw new PorfforCompatibilityError(
        `KNames[${i}] expected ${PORFFOR_KIND_NAMES[i]}, received ${describe(module.KNames[i])}`,
        actualCommit,
      );
    }
  }

  if (typeof module.Const !== "function") {
    throw new PorfforCompatibilityError("IR export Const must be a function", actualCommit);
  }
  const probe = module.Const(PORFFOR_TYPE_ENTRIES[2][1], 7);
  assertPorfforNode(probe, "Const probe", actualCommit);
  const expectedProbe = [0, PORFFOR_TYPE_ENTRIES[2][1], 0, 7, 0, 0];
  for (let i = 0; i < expectedProbe.length; i++) {
    if (probe[i] !== expectedProbe[i]) {
      throw new PorfforCompatibilityError(
        `six-slot Const probe differs at slot ${i}: expected ${expectedProbe[i]}, received ${describe(probe[i])}`,
        actualCommit,
      );
    }
  }

  if (typeof module.Alloc !== "function") {
    throw new PorfforCompatibilityError("IR export Alloc must be a function", actualCommit);
  }
  const allocProbe = module.Alloc(probe, 0);
  assertPorfforNode(allocProbe, "Alloc probe", actualCommit);
  const expectedAllocProbe = [
    PORFFOR_KIND_NAMES.indexOf("Alloc"),
    PORFFOR_TYPE_ENTRIES[7][1],
    PORFFOR_EFFECT_ENTRIES[3][1],
    probe,
    0,
    0,
  ];
  for (let i = 0; i < expectedAllocProbe.length; i++) {
    if (allocProbe[i] !== expectedAllocProbe[i]) {
      throw new PorfforCompatibilityError(
        `six-slot Alloc probe differs at slot ${i}: expected ${describe(expectedAllocProbe[i])}, received ${describe(allocProbe[i])}`,
        actualCommit,
      );
    }
  }
}

/** Validate the JS2-owned record before passing it to Porffor's renderer. */
export function assertPorfforRendererInput(
  input: unknown,
  actualCommit = PORFFOR_IR_COMMIT,
): asserts input is PorfforRendererInput {
  const record = requireRecord(input, "renderer input", actualCommit);
  for (const field of PORFFOR_RENDERER_FIELDS) requireField(record, field, "renderer input", actualCommit);

  if (!Array.isArray(record.funcs)) failShape("renderer input.funcs must be an array", actualCommit);
  const functionNames = new Set<string>();
  for (let i = 0; i < record.funcs.length; i++) {
    const func = record.funcs[i];
    if (func == null) continue;
    const f = requireRecord(func, `renderer input.funcs[${i}]`, actualCommit);
    for (const field of PORFFOR_FUNCTION_FIELDS) requireField(f, field, `renderer input.funcs[${i}]`, actualCommit);
    if (typeof f.name !== "string") failShape(`renderer input.funcs[${i}].name must be a string`, actualCommit);
    if (!Number.isInteger(f.index)) failShape(`renderer input.funcs[${i}].index must be an integer`, actualCommit);
    if (f.index !== i) failShape(`renderer input.funcs[${i}].index must equal its array slot ${i}`, actualCommit);
    if (!Number.isInteger(f.retType)) failShape(`renderer input.funcs[${i}].retType must be an integer`, actualCommit);
    if (!Array.isArray(f.params)) failShape(`renderer input.funcs[${i}].params must be an array`, actualCommit);
    for (let p = 0; p < f.params.length; p++) {
      const param = requireRecord(f.params[p], `renderer input.funcs[${i}].params[${p}]`, actualCommit);
      if (typeof param.name !== "string" || !Number.isInteger(param.type)) {
        failShape(`renderer input.funcs[${i}].params[${p}] must contain string name and integer type`, actualCommit);
      }
    }
    const locals = requireRecord(f.locals, `renderer input.funcs[${i}].locals`, actualCommit);
    for (const [name, localValue] of Object.entries(locals)) {
      const local = requireRecord(localValue, `renderer input.funcs[${i}].locals.${name}`, actualCommit);
      if (!Number.isInteger(local.type)) {
        failShape(`renderer input.funcs[${i}].locals.${name}.type must be an integer`, actualCommit);
      }
    }
    if (!Array.isArray(f.body)) failShape(`renderer input.funcs[${i}].body must be an array`, actualCommit);
    for (let n = 0; n < f.body.length; n++) assertPorfforNode(f.body[n], `funcs[${i}].body[${n}]`, actualCommit);
    functionNames.add(f.name);
  }

  if (!Array.isArray(record.data)) failShape("renderer input.data must be an array", actualCommit);
  if (!Array.isArray(record.globals)) failShape("renderer input.globals must be an array", actualCommit);
  for (let i = 0; i < record.globals.length; i++) {
    const global = requireRecord(record.globals[i], `renderer input.globals[${i}]`, actualCommit);
    if (typeof global.name !== "string" || !Number.isInteger(global.type)) {
      failShape(`renderer input.globals[${i}] must contain string name and integer type`, actualCommit);
    }
  }
  if (record.entry !== null && typeof record.entry !== "string") {
    failShape("renderer input.entry must be a string or null", actualCommit);
  }
  if (typeof record.entry === "string" && !functionNames.has(record.entry)) {
    failShape(`renderer input.entry names missing function ${JSON.stringify(record.entry)}`, actualCommit);
  }
  requireRecord(record.prefs, "renderer input.prefs", actualCommit);
  if (record.usedTypes !== null) {
    const usedTypes = requireRecord(record.usedTypes, "renderer input.usedTypes", actualCommit);
    if (typeof usedTypes.has !== "function") {
      failShape("renderer input.usedTypes must be a Set-like object or null", actualCommit);
    }
  }
}

export function porfforRendererOutputText(output: PorfforRendererOutput): string {
  if (typeof output === "string") return output;
  if (isRecord(output) && typeof output.c === "string") return output.c;
  throw new PorfforCompatibilityError("renderer returned neither C text nor an object containing string field c");
}

function assertPorfforNode(node: unknown, path: string, actualCommit: string): asserts node is PorfforNode {
  if (!Array.isArray(node) || node.length !== 6) {
    throw new PorfforCompatibilityError(`${path} must be a six-slot [kind, type, effects, a, b, c] node`, actualCommit);
  }
  for (let i = 0; i < 3; i++) {
    if (!Number.isInteger(node[i])) {
      throw new PorfforCompatibilityError(
        `${path}[${i}] must be an integer, received ${describe(node[i])}`,
        actualCommit,
      );
    }
  }
}

function assertEnum(
  label: string,
  candidate: unknown,
  expected: readonly (readonly [string, number])[],
  actualCommit: string,
): void {
  const record = requireRecord(candidate, `${label} enum`, actualCommit);
  const actual = Object.entries(record)
    .map(([name, value]) => [name, value] as const)
    .sort((left, right) => {
      const a = typeof left[1] === "number" ? left[1] : Number.POSITIVE_INFINITY;
      const b = typeof right[1] === "number" ? right[1] : Number.POSITIVE_INFINITY;
      return a - b;
    });

  const length = Math.max(actual.length, expected.length);
  for (let i = 0; i < length; i++) {
    const received = actual[i];
    const wanted = expected[i];
    if (!received || !wanted || received[0] !== wanted[0] || received[1] !== wanted[1]) {
      throw new PorfforCompatibilityError(
        `${label} enum differs at ordinal ${i}: expected ${formatEntry(wanted)}, received ${formatEntry(received)}`,
        actualCommit,
      );
    }
  }
}

function requireField(
  record: Readonly<Record<string, unknown>>,
  field: string,
  path: string,
  actualCommit: string,
): void {
  if (!(field in record)) failShape(`${path} is missing required field ${field}`, actualCommit);
}

function requireRecord(value: unknown, path: string, actualCommit: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) failShape(`${path} must be an object`, actualCommit);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failShape(detail: string, actualCommit: string): never {
  throw new PorfforCompatibilityError(detail, actualCommit);
}

function formatEntry(entry: readonly [string, unknown] | undefined): string {
  return entry ? `${entry[0]}=${describe(entry[1])}` : "<missing>";
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "<missing>";
  return String(value);
}
