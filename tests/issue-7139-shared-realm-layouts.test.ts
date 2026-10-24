// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import {
  reserveNativeRealmObjectState,
  extendNativeRealmObjectLayouts,
  requireNativeRealmObjectLayouts,
  nativeRealmObjectStateOwner,
  nativeRealmObjectLayoutReservationInventory,
  nativeRealmObjectStateReservationInventory,
  fillNativeRealmObjectState,
  fillNativeRealmObjectLayouts,
  requireCompletedNativeRealmObjectLayouts,
  bindNativeRealmObjectBootstrap,
  requireNativeRealmObjectBootstrap,
} from "../src/backend/wasmgc/resources/native-realm-object-layouts.js";
import { declareNativeRealmObjectLayoutExtension } from "../src/backend/wasmgc/resources/native-realm-object-layout-declarations.js";
import { realmLayoutFoundation, reserveRealmAnchorControls } from "./helpers/native-realm-object-layouts.js";
import { publicRealmFoundation, publicRealmClosures, publicRealmDeclarations } from "./helpers/native-object-realm.js";
import { nativeSourceClosureRealmState } from "../src/backend/wasmgc/resources/native-source-closures.js";
import { requireCompletedNativeObjectRealm } from "../src/backend/wasmgc/resources/native-object-realm.js";
import { emitBinary } from "../src/emit/binary.js";

function fixture(displaced = false) {
  const f = realmLayoutFoundation(displaced);
  const state = reserveNativeRealmObjectState(f.tx, "source-state");
  const plan = structuredClone(
    declareNativeRealmObjectLayoutExtension(
      "shared-layout",
      f.objects.object.key,
      f.objects.propMap.key,
      state.types.state.key,
    ),
  );
  return { ...f, state, plan };
}
function counts(f: ReturnType<typeof fixture>) {
  return [f.module.types.length, f.module.functions.length, f.module.globals.length];
}
function extend(f: ReturnType<typeof fixture>) {
  return extendNativeRealmObjectLayouts(f.tx, "shared-layout", f.state, f.dependencies, f.plan);
}

it("reserves object subtypes and their allocator, keeping the actual state, anchors and initializer owner", () => {
  const f = fixture(),
    before = counts(f),
    pack = extend(f);
  expect(counts(f)).toEqual([before[0]! + 3, before[1]! + 1, before[2]]);
  expect(pack.types.identity).toBe(f.state.types.identity);
  expect(pack.types.state).toBe(f.state.types.state);
  expect(pack.anchors).toBe(f.state.anchors);
  expect(pack.prototypeInitializer).toBe(f.state.prototypeInitializer);
  expect(pack.sourceInitializer).toBe(f.state.sourceInitializer);
  expect(nativeRealmObjectStateOwner(f.tx, pack)).toBe(f.state);
  expect(nativeRealmObjectStateOwner(f.tx, f.state)).toBe(f.state);
  expect(nativeRealmObjectLayoutReservationInventory(f.tx, pack)).toMatchObject({
    globals: [],
    functions: [pack.allocateOrdinary],
  });
  expect(nativeRealmObjectLayoutReservationInventory(f.tx, pack).types).toEqual([
    pack.types.objectPrototype,
    pack.types.ordinary,
  ]);
  expect(nativeRealmObjectStateReservationInventory(f.tx, f.state).types).toHaveLength(2);
});

it("keeps one extension and one bootstrap across both views of the owner", () => {
  const f = fixture(),
    pack = extend(f),
    before = counts(f);
  expect(() => extend(f)).toThrow("already has ordinary object layouts");
  expect(() => extendNativeRealmObjectLayouts(f.tx, "second", pack, f.dependencies)).toThrow(
    "already has ordinary object layouts",
  );
  expect(counts(f)).toEqual(before);
  const bootstrap = f.tx.reserveFunction("bootstrap", "bootstrap", { params: [], results: [] });
  bindNativeRealmObjectBootstrap(f.tx, pack, bootstrap);
  requireNativeRealmObjectBootstrap(f.tx, f.state, bootstrap);
  expect(() => bindNativeRealmObjectBootstrap(f.tx, f.state, bootstrap)).toThrow("duplicate bootstrap binding");
});

it("refuses copied/foreign state and non-data dependencies before reserving extension resources", () => {
  for (const kind of ["copied", "foreign", "accessor", "objects-accessor"] as const) {
    const f = fixture(),
      before = counts(f);
    let reads = 0;
    const storage =
      kind === "accessor"
        ? {
            get objects() {
              reads++;
              return f.objects;
            },
            objectPlan: f.objectPlan,
          }
        : kind === "objects-accessor"
          ? {
              objects: {
                ...f.objects,
                get object() {
                  reads++;
                  return f.objects.object;
                },
              },
              objectPlan: f.objectPlan,
            }
          : f.dependencies;
    const state = kind === "copied" ? { ...f.state } : kind === "foreign" ? fixture().state : f.state;
    expect(() => extendNativeRealmObjectLayouts(f.tx, "shared-layout", state, storage)).toThrow(
      /foreign or copied|data fields|foreign/,
    );
    expect(reads).toBe(0);
    expect(counts(f)).toEqual(before);
  }
});

it("rejects changed plans and storage, and does not consume the extension on a failed preflight", () => {
  const f = fixture(),
    before = counts(f),
    wrong = structuredClone(f.plan);
  (wrong.declarations[1] as any).shape.fields.at(-1).type.typeKey = "foreign:state";
  expect(() => extendNativeRealmObjectLayouts(f.tx, "shared-layout", f.state, f.dependencies, wrong)).toThrow();
  expect(counts(f)).toEqual(before);
  const pack = extend(f);
  (f.plan.declarations[1] as any).shape.fields.at(-1).mutable = true;
  expect(() => requireNativeRealmObjectLayouts(f.tx, pack)).toThrow("changed retained declaration plan");
});

it("requires the original fill and rejects altered borrowed state after completion", () => {
  const f = fixture(),
    pack = extend(f);
  f.tx.freezeReservations();
  expect(() => requireCompletedNativeRealmObjectLayouts(f.tx, pack)).toThrow("missing canonical layout extension fill");
  expect(() => fillNativeRealmObjectLayouts(f.tx, pack)).toThrow("missing canonical initializer fill");
  expect(() => fillNativeRealmObjectState(f.tx, pack)).toThrow("original owner");
  fillNativeRealmObjectState(f.tx, f.state);
  fillNativeRealmObjectLayouts(f.tx, pack);
  expect(requireCompletedNativeRealmObjectLayouts(f.tx, pack)).toBe(pack);
  expect(() => fillNativeRealmObjectLayouts(f.tx, pack)).toThrow("duplicate canonical fill");
  expect(() => fillNativeRealmObjectState(f.tx, f.state)).toThrow("duplicate canonical fill");
  f.state.sourceInitializer.object.body.push({ op: "nop" });
  expect(() => requireCompletedNativeRealmObjectLayouts(f.tx, pack)).toThrow(/altered completed|noncanonical/);
});

for (const displaced of [false, true])
  it(`executes both initializers over the same anchors, displaced=${displaced}`, () => {
    const f = fixture(displaced),
      pack = extend(f);
    const controls = reserveRealmAnchorControls({ tx: f.tx, pack });
    f.tx.freezeReservations();
    if (f.prefix) {
      f.tx.fillGlobal(f.prefix.global, [{ op: "i32.const", value: 17 }]);
      f.tx.fillFunction(f.prefix.function, { locals: [], body: [] });
    }
    fillNativeRealmObjectState(f.tx, f.state);
    fillNativeRealmObjectLayouts(f.tx, pack);
    controls.fill();
    f.tx.seal();
    const wasm = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
    expect(WebAssembly.Module.imports(wasm)).toEqual([]);
    const a = new WebAssembly.Instance(wasm).exports as Record<string, (...args: any[]) => any>;
    const b = new WebAssembly.Instance(wasm).exports as typeof a;
    const proto = {},
      other = {};
    expect(() => a.ordinary!(null)).toThrow(WebAssembly.RuntimeError);
    a.initialize!(proto);
    b.initialize!(other);
    const object = a.ordinary!(null),
      child = a.ordinary!(object);
    const objectState = a.ordinaryState!(object),
      childState = a.ordinaryState!(child);
    expect(a.prototype!(objectState)).toBeNull();
    expect(Object.is(a.prototype!(childState), object)).toBe(true);
    expect(Object.is(a.realm!(childState), a.realm!(a.state!()))).toBe(true);
    const source = a.state!(),
      ordinary = a.stateWithPrototype!(other),
      next = a.state!();
    expect(Object.is(source, next)).toBe(false);
    expect(a.prototype!(source)).toBe(proto);
    expect(a.prototype!(ordinary)).toBe(other);
    expect(Object.is(a.realm!(source), a.realm!(ordinary))).toBe(true);
    expect(Object.is(a.realm!(source), b.realm!(b.state!()))).toBe(false);
    expect(b.prototype!(b.state!())).toBe(other);
  });

for (const decoded of [false, true])
  it(`joins original source closure state to public declarations without granting readiness, decoded=${decoded}`, () => {
    const f = publicRealmFoundation(false, decoded, false, false, undefined, undefined, undefined, true);
    const c = publicRealmClosures(f),
      p = publicRealmDeclarations(f, c).declarations;
    expect(nativeSourceClosureRealmState(f.tx, c.source!.types)).toBe(f.sharedState);
    expect(nativeRealmObjectStateOwner(f.tx, p.layouts)).toBe(f.sharedState);
    expect(p.globals.realm).toBe(f.sharedState!.anchors.realm);
    expect(p.globals.functionPrototype).toBe(f.sharedState!.anchors.functionPrototype);
    expect(p.completionScope).toBe("public-realm-declarations-only");
    expect(() => requireCompletedNativeObjectRealm(f.tx, p)).toThrow("missing canonical declaration fill");
  });
