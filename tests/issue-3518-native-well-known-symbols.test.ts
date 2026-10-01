// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  WELL_KNOWN_SYMBOL_IDS,
  wellKnownSymbolId,
  type WellKnownSymbolName,
} from "../src/runtime/contracts/well-known-symbols.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeSymbolCarrierResources,
  fillNativeSymbolCarrierResources,
} from "../src/backend/wasmgc/resources/native-symbol-carrier.js";
import {
  declareNativeWellKnownSymbolResources,
  reserveNativeWellKnownSymbolResources,
  requireNativeWellKnownSymbolReservations,
  nativeWellKnownSymbolProducer,
  fillNativeWellKnownSymbolResources,
  requireCompletedNativeWellKnownSymbols,
  nativeWellKnownSymbolReservationInventory,
} from "../src/backend/wasmgc/resources/native-well-known-symbols.js";

const expectedIds = {
  iterator: 1,
  hasInstance: 2,
  toPrimitive: 3,
  toStringTag: 4,
  species: 5,
  isConcatSpreadable: 6,
  match: 7,
  replace: 8,
  search: 9,
  split: 10,
  unscopables: 11,
  asyncIterator: 12,
  dispose: 13,
  asyncDispose: 14,
  matchAll: 15,
} as const;
const names = Object.keys(expectedIds) as WellKnownSymbolName[];
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

function prerequisites(offset = false) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const prefix = offset ? tx.reserveFunction("prefix:function", "prefix", { params: [], results: [] }) : undefined;
  if (offset) tx.reserveType("prefix:type", { kind: "struct", name: "Prefix", fields: [] });
  const padding = offset ? tx.reserveGlobal("prefix:global", "prefix", { kind: "i32" }, false) : undefined;
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "strings",
    utf8Storage: offset,
    literals: [{ value: "held string", encoding: "wtf16" }],
  });
  const symbols = reserveNativeSymbolCarrierResources(tx, "symbols", strings);
  const dependencies = { strings, symbols };
  return { module, tx, prefix, padding, strings, symbols, dependencies };
}
function fixture(offset = false, selected: readonly WellKnownSymbolName[] = ["toPrimitive"], mutablePlan = false) {
  const f = prerequisites(offset);
  const declared = declareNativeWellKnownSymbolResources("known", selected);
  const plan = mutablePlan ? structuredClone(declared) : declared;
  const pack = reserveNativeWellKnownSymbolResources(f.tx, "known", selected, plan, f.dependencies);
  return { ...f, plan, pack };
}
type Fixture = ReturnType<typeof fixture>;
const current = (f: Fixture) => requireNativeWellKnownSymbolReservations(f.tx, f.pack, f.plan, f.dependencies);
const completed = (f: Fixture) => requireCompletedNativeWellKnownSymbols(f.tx, f.pack, f.plan, f.dependencies);
const producer = (f: Fixture, name: WellKnownSymbolName = "toPrimitive") =>
  nativeWellKnownSymbolProducer(f.tx, f.pack, name, f.plan, f.dependencies);
function fillDependencies(f: Fixture) {
  if (f.prefix) f.tx.fillFunction(f.prefix, { locals: [], body: [] });
  if (f.padding) f.tx.fillGlobal(f.padding, [{ op: "i32.const", value: 37 }]);
  fillNativeStringLiteralResources(f.tx, f.strings);
  fillNativeSymbolCarrierResources(f.tx, f.symbols);
}
function complete(f = fixture()) {
  f.tx.freezeReservations();
  fillDependencies(f);
  fillNativeWellKnownSymbolResources(f.tx, f.pack);
  completed(f);
  return f;
}
function populations(f: ReturnType<typeof prerequisites>) {
  return Object.fromEntries(
    Object.entries(f.module)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => [key, [...(value as unknown[])]]),
  );
}
function unchanged(f: ReturnType<typeof prerequisites>, before: ReturnType<typeof populations>) {
  const after = populations(f);
  expect(Object.keys(after)).toEqual(Object.keys(before));
  for (const [key, entries] of Object.entries(before)) {
    expect(after[key]).toHaveLength(entries.length);
    expect(after[key]!.every((entry, index) => Object.is(entry, entries[index]))).toBe(true);
  }
}

describe("canonical well-known Symbol names", () => {
  it("retains the exact fifteen legacy carrier IDs without arbitrary numeric selection", () => {
    expect(WELL_KNOWN_SYMBOL_IDS).toStrictEqual(expectedIds);
    expect(Object.keys(WELL_KNOWN_SYMBOL_IDS)).toHaveLength(15);
    expect(new Set(Object.values(WELL_KNOWN_SYMBOL_IDS)).size).toBe(15);
  });
  it("freezes the actual catalog", () => {
    expect(Object.isFrozen(WELL_KNOWN_SYMBOL_IDS)).toBe(true);
    expect(Reflect.set(WELL_KNOWN_SYMBOL_IDS, "toPrimitive", 100)).toBe(false);
    expect(wellKnownSymbolId("toPrimitive")).toBe(3);
  });
  it.each(Object.entries(expectedIds))("resolves own canonical name %s", (name, id) => {
    expect(wellKnownSymbolId(name)).toBe(id);
  });
  it.each(["", "constructor", "toString", "__proto__", "hasOwnProperty", "3", "@@toPrimitive", "ToPrimitive"])(
    "refuses noncanonical/inherited name %j",
    (name) => expect(wellKnownSymbolId(name)).toBeUndefined(),
  );
});

describe("issued named Symbol producer authority", () => {
  it("declares only selected zero-argument producers in requested order", () => {
    const selected: WellKnownSymbolName[] = ["matchAll", "toPrimitive", "iterator"];
    const f = fixture(true, selected),
      inventory = nativeWellKnownSymbolReservationInventory(f.tx, f.pack, f.plan, f.dependencies);
    expect(f.pack.completionScope).toBe("canonical-well-known-symbol-producers");
    expect(Object.isFrozen(f.pack)).toBe(true);
    expect(Object.isFrozen(f.pack.producers)).toBe(true);
    expect(f.pack.producers.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(Object.isFrozen(inventory.plan)).toBe(true);
    expect(Object.isFrozen(inventory.dependencies)).toBe(true);
    expect(inventory.producers.map((row) => row.name)).toEqual(selected);
    expect(inventory.plan.declarations.map((row) => row.role)).toEqual(
      selected.map((name) => ["well-known-symbol", name]),
    );
    for (const row of inventory.plan.declarations)
      expect(row).toMatchObject({ space: "function", signature: { params: [], results: [{ kind: "externref" }] } });
    expect(Object.is(inventory.dependencies.symbols, f.symbols)).toBe(true);
    expect(Object.is(inventory.dependencies.strings, f.strings)).toBe(true);
    expect(Object.is(inventory.producers, f.pack.producers)).toBe(true);
    expect(Object.is(producer(f), f.pack.producers[1]!.function)).toBe(true);
    expect(f.module.exports).toEqual([]);
    complete(f);
    expect(f.tx.physicalIndex(producer(f))).toBeGreaterThan(0);
    expect(Object.is(completed(f), f.pack)).toBe(true);
  });

  it.each(["owner", "ledger", "plan", "dependencies"] as const)(
    "rejects copied/foreign %s after a positive",
    (kind) => {
      const f = fixture();
      current(f);
      expect(() =>
        requireNativeWellKnownSymbolReservations(
          kind === "ledger" ? prerequisites().tx : f.tx,
          kind === "owner" ? { ...f.pack } : f.pack,
          kind === "plan" ? structuredClone(f.plan) : f.plan,
          kind === "dependencies" ? { ...f.dependencies } : f.dependencies,
        ),
      ).toThrow(
        kind === "plan"
          ? "declaration plan"
          : kind === "dependencies"
            ? "dependency identity"
            : "foreign or copied owner",
      );
      expect(Object.is(current(f), f.pack)).toBe(true);
    },
  );

  it.each([
    ["empty", []],
    ["unknown", ["missing"]],
    ["late unknown", ["iterator", "missing"]],
    ["duplicate", ["iterator", "iterator"]],
    ["inherited", ["constructor"]],
    ["prototype", ["__proto__"]],
    ["numeric string", ["3"]],
    ["numeric ID", [3]],
    ["string alias", ["@@toPrimitive"]],
  ])("rejects %s selection without allocating", (_label, selected) => {
    const f = prerequisites(),
      before = populations(f);
    const plan = declareNativeWellKnownSymbolResources("known", ["toPrimitive"]);
    expect(() =>
      reserveNativeWellKnownSymbolResources(f.tx, "known", selected as WellKnownSymbolName[], plan, f.dependencies),
    ).toThrow("native well-known symbols:");
    unchanged(f, before);
    const pack = reserveNativeWellKnownSymbolResources(f.tx, "known", ["toPrimitive"], plan, f.dependencies);
    expect(pack.producers).toHaveLength(1);
  });

  it.each(["sparse", "accessor"] as const)("rejects %s names without reading a caller callback", (kind) => {
    const f = prerequisites(),
      before = populations(f),
      selected = new Array<WellKnownSymbolName>(1);
    let calls = 0;
    if (kind === "accessor")
      Object.defineProperty(selected, 0, {
        get() {
          calls++;
          return "toPrimitive";
        },
      });
    expect(() =>
      reserveNativeWellKnownSymbolResources(
        f.tx,
        "known",
        selected,
        declareNativeWellKnownSymbolResources("known", ["toPrimitive"]),
        f.dependencies,
      ),
    ).toThrow("own data entries");
    expect(calls).toBe(0);
    unchanged(f, before);
  });

  it("copies construction names before binding the owner", () => {
    const selected: WellKnownSymbolName[] = ["toPrimitive"],
      f = fixture(false, selected);
    selected[0] = "iterator";
    selected.push("matchAll");
    expect(f.pack.producers.map((row) => row.name)).toEqual(["toPrimitive"]);
    complete(f);
    expect(Object.is(producer(f), f.pack.producers[0]!.function)).toBe(true);
    expect(() => producer(f, "iterator")).toThrow("name was not selected");
  });

  it.each(["strings-copy", "symbols-copy", "strings-foreign", "symbols-foreign"] as const)(
    "rejects %s dependency before allocating",
    (kind) => {
      const f = prerequisites(),
        other = prerequisites(),
        before = populations(f);
      const dependencies = {
        strings: kind === "strings-copy" ? { ...f.strings } : kind === "strings-foreign" ? other.strings : f.strings,
        symbols: kind === "symbols-copy" ? { ...f.symbols } : kind === "symbols-foreign" ? other.symbols : f.symbols,
      };
      const plan = declareNativeWellKnownSymbolResources("known", ["toPrimitive"]);
      expect(() => reserveNativeWellKnownSymbolResources(f.tx, "known", ["toPrimitive"], plan, dependencies)).toThrow();
      unchanged(f, before);
      expect(
        reserveNativeWellKnownSymbolResources(f.tx, "known", ["toPrimitive"], plan, f.dependencies).producers,
      ).toHaveLength(1);
    },
  );

  it.each(["strings", "symbols"] as const)(
    "rejects borrowed %s dependency accessors before allocation without executing them",
    (role) => {
      const f = prerequisites(),
        before = populations(f),
        dependencies = { ...f.dependencies },
        plan = declareNativeWellKnownSymbolResources("known", ["toPrimitive"]);
      let calls = 0;
      Object.defineProperty(dependencies, role, {
        enumerable: true,
        get() {
          calls++;
          return f.dependencies[role];
        },
      });
      expect(() => reserveNativeWellKnownSymbolResources(f.tx, "known", ["toPrimitive"], plan, dependencies)).toThrow(
        "own enumerable dependency data",
      );
      expect(calls).toBe(0);
      unchanged(f, before);
      expect(
        reserveNativeWellKnownSymbolResources(f.tx, "known", ["toPrimitive"], plan, f.dependencies).producers,
      ).toHaveLength(1);
    },
  );

  it.each([
    "hidden role",
    "missing role",
    "inherited role",
    "extra role",
    "hidden extra",
    "symbol extra",
    "extra accessor",
  ] as const)("rejects %s dependency records before allocation", (kind) => {
    const f = prerequisites(),
      before = populations(f),
      dependencies = { ...f.dependencies },
      plan = declareNativeWellKnownSymbolResources("known", ["toPrimitive"]);
    let calls = 0;
    if (kind === "hidden role") Object.defineProperty(dependencies, "strings", { enumerable: false });
    else if (kind === "missing role") Reflect.deleteProperty(dependencies, "strings");
    else if (kind === "inherited role") {
      Reflect.deleteProperty(dependencies, "strings");
      Object.setPrototypeOf(dependencies, { strings: f.strings });
    } else
      Object.defineProperty(dependencies, kind === "symbol extra" ? Symbol("extra") : "extra", {
        enumerable: kind !== "hidden extra",
        ...(kind === "extra accessor"
          ? {
              get() {
                calls++;
                return f.strings;
              },
            }
          : { value: f.strings }),
      });
    expect(() => reserveNativeWellKnownSymbolResources(f.tx, "known", ["toPrimitive"], plan, dependencies)).toThrow(
      "dependency",
    );
    expect(calls).toBe(0);
    unchanged(f, before);
    expect(
      reserveNativeWellKnownSymbolResources(f.tx, "known", ["toPrimitive"], plan, f.dependencies).producers,
    ).toHaveLength(1);
  });

  it.each(["strings", "symbols"] as const)(
    "refuses a warmed %s dependency replaced with an accessor without executing it",
    (role) => {
      const f = complete();
      completed(f);
      let calls = 0;
      const original = f.dependencies[role];
      Object.defineProperty(f.dependencies, role, {
        enumerable: true,
        get() {
          calls++;
          return original;
        },
      });
      expect(() => current(f)).toThrow("own enumerable dependency data");
      expect(() => completed(f)).toThrow("own enumerable dependency data");
      expect(() => producer(f)).toThrow("own enumerable dependency data");
      expect(() => nativeWellKnownSymbolReservationInventory(f.tx, f.pack, f.plan, f.dependencies)).toThrow(
        "own enumerable dependency data",
      );
      expect(() => fillNativeWellKnownSymbolResources(f.tx, f.pack)).toThrow("own enumerable dependency data");
      expect(calls).toBe(0);
    },
  );

  it.each(["hidden role", "extra role", "symbol extra"] as const)(
    "refuses warmed dependency shape mutation: %s",
    (kind) => {
      const f = complete();
      completed(f);
      if (kind === "hidden role") Object.defineProperty(f.dependencies, "strings", { enumerable: false });
      else
        Object.defineProperty(f.dependencies, kind === "symbol extra" ? Symbol("extra") : "extra", {
          value: f.strings,
        });
      expect(() => current(f)).toThrow("dependency");
      expect(() => completed(f)).toThrow("dependency");
    },
  );

  it("rejects a genuine same-ledger String owner unrelated to its Symbol box", () => {
    const f = prerequisites();
    const other = reserveNativeStringLiteralResources(f.tx, { key: "other", utf8Storage: false, literals: [] });
    const before = populations(f),
      plan = declareNativeWellKnownSymbolResources("known", ["toPrimitive"]);
    expect(() =>
      reserveNativeWellKnownSymbolResources(f.tx, "known", ["toPrimitive"], plan, {
        symbols: f.symbols,
        strings: other,
      }),
    ).toThrow("substituted string dependency");
    unchanged(f, before);
    expect(
      reserveNativeWellKnownSymbolResources(f.tx, "known", ["toPrimitive"], plan, f.dependencies).producers,
    ).toHaveLength(1);
  });

  it.each(["strings", "symbols"] as const)("rejects changed borrowed %s identity after a positive", (kind) => {
    const f = fixture(),
      other = prerequisites();
    current(f);
    if (kind === "strings") f.dependencies.strings = other.strings;
    else f.dependencies.symbols = other.symbols;
    expect(() => current(f)).toThrow("substituted dependency identity");
  });

  it.each(["key", "name", "step"] as const)("rejects changed borrowed plan %s after a positive", (kind) => {
    const f = fixture(false, ["toPrimitive"], true);
    current(f);
    if (kind === "step") Object.defineProperty(f.plan.reservationSteps[0]!, "resourceKey", { value: "changed" });
    else Object.defineProperty(f.plan.declarations[0]!, kind, { value: "changed" });
    expect(() => current(f)).toThrow("changed declaration plan");
  });

  it("refuses a mismatched complete declaration before allocation", () => {
    const f = prerequisites(),
      plan = declareNativeWellKnownSymbolResources("known", ["iterator"]),
      before = populations(f);
    expect(() => reserveNativeWellKnownSymbolResources(f.tx, "known", ["toPrimitive"], plan, f.dependencies)).toThrow(
      "substituted declaration plan",
    );
    unchanged(f, before);
  });

  it("preflights a late key collision before any producer allocation", () => {
    const f = prerequisites();
    f.tx.reserveFunction("known:matchAll", "collision", { params: [], results: [] });
    const before = populations(f),
      selected: WellKnownSymbolName[] = ["iterator", "toPrimitive", "matchAll"];
    expect(() =>
      reserveNativeWellKnownSymbolResources(
        f.tx,
        "known",
        selected,
        declareNativeWellKnownSymbolResources("known", selected),
        f.dependencies,
      ),
    ).toThrow("duplicate planned resource key");
    unchanged(f, before);
    expect(f.tx.state).toBe("failed");
  });

  it.each(["symbol-type", "box-signature"] as const)("preflights a changed %s before allocation", (kind) => {
    const f = prerequisites();
    if (kind === "box-signature") f.symbols.functions.box.object.typeIdx = 100000;
    else Object.defineProperty(f.symbols.types.symbol.object, "name", { value: "SubstitutedSymbol" });
    const before = populations(f);
    expect(() =>
      reserveNativeWellKnownSymbolResources(
        f.tx,
        "known",
        ["toPrimitive"],
        declareNativeWellKnownSymbolResources("known", ["toPrimitive"]),
        f.dependencies,
      ),
    ).toThrow("altered");
    unchanged(f, before);
  });

  it("refuses reservations after freeze without allocating", () => {
    const f = prerequisites();
    f.tx.freezeReservations();
    const before = populations(f);
    expect(() =>
      reserveNativeWellKnownSymbolResources(
        f.tx,
        "known",
        ["toPrimitive"],
        declareNativeWellKnownSymbolResources("known", ["toPrimitive"]),
        f.dependencies,
      ),
    ).toThrow("invalid reservation phase");
    unchanged(f, before);
  });

  it("requires real completed String and Symbol dependencies before canonical fill", () => {
    const f = fixture();
    f.tx.freezeReservations();
    expect(() => fillNativeWellKnownSymbolResources(f.tx, f.pack)).toThrow("missing canonical fill");
    expect(() => fillNativeSymbolCarrierResources(f.tx, f.symbols)).toThrow("incomplete literal resources");
    expect(producer(f).object.body).toEqual([]);
    fillDependencies(f);
    fillNativeWellKnownSymbolResources(f.tx, f.pack);
    expect(Object.is(completed(f), f.pack)).toBe(true);
  });

  it("a reservation accessor does not grant completion", () => {
    const f = fixture();
    expect(Object.is(producer(f), f.pack.producers[0]!.function)).toBe(true);
    f.tx.freezeReservations();
    fillDependencies(f);
    expect(() => completed(f)).toThrow("missing canonical fill");
    fillNativeWellKnownSymbolResources(f.tx, f.pack);
    expect(Object.is(completed(f), f.pack)).toBe(true);
  });

  it("does not certify an identical body filled outside its canonical owner", () => {
    const f = fixture();
    f.tx.freezeReservations();
    fillDependencies(f);
    f.tx.fillFunction(producer(f), {
      locals: [],
      body: [
        { op: "i32.const", value: 3 },
        { op: "call", funcIdx: f.symbols.functions.box.handle },
      ],
    });
    expect(() => completed(f)).toThrow("missing canonical fill");
    expect(() => fillNativeWellKnownSymbolResources(f.tx, f.pack)).toThrow("duplicate function fill");
    expect(f.tx.state).toBe("failed");
    expect(() => completed(f)).toThrow("physical index requested in failed");
  });

  it("refuses duplicate canonical fill while preserving the completed owner", () => {
    const f = complete(),
      body = producer(f).object.body;
    expect(() => fillNativeWellKnownSymbolResources(f.tx, f.pack)).toThrow("duplicate canonical fill");
    expect(Object.is(producer(f).object.body, body)).toBe(true);
    expect(Object.is(completed(f), f.pack)).toBe(true);
  });

  it.each(["producer", "box"] as const)("refuses mutation of a completed %s body", (kind) => {
    const f = complete();
    completed(f);
    (kind === "producer" ? producer(f) : f.symbols.functions.box).object.body.push({ op: "nop" });
    expect(() => completed(f)).toThrow("altered completed function");
  });

  it("refuses mutation of a completed dependency global", () => {
    const f = complete();
    completed(f);
    f.symbols.globals.internTable.object.init.push({ op: "nop" });
    expect(() => completed(f)).toThrow("altered completed global");
  });

  it("refuses a same-signature replacement producer object", () => {
    const f = complete(),
      fn = producer(f);
    completed(f);
    f.module.functions[f.module.functions.indexOf(fn.object)] = { ...fn.object };
    expect(() => completed(f)).toThrow("substituted or reordered functions");
  });

  it("refuses a changed producer signature at its original slot", () => {
    const f = complete(),
      fn = producer(f);
    completed(f);
    fn.object.typeIdx = f.symbols.functions.box.object.typeIdx;
    expect(() => completed(f)).toThrow("altered function descriptor");
  });

  it("does not substitute a foreign same-signature token into its frozen census", () => {
    const f = complete(),
      other = complete();
    current(f);
    current(other);
    expect(Reflect.set(f.pack.producers[0]!, "function", producer(other))).toBe(false);
    expect(Reflect.set(f.pack, "producers", other.pack.producers)).toBe(false);
    expect(() =>
      requireNativeWellKnownSymbolReservations(
        f.tx,
        { ...f.pack, producers: other.pack.producers },
        f.plan,
        f.dependencies,
      ),
    ).toThrow("foreign or copied owner");
    expect(Object.is(completed(f), f.pack)).toBe(true);
    expect(Object.is(completed(other), other.pack)).toBe(true);
  });

  it("rejects a foreign fill transaction without touching the original body", () => {
    const f = fixture(),
      other = fixture();
    expect(() => fillNativeWellKnownSymbolResources(other.tx, f.pack)).toThrow("foreign or copied owner");
    expect(producer(f).object.body).toEqual([]);
  });
});

describe.each([false, true])("actual well-known Symbol execution, offset=%s", (offset) => {
  let runtime: Record<WellKnownSymbolName, () => object> & { box(id: number): object; readId(value: object): number };
  beforeAll(() => {
    const f = fixture(offset, [...names].reverse());
    const readId = f.tx.reserveFunction("read:id", "read_id", {
      params: [{ kind: "externref" }],
      results: [{ kind: "i32" }],
    });
    complete(f);
    f.tx.fillFunction(readId, {
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: f.symbols.types.symbol.typeIndex },
        { op: "struct.get", typeIdx: f.symbols.types.symbol.typeIndex, fieldIdx: 0 },
      ],
    });
    for (const name of names) f.tx.defineExport("export:" + name, name, producer(f, name));
    f.tx.defineExport("export:box", "box", f.symbols.functions.box);
    f.tx.defineExport("export:read-id", "readId", readId);
    if (offset) {
      expect(f.symbols.types.symbol.typeIndex).toBeGreaterThan(0);
      expect(f.tx.physicalIndex(f.symbols.globals.internTable)).toBeGreaterThan(0);
      expect(f.tx.physicalIndex(producer(f))).toBeGreaterThan(0);
    }
    f.tx.seal();
    const bytes = emitBinary(f.module);
    expect(WebAssembly.validate(bytes as BufferSource)).toBe(true);
    const module = new WebAssembly.Module(bytes as BufferSource);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    runtime = new WebAssembly.Instance(module).exports as unknown as typeof runtime;
    expect(Object.is(completed(f), f.pack)).toBe(true);
  });
  it.each(Object.entries(expectedIds))("produces canonical %s identity and exact ID", (name, id) => {
    const boxed = runtime.box(id),
      actual = runtime[name as WellKnownSymbolName]();
    expect(runtime.readId(actual)).toBe(id);
    expect(Object.is(actual, boxed)).toBe(true);
    expect(Object.is(runtime[name as WellKnownSymbolName](), actual)).toBe(true);
    for (const other of names) if (other !== name) expect(Object.is(runtime[other](), actual)).toBe(false);
  });
  it("keeps every canonical identity after ordinary Symbol intern-table growth", () => {
    const before = names.map((name) => runtime[name]());
    expect(runtime.readId(runtime.box(8192))).toBe(8192);
    names.forEach((name, index) => expect(Object.is(runtime[name](), before[index])).toBe(true));
  });
});
