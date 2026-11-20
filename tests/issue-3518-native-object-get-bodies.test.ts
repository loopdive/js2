// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readBeforeResumeMain } from "./helpers/resume-main-composition.js";
import { createHash } from "node:crypto";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createEmptyModule, type Instr, type LocalDef, type ValType } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import * as arms from "../src/runtime/wasmgc/values/object-get-arms.js";
import { buildObjectGetBody, type ObjectGetBindings } from "../src/runtime/wasmgc/values/object-get-bodies.js";
import {
  authenticateObjectRuntimeComposition,
  objectRuntimeCompositionText,
} from "./helpers/object-get-key-composition.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const read = readBeforeResumeMain;
const fixtureText = read("tests/fixtures/issue-3518-native-object-get-donor.json");
const fixtureHash = "ba22b31f3a4b283f044beaf13b07bb8f4fc36e39e40a003f3df17fd4cde8e065";
interface Donor {
  file: string;
  name: string;
  text: string;
  sha256: string;
  scopeSha256: string;
  gitBlob: string;
}
function authenticate(text: string) {
  if (sha(text) !== fixtureHash) throw new Error("object get donor digest mismatch");
  const parsed = JSON.parse(text) as { base: string; records: Donor[] };
  if (parsed.base !== "750fb7e7365692b315179dc909b57fa1407d4527" || parsed.records.length !== 8)
    throw new Error("object get donor provenance mismatch");
  for (const record of parsed.records)
    if (sha(record.text) !== record.scopeSha256) throw new Error("donor scope mismatch");
  return parsed.records;
}
const donors = authenticate(fixtureText);
function parse(source: string) {
  const sf = ts.createSourceFile("donor.ts", source, ts.ScriptTarget.Latest, true);
  if (sf.parseDiagnostics.length) throw new Error("invalid donor source");
  return sf;
}

const E = { kind: "externref" } as const,
  I = { kind: "i32" } as const,
  A = { kind: "anyref" } as const;
const load = (index: number): Instr => ({ op: "local.get", index });
const int = (value: number): Instr => ({ op: "i32.const", value });
const ref = (typeIdx: number): ValType => ({ kind: "ref", typeIdx });
const nullable = (typeIdx: number): ValType => ({ kind: "ref_null", typeIdx });
interface RuntimeOptions {
  cache?: boolean;
  companion?: boolean;
  fnctor?: boolean;
  metadata?: boolean;
  boundary?: boolean;
  reverse?: boolean;
  instance?: boolean;
  generator?: boolean;
  vector?: boolean;
  closure?: boolean;
}
function executable(opts: RuntimeOptions = {}, mutate?: (body: Instr[], d: ObjectGetBindings) => void) {
  // Actual WasmGC objects, property storage and body execution. Imported functions
  // are explicit observable fixture dependencies, not issued native resource packs.
  const mod = createEmptyModule();
  mod.types.push(
    {
      kind: "struct",
      name: "$Entry",
      fields: [A, A, I, I, A, A].map((type, i) => ({ name: `f${i}`, type, mutable: true })),
    },
    { kind: "array", name: "$Props", element: nullable(0), mutable: true },
    {
      kind: "struct",
      name: "$Object",
      fields: [nullable(2), ref(1), I, I, I, I].map((type, i) => ({ name: `f${i}`, type, mutable: true })),
    },
    {
      kind: "struct",
      name: "$Hash",
      fields: [I, I, I, I, I, nullable(2), nullable(0), nullable(1)].map((type, i) => ({
        name: `f${i}`,
        type,
        mutable: true,
      })),
    },
  );
  const active = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
  const receiver = new WebAssembly.Global({ value: "externref", mutable: true }, null);
  const undefinedValue = new WebAssembly.Global({ value: "externref", mutable: false }, undefined);
  const owned = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
  const observations: unknown[][] = [];
  const state = {
    metadata: null as unknown,
    boundary: null as unknown,
    reverse: null as unknown,
    reverseOwned: 0,
    instance: null as unknown,
    generator: undefined as unknown,
    generatorHandled: false,
    vector: undefined as unknown,
    closure: undefined as unknown,
    prototype: null as unknown,
    companion: undefined as unknown,
    implicitAllowed: true,
  };
  const controls: Record<string, unknown> = { active, receiver, undefinedValue, owned };
  for (const [name, type, mutable] of [
    ["active", I, true],
    ["receiver", E, true],
    ["undefinedValue", E, false],
    ["owned", I, true],
  ] as const)
    mod.imports.push({ module: "control", name, desc: { kind: "global", type, mutable } });
  let importedFunctions = 0;
  function imported(name: string, params: ValType[], results: ValType[], fn: (...args: unknown[]) => unknown) {
    const typeIdx = mod.types.length;
    mod.types.push({ kind: "func", params, results });
    mod.imports.push({ module: "control", name, desc: { kind: "func", typeIdx } });
    controls[name] = (...args: unknown[]) => {
      observations.push([name, ...args]);
      return fn(...args);
    };
    return importedFunctions++;
  }
  const eq = imported("keyEqual", [E, E], [I], (a, b) => (Object.is(a, b) ? 1 : 0));
  const accessor = imported("accessor", [E, E], [E], (recv, fn) => {
    observations.push(["active-at-getter", active.value]);
    if (typeof fn !== "function") throw new Error("fixture accessor is not callable");
    return Reflect.apply(fn, recv, []);
  });
  const metadata = imported("metadata", [E, E], [E], () => state.metadata);
  const boundary = imported("boundary", [E, E], [E], () => state.boundary);
  const reverse = imported("reverse", [E, E], [E], () => {
    owned.value = state.reverseOwned;
    return state.reverse;
  });
  const instanceIs = imported("instanceIs", [E], [I], () => 1);
  const instanceGet = imported("instanceGet", [E, E], [E], () => state.instance);
  const generatorGet = imported("generatorGet", [E, E], [I, E], () => [
    state.generatorHandled ? 1 : 0,
    state.generator,
  ]);
  const vectorIs = imported("vectorIs", [E], [I], () => 1);
  const vectorGet = imported("vectorGet", [E, E], [E], () => state.vector);
  const closureGet = imported("closureGet", [E, E], [E], () => state.closure);
  const protoStart = imported("protoStart", [E], [E], () => state.prototype);
  const brandOffset = imported("brandOffset", [E], [I], () => 42);
  const companion = imported("companion", [E, E, I], [E], () => state.companion);
  const terminal = imported("terminal", [nullable(2)], [I], () => (state.implicitAllowed ? 1 : 0));
  function define(name: string, params: ValType[], results: ValType[], locals: LocalDef[], body: Instr[]) {
    const index = importedFunctions + mod.functions.length,
      typeIdx = mod.types.length;
    mod.types.push({ kind: "func", params, results });
    mod.functions.push({ name, typeIdx, locals, body, exported: true });
    mod.exports.push({ name, desc: { kind: "func", index } });
    return index;
  }
  const find = define(
    "find",
    [ref(2), E],
    [nullable(0)],
    [{ name: "entry", type: nullable(0) }],
    [
      load(0),
      { op: "struct.get", typeIdx: 2, fieldIdx: 1 },
      int(0),
      { op: "array.get", typeIdx: 1 },
      { op: "local.tee", index: 2 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null", typeIdx: 0 }, { op: "return" }] },
      load(2),
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: 0, fieldIdx: 2 },
      int(128),
      { op: "i32.and" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null", typeIdx: 0 }, { op: "return" }] },
      load(2),
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: 0, fieldIdx: 0 },
      { op: "extern.convert_any" },
      load(1),
      { op: "call", funcIdx: eq },
      {
        op: "if",
        blockType: { kind: "val", type: nullable(0) },
        then: [load(2)],
        else: [{ op: "ref.null", typeIdx: 0 }],
      },
    ],
  );
  define(
    "make",
    [E, E, E, E, I],
    [E],
    [],
    [
      load(0),
      { op: "any.convert_extern" },
      { op: "ref.cast_null", typeIdx: 2 },
      load(1),
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: nullable(0) },
        then: [{ op: "ref.null", typeIdx: 0 }],
        else: [
          load(1),
          { op: "any.convert_extern" },
          load(2),
          { op: "any.convert_extern" },
          load(4),
          int(0),
          load(3),
          { op: "any.convert_extern" },
          { op: "ref.null", typeIdx: -18 },
          { op: "struct.new", typeIdx: 0 },
        ],
      },
      { op: "array.new_fixed", typeIdx: 1, length: 1 },
      int(1),
      int(0),
      int(0),
      int(0),
      { op: "struct.new", typeIdx: 2 },
      { op: "extern.convert_any" },
    ],
  );
  define(
    "hash",
    [],
    [E],
    [],
    [
      int(0),
      int(0),
      int(0),
      int(0),
      int(0),
      { op: "ref.null", typeIdx: 2 },
      { op: "ref.null", typeIdx: 0 },
      { op: "ref.null", typeIdx: 1 },
      { op: "struct.new", typeIdx: 3 },
      { op: "extern.convert_any" },
    ],
  );
  for (const [name, index, result] of [
    ["cacheFlag", 4, I],
    ["cacheOwner", 5, E],
    ["cacheEntry", 6, E],
    ["cacheProps", 7, E],
  ] as const)
    define(
      name,
      [E],
      [result],
      [],
      [
        load(0),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: 3 },
        { op: "struct.get", typeIdx: 3, fieldIdx: index },
        ...(result.kind === "externref" ? [{ op: "extern.convert_any" } as const] : []),
      ],
    );
  define(
    "ownProps",
    [E],
    [E],
    [],
    [
      load(0),
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: 2 },
      { op: "struct.get", typeIdx: 2, fieldIdx: 1 },
      { op: "extern.convert_any" },
    ],
  );
  define(
    "ownEntry",
    [E],
    [E],
    [],
    [
      load(0),
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: 2 },
      { op: "struct.get", typeIdx: 2, fieldIdx: 1 },
      int(0),
      { op: "array.get", typeIdx: 1 },
      { op: "extern.convert_any" },
    ],
  );
  const missing: arms.VecOrClosureReadBinding = {
    vector: opts.vector ? { isCarrier: vectorIs, get: vectorGet } : undefined,
    closure: opts.closure
      ? { kind: "closure", get: closureGet, companion: undefined }
      : { kind: "legacy-missing", undefinedValue: [{ op: "global.get", index: 2 }] },
  };
  const explicit = opts.cache ? 11 : 9;
  const d: ObjectGetBindings = {
    objectTypeIdx: 2,
    propEntryTypeIdx: 0,
    objFindIdx: find,
    callAccessorGetIdx: accessor,
    accessorFlag: 8,
    reflectGetReceiverActiveGlobalIdx: 0,
    reflectGetReceiverGlobalIdx: 1,
    explicitReceiverLocal: explicit,
    nullProtoRootLocal: opts.companion ? explicit + 1 : undefined,
    protoCacheEnabled: Boolean(opts.cache),
    hashedStringTypeIdx: 3,
    bfnGetMetaIdx: opts.metadata ? metadata : undefined,
    fnctorProtoStartIdx: opts.fnctor || opts.cache ? protoStart : undefined,
    objectTerminalAllowsImplicitProtoIdx: terminal,
    templateRaw: undefined,
    boundaryGet: opts.boundary ? boundary : undefined,
    reversePeer: opts.reverse ? { get: reverse, ownedGlobal: 3 } : undefined,
    instance: opts.instance
      ? {
          isCarrier: instanceIs,
          get: instanceGet,
          scratchLocal: explicit - 1,
          generator: opts.generator ? { get: generatorGet, valueLocal: explicit - 1 } : undefined,
        }
      : undefined,
    missingPrototype: missing,
    invalidPrototype: missing,
    objectProtoMiss: opts.companion
      ? { kind: "split-receiver", receiver: 0, key: 1, accessorReceiver: explicit, brandOffset, getKey: companion }
      : undefined,
    getterMiss: [{ op: "global.get", index: 2 }],
    terminalMiss: [{ op: "global.get", index: 2 }],
  };
  const body = buildObjectGetBody(d);
  mutate?.(body, d);
  const locals: LocalDef[] = [
    { name: "o", type: nullable(2) },
    { name: "e", type: nullable(0) },
    { name: "any", type: A },
    { name: "getter", type: E },
    { name: "bfmeta", type: E },
    { name: "fnctorProto", type: E },
    ...(opts.cache
      ? [
          { name: "kh", type: nullable(3) },
          { name: "canCache", type: I },
        ]
      : []),
    { name: "ispv", type: E },
    { name: "explicitReceiver", type: E },
    ...(opts.companion ? [{ name: "nullProtoRoot", type: nullable(2) }] : []),
  ];
  define("get", [E, E], [E], locals, body);
  const binary = emitBinary(mod);
  const module = new WebAssembly.Module(binary as BufferSource);
  expect(WebAssembly.Module.imports(module)).toHaveLength(importedFunctions + 4);
  const instance = new WebAssembly.Instance(module, { control: controls as WebAssembly.ModuleImports });
  const exports = instance.exports as Record<string, (...args: unknown[]) => unknown>;
  const make = (proto: unknown, key: unknown, value: unknown, getter: unknown = null, flags = 0): unknown =>
    exports.make!(proto, key, value, getter, flags);
  const get = (obj: unknown, key: unknown): unknown => exports.get!(obj, key);
  return { exports, make, get, active, receiver, owned, observations, state, body, binary };
}
function allInstructions(body: Instr[]): Instr[] {
  return body.flatMap((i) => [
    i,
    ...(i.op === "if"
      ? [...allInstructions(i.then), ...allInstructions(i.else ?? [])]
      : i.op === "block" || i.op === "loop"
        ? allInstructions(i.body)
        : []),
  ]);
}

describe("C1 initial object-get fixed donor preservation", () => {
  it("rejects a changed donor receipt after authenticating the original", () => {
    expect(authenticate(fixtureText)).toHaveLength(8);
    expect(() => authenticate(fixtureText.replace("reserveAccessorGetDriver", "otherAccessorGetDriver"))).toThrow(
      "digest mismatch",
    );
  });

  it("keeps both pure builders limited to canonical data dependencies", () => {
    const files = ["object-get-bodies", "object-get-arms"];
    for (const name of files) {
      const sf = parse(read(`src/runtime/wasmgc/values/${name}.ts`));
      const imports = sf.statements.filter(ts.isImportDeclaration);
      expect(imports.length).toBeGreaterThan(0);
      expect(imports.map((i) => (i.moduleSpecifier as ts.StringLiteral).text)).toEqual(
        name === "object-get-bodies"
          ? ["../../../wasm/model/instructions.js", "./object-get-arms.js"]
          : ["../../../wasm/model/instructions.js"],
      );
      const disallowed: string[] = [];
      function visit(n: ts.Node) {
        if (ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isFunctionTypeNode(n))
          disallowed.push(n.getText(sf));
        ts.forEachChild(n, visit);
      }
      visit(sf);
      expect(disallowed).toEqual([]);
    }
  });
});
describe("C1 getter acquisition and registration against original donor", () => {});

function observed(r: ReturnType<typeof executable>, name: string) {
  return r.observations.filter((row) => row[0] === name);
}
describe("emitted initial getter with controlled dependencies (not completed native resource packs)", () => {
  it("reads own data before prototype data and preserves the missing case", () => {
    const r = executable();
    const proto = r.make(null, "key", 19),
      own = r.make(proto, "key", 31);
    expect(r.get(own, "key")).toBe(31);
    expect(r.get(r.make(proto, "other", 7), "key")).toBe(19);
    expect(r.get(own, "absent")).toBeUndefined();
    expect(observed(r, "keyEqual").length).toBeGreaterThan(2);
  });

  it.each([null, undefined])("keeps a present %s value ahead of the prototype and companion", (value) => {
    const r = executable({ companion: true });
    r.state.companion = 83;
    const proto = r.make(null, "key", 71),
      own = r.make(proto, "key", value);
    expect(r.get(own, "key")).toBe(value);
    expect(observed(r, "companion")).toEqual([]);
  });

  it("a null getter returns undefined rather than continuing into the prototype", () => {
    const r = executable();
    const proto = r.make(null, "key", 19);
    expect(r.get(r.make(proto, "key", 33, null, 8), "key")).toBeUndefined();
    expect(observed(r, "accessor")).toEqual([]);
  });

  it("calls an inherited getter exactly once with the original receiver", () => {
    const r = executable();
    const receivers: unknown[] = [];
    const proto = r.make(
      null,
      "key",
      99,
      function (this: unknown) {
        receivers.push(this);
        return 42;
      },
      8,
    );
    const object = r.make(proto, null, null);
    expect(r.get(object, "key")).toBe(42);
    expect(receivers).toEqual([object]);
    expect(observed(r, "accessor")).toHaveLength(1);
  });

  it("consumes an explicit receiver before a nested ordinary getter", () => {
    const r = executable();
    const seen: unknown[] = [],
      override = { receiver: "explicit" };
    const inner = r.make(
      null,
      "inside",
      null,
      function (this: unknown) {
        seen.push(this);
        return 7;
      },
      8,
    );
    const proto = r.make(
      null,
      "outside",
      null,
      function (this: unknown) {
        seen.push(this);
        return r.get(inner, "inside");
      },
      8,
    );
    const outer = r.make(proto, null, null);
    r.active.value = 1;
    r.receiver.value = override;
    expect(r.get(outer, "outside")).toBe(7);
    expect(seen).toEqual([override, inner]);
    expect(observed(r, "active-at-getter")).toEqual([
      ["active-at-getter", 0],
      ["active-at-getter", 0],
    ]);
    expect(r.active.value).toBe(0);
  });

  it("propagates the exact thrown getter value with the receiver latch already consumed", () => {
    const r = executable();
    const thrown = { identity: "getter exception" },
      override = { explicit: true };
    let seen: unknown;
    const object = r.make(
      null,
      "key",
      null,
      function (this: unknown) {
        seen = this;
        throw thrown;
      },
      8,
    );
    r.active.value = 1;
    r.receiver.value = override;
    let caught: unknown;
    try {
      r.get(object, "key");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(thrown);
    expect(seen).toBe(override);
    expect(r.active.value).toBe(0);
  });

  it("ignores an unflagged getter field and reads the data value", () => {
    const r = executable();
    const object = r.make(null, "key", 37, () => 82, 0);
    expect(r.get(object, "key")).toBe(37);
    expect(observed(r, "accessor")).toEqual([]);
  });

  it("preserves the external fnctor receiver on a prototype getter", () => {
    const r = executable({ fnctor: true });
    const original = { native: "fnctor" };
    let seen: unknown;
    r.state.prototype = r.make(
      null,
      "key",
      null,
      function (this: unknown) {
        seen = this;
        return 43;
      },
      8,
    );
    expect(r.get(original, "key")).toBe(43);
    expect(seen).toBe(original);
    expect(observed(r, "protoStart")).toEqual([["protoStart", original]]);
  });

  it("guards an invalid fnctor prototype before casting and follows the closure miss", () => {
    const r = executable({ fnctor: true, closure: true });
    r.state.prototype = 5;
    r.state.closure = 47;
    expect(r.get({}, "key")).toBe(47);
    expect(observed(r, "closureGet")).toHaveLength(1);
  });

  it("an instance-own undefined entry shadows a fnctor prototype", () => {
    const r = executable({ fnctor: true, instance: true });
    r.state.instance = undefined;
    r.state.prototype = r.make(null, "key", 91);
    expect(r.get({}, "key")).toBeUndefined();
    expect(observed(r, "protoStart")).toEqual([]);
    expect(observed(r, "instanceGet")).toHaveLength(1);
  });

  it("uses the generator handled channel even for a null result before instance lookup", () => {
    const r = executable({ instance: true, generator: true });
    r.state.generatorHandled = true;
    r.state.generator = null;
    r.state.instance = 91;
    expect(r.get({}, "key")).toBeNull();
    expect(observed(r, "generatorGet")).toHaveLength(1);
    expect(observed(r, "instanceGet")).toEqual([]);
  });

  it("falls through an unhandled generator into a real instance read", () => {
    const r = executable({ instance: true, generator: true });
    r.state.generatorHandled = false;
    r.state.generator = 17;
    r.state.instance = 53;
    expect(r.get({}, "key")).toBe(53);
    expect(observed(r, "instanceGet")).toHaveLength(1);
  });

  it.each([false, true])("selects vector before closure after a fnctor miss (fnctor=%s)", (fnctor) => {
    const r = executable({ fnctor, vector: true, closure: true });
    r.state.vector = 59;
    r.state.closure = 61;
    expect(r.get({}, "key")).toBe(59);
    expect(observed(r, "vectorGet")).toHaveLength(1);
    expect(observed(r, "closureGet")).toEqual([]);
  });

  it("runs metadata before boundary and consumes the receiver latch on its early return", () => {
    const r = executable({ metadata: true, boundary: true });
    r.state.metadata = 67;
    r.state.boundary = 71;
    r.active.value = 1;
    r.receiver.value = {};
    expect(r.get({}, "name")).toBe(67);
    expect(observed(r, "boundary")).toEqual([]);
    expect(r.active.value).toBe(0);
  });

  it("a boundary-owned undefined remains a value before native instance fallback", () => {
    const r = executable({ metadata: true, boundary: true, instance: true });
    r.state.boundary = undefined;
    r.state.instance = 73;
    expect(r.get({}, "key")).toBeUndefined();
    expect(observed(r, "boundary")).toHaveLength(1);
    expect(observed(r, "instanceGet")).toEqual([]);
  });

  it.each([
    [null, 1, null],
    [null, 0, undefined],
    [79, 0, 79],
    [undefined, 1, undefined],
  ] as const)("preserves reverse-peer result %s with owned=%s", (answer, owned, expected) => {
    const r = executable({ reverse: true });
    r.state.reverse = answer;
    r.state.reverseOwned = owned;
    expect(r.get({}, "key")).toBe(expected);
    expect(observed(r, "reverse")).toHaveLength(1);
  });

  it("keeps the walk root for terminal eligibility and passes the explicit companion receiver", () => {
    const r = executable({ companion: true });
    r.state.companion = 83;
    const proto = r.make(null, "other", 1),
      object = r.make(proto, null, null),
      override = { receiver: true };
    r.active.value = 1;
    r.receiver.value = override;
    expect(r.get(object, "key")).toBe(83);
    expect(observed(r, "terminal")).toEqual([["terminal", object]]);
    expect(observed(r, "brandOffset")).toEqual([["brandOffset", object]]);
    expect(observed(r, "companion")).toEqual([["companion", override, "key", 42]]);
  });

  it("an explicit null terminal refuses the implicit companion", () => {
    const r = executable({ companion: true });
    r.state.implicitAllowed = false;
    r.state.companion = 89;
    const object = r.make(null, null, null);
    expect(r.get(object, "key")).toBeUndefined();
    expect(observed(r, "terminal")).toHaveLength(1);
    expect(observed(r, "companion")).toEqual([]);
  });

  it.each([false, true])("populates the first-depth cache with exact owner, entry and table (fnctor=%s)", (fnctor) => {
    const r = executable({ cache: true });
    const key = r.exports.hash!(),
      object = r.make(null, key, 97);
    r.state.prototype = object;
    expect(r.get(fnctor ? {} : object, key)).toBe(97);
    expect(r.exports.cacheFlag!(key)).toBe(1);
    expect(r.exports.cacheOwner!(key)).toBe(object);
    expect(r.exports.cacheEntry!(key)).toBe(r.exports.ownEntry!(object));
    expect(r.exports.cacheProps!(key)).toBe(r.exports.ownProps!(object));
  });

  it("does not populate cache after walking past the first object", () => {
    const r = executable({ cache: true });
    const key = r.exports.hash!(),
      proto = r.make(null, key, 101);
    expect(r.get(r.make(proto, null, null), key)).toBe(101);
    expect(r.exports.cacheFlag!(key)).toBe(0);
    expect(r.exports.cacheOwner!(key)).toBeNull();
    expect(r.exports.cacheEntry!(key)).toBeNull();
    expect(r.exports.cacheProps!(key)).toBeNull();
  });

  it("does not cache an accessor even when it returns a value", () => {
    const r = executable({ cache: true });
    const key = r.exports.hash!(),
      object = r.make(null, key, null, () => 103, 8);
    expect(r.get(object, key)).toBe(103);
    expect(r.exports.cacheFlag!(key)).toBe(0);
  });
});

function replaceExactlyOne(body: Instr[], predicate: (i: Instr) => boolean, replacement: (i: Instr) => void) {
  const matches = allInstructions(body).filter(predicate);
  expect(matches).toHaveLength(1);
  replacement(matches[0]!);
}
describe("positive-first executable mutation controls", () => {
  it("detects losing receiver-latch consumption", () => {
    const observe = (r: ReturnType<typeof executable>) => {
      const seen: unknown[] = [],
        explicit = {};
      const inner = r.make(
        null,
        "b",
        null,
        function (this: unknown) {
          seen.push(this);
          return 5;
        },
        8,
      );
      const outer = r.make(
        null,
        "a",
        null,
        function (this: unknown) {
          seen.push(this);
          return r.get(inner, "b");
        },
        8,
      );
      r.active.value = 1;
      r.receiver.value = explicit;
      expect(r.get(outer, "a")).toBe(5);
      return { seen, explicit, inner };
    };
    const positive = observe(executable());
    expect(positive.seen).toEqual([positive.explicit, positive.inner]);
    const negative = observe(
      executable({}, (body) => {
        expect(body[3]).toEqual(int(0));
        body[3] = int(1);
      }),
    );
    expect(negative.seen).toEqual([negative.explicit, negative.explicit]);
  });

  it("detects using the target instead of the explicit accessor receiver", () => {
    const observe = (r: ReturnType<typeof executable>) => {
      const explicit = {};
      let seen: unknown;
      const target = r.make(
        null,
        "key",
        null,
        function (this: unknown) {
          seen = this;
          return 7;
        },
        8,
      );
      r.active.value = 1;
      r.receiver.value = explicit;
      expect(r.get(target, "key")).toBe(7);
      return { seen, explicit, target };
    };
    const positive = observe(executable());
    expect(positive.seen).toBe(positive.explicit);
    const negative = observe(
      executable({}, (body, d) =>
        replaceExactlyOne(
          body,
          (i) => i.op === "local.get" && i.index === d.explicitReceiverLocal,
          (i) => {
            if (i.op === "local.get") i.index = 0;
          },
        ),
      ),
    );
    expect(negative.seen).toBe(negative.target);
  });

  it("detects dropping the accessor flag test", () => {
    const observe = (r: ReturnType<typeof executable>) =>
      r.get(
        r.make(null, "key", 11, () => 13, 8),
        "key",
      );
    expect(observe(executable())).toBe(13);
    expect(
      observe(
        executable({}, (body, d) =>
          replaceExactlyOne(
            body,
            (i) => i.op === "i32.const" && i.value === d.accessorFlag,
            (i) => {
              if (i.op === "i32.const") i.value = 0;
            },
          ),
        ),
      ),
    ).toBe(11);
  });

  it("detects conflating reverse-peer present null with a miss", () => {
    const observe = (r: ReturnType<typeof executable>) => {
      r.state.reverse = null;
      r.state.reverseOwned = 1;
      return r.get({}, "key");
    };
    expect(observe(executable({ reverse: true }))).toBeNull();
    expect(
      observe(
        executable({ reverse: true }, (body, d) =>
          replaceExactlyOne(
            body,
            (i) => i.op === "global.get" && i.index === d.reversePeer!.ownedGlobal,
            (i) => Object.assign(i, { op: "i32.const", value: 0 }),
          ),
        ),
      ),
    ).toBeUndefined();
  });

  it("detects cache writes after leaving the first object", () => {
    const observe = (r: ReturnType<typeof executable>) => {
      const key = r.exports.hash!(),
        proto = r.make(null, key, 17),
        target = r.make(proto, null, null);
      expect(r.get(target, key)).toBe(17);
      return r.exports.cacheFlag!(key);
    };
    expect(observe(executable({ cache: true }))).toBe(0);
    expect(
      observe(
        executable({ cache: true }, (body) => {
          const instructions = allInstructions(body),
            stores = instructions.filter((i) => i.op === "local.set" && i.index === 9);
          expect(stores).toHaveLength(3);
          const advanceStore = instructions.indexOf(stores[2]!);
          expect(instructions[advanceStore - 1]).toEqual(int(0));
          Object.assign(instructions[advanceStore - 1]!, { value: 1 });
        }),
      ),
    ).toBe(1);
  });
});
describe("authenticated signed key/getter composition", () => {
  it("rejects changed composition receipt bytes without reseeding any historical receipt", () => {
    expect(authenticateObjectRuntimeComposition(objectRuntimeCompositionText).base.sha256).toBe(donors[0]!.sha256);
    expect(() =>
      authenticateObjectRuntimeComposition(objectRuntimeCompositionText.replace("750fb7e7", "00000000")),
    ).toThrow("receipt digest mismatch");
    expect(authenticate(fixtureText)).toHaveLength(8);
  });
});
