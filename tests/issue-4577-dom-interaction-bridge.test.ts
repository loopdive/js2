// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { observeSingleHostLane } from "../scripts/check-ir-only.js";
import {
  DOM_CALLBACK_DISPATCH_EXPORT,
  DOM_CALLBACK_DISPATCH_PHYSICAL_BASE,
  DOM_STRING_BINDINGS_EXPORT,
  DOM_STRING_BINDINGS_PHYSICAL_BASE,
  DOM_STRING_CHAR_EXPORT,
  DOM_STRING_CHAR_PHYSICAL_BASE,
  DOM_STRING_MANIFEST_EXPORT,
  DOM_STRING_MANIFEST_MAGIC,
  DOM_STRING_MANIFEST_PHYSICAL_BASE,
  DOM_STRING_MARKER_EXPORT,
  DOM_STRING_MARKER_PHYSICAL_BASE,
  DOM_STRING_PREPARE_EXPORT,
  DOM_STRING_PREPARE_PHYSICAL_BASE,
} from "../src/dom-capability-contract.js";
import { compile, type ImportDescriptor } from "../src/index.js";
import {
  DOM_INTERACTION_IMPORT_NAMES,
  createDomCapabilityAdapter,
  type DomCapabilityStringSite,
} from "../src/runtime/dom-capability-adapter.js";
import {
  createStandaloneDomStringBridge,
  standaloneDomStringToHost,
  wrapStandaloneDomCallback,
} from "../src/runtime/standalone-dom-string-bridge.js";

class TestStyle {
  cssText = "";
  background = "";
}

class TestNode {
  readonly style = new TestStyle();
  readonly children: TestNode[] = [];
  readonly listeners = new Map<string, Function[]>();
  textContent = "";
  innerHTML = "";

  constructor(readonly tagName: string) {}

  appendChild(child: TestNode): TestNode {
    this.children.push(child);
    return child;
  }

  contains(candidate: unknown): boolean {
    return candidate === this || this.children.some((child) => child.contains(candidate));
  }

  addEventListener(type: string, callback: Function, options?: unknown): void {
    if (options !== null && options !== undefined) throw new TypeError("unexpected options");
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  fire(type: string): void {
    for (const callback of this.listeners.get(type) ?? []) Reflect.apply(callback, this, [{ type }]);
  }
}

class TestRoot extends TestNode {
  readonly body = this;

  constructor() {
    super("body");
  }

  createElement(tagName: string): TestNode {
    return new TestNode(tagName);
  }
}

const INTERACTION_DESCRIPTORS: readonly ImportDescriptor[] = [
  {
    module: "env",
    name: "HTMLElement_addEventListener",
    kind: "func",
    intent: { type: "extern_class", className: "HTMLElement", action: "method", member: "addEventListener" },
    paramCount: 4,
  },
  {
    module: "env",
    name: "CSSStyleDeclaration_set_background",
    kind: "func",
    intent: { type: "extern_class", className: "CSSStyleDeclaration", action: "set", member: "background" },
    paramCount: 2,
  },
];

function opaqueCarrier(): object {
  return Object.freeze(Object.create(null)) as object;
}

const CALENDAR_SOURCE = readFileSync(
  new URL("../website/playground/examples/dom/calendar.ts", import.meta.url),
  "utf8",
);

function expectPerPlanDomCallbackAuthority(wat: string, lane: string): void {
  const carrierLines = wat.split("\n").filter((line) => /\(type \$\$__js2_dom_callback_\d+\$* /.test(line));
  expect(carrierLines, `${lane} certified callback carrier count`).toHaveLength(7);
  const structuralLayouts = carrierLines.map((line) =>
    line.replace(/\$\$__js2_dom_callback_\d+\$*/, "$$__js2_dom_callback_N"),
  );
  expect(
    structuralLayouts.some((layout, index) => structuralLayouts.indexOf(layout) !== index),
    `${lane} must exercise an equal-layout certified carrier pair`,
  ).toBe(true);

  const dispatcherStart = wat.indexOf("  (func $__js2_standalone_dom_callback_dispatch_impl ");
  const dispatcherEnd = wat.indexOf("\n  (func ", dispatcherStart + 1);
  expect(dispatcherStart, `${lane} dedicated dispatcher`).toBeGreaterThanOrEqual(0);
  expect(dispatcherEnd, `${lane} dedicated dispatcher end`).toBeGreaterThan(dispatcherStart);
  const dispatcher = wat.slice(dispatcherStart, dispatcherEnd);
  const authorityGlobals = [...dispatcher.matchAll(/global\.get (\d+)\s+ref\.eq/g)].map((match) => match[1]!);
  expect(authorityGlobals, `${lane} per-plan identity comparisons`).toHaveLength(7);
  expect(new Set(authorityGlobals).size, `${lane} distinct per-plan identity comparisons`).toBe(7);

  const exactCalls = [...dispatcher.matchAll(/\bcall (\d+)\s+return/g)].map((match) => match[1]!);
  expect(exactCalls, `${lane} exact lifted callback calls`).toHaveLength(7);
  expect(new Set(exactCalls).size, `${lane} distinct lifted callback calls`).toBe(7);
  expect(dispatcher).not.toContain("call_ref");
}

interface BoundaryFixture {
  readonly raw: Record<string, unknown>;
  readonly bindings: WebAssembly.Table;
  readonly dispatch: Function | undefined;
}

async function boundaryFixture(
  size: 3 | 4,
  root: object,
  strings: ReadonlyMap<object, string>,
  observations: unknown[],
  acceptedCarrier?: object,
): Promise<BoundaryFixture> {
  // @ts-expect-error — wabt intentionally ships without bundled TypeScript declarations.
  const wabt = await (await import("wabt")).default();
  let prepared = "";
  const dispatch = (value: unknown): void => {
    if (size === 4 && value !== acceptedCarrier) {
      throw new TypeError("dedicated DOM callback dispatcher rejected a foreign carrier");
    }
    observations.push(value);
  };
  const wat = `(module
    (import "i" "document" (func $document (result externref)))
    (import "i" "prepare" (func $prepare (param externref) (result i32)))
    (import "i" "char" (func $char (param i32) (result i32)))
    ${size === 4 ? '(import "i" "dispatch" (func $dispatch (param externref)))' : ""}
    (table $bindings ${size} ${size} funcref)
    (table $marker 0 0 funcref)
    (global $manifest i32 (i32.const ${DOM_STRING_MANIFEST_MAGIC}))
    (elem (table $bindings) (i32.const 0) func $document $prepare $char${size === 4 ? " $dispatch" : ""})
    (export "$dp" (func $prepare))
    (export "$dc" (func $char))
    ${size === 4 ? '(export "$dd" (func $dispatch))' : ""}
    (export "$dx" (global $manifest))
    (export "$dy" (table $marker))
    (export "$dz" (table $bindings))
  )`;
  const parsed = wabt.parseWat(`dom-boundary-${size}.wat`, wat, { reference_types: true });
  const { buffer } = parsed.toBinary({ log: false, write_debug_names: true });
  parsed.destroy();
  const { instance } = await WebAssembly.instantiate(buffer, {
    i: {
      document: () => root,
      prepare: (value: unknown) => {
        prepared = strings.get(value as object) ?? "";
        return strings.has(value as object) ? prepared.length : -1;
      },
      char: (index: number) => prepared.charCodeAt(index),
      ...(size === 4 ? { dispatch } : {}),
    },
  });
  const exported = instance.exports as Record<string, unknown>;
  const raw: Record<string, unknown> = {
    ...exported,
    [DOM_STRING_PREPARE_EXPORT]: exported[DOM_STRING_PREPARE_PHYSICAL_BASE],
    [DOM_STRING_CHAR_EXPORT]: exported[DOM_STRING_CHAR_PHYSICAL_BASE],
    [DOM_STRING_MANIFEST_EXPORT]: exported[DOM_STRING_MANIFEST_PHYSICAL_BASE],
    [DOM_STRING_MARKER_EXPORT]: exported[DOM_STRING_MARKER_PHYSICAL_BASE],
    [DOM_STRING_BINDINGS_EXPORT]: exported[DOM_STRING_BINDINGS_PHYSICAL_BASE],
  };
  if (size === 4) {
    raw[DOM_CALLBACK_DISPATCH_EXPORT] = exported[DOM_CALLBACK_DISPATCH_PHYSICAL_BASE];
  }
  return {
    raw,
    bindings: exported[DOM_STRING_BINDINGS_PHYSICAL_BASE] as WebAssembly.Table,
    dispatch: size === 4 ? (exported[DOM_CALLBACK_DISPATCH_PHYSICAL_BASE] as Function) : undefined,
  };
}

describe("#4577 exact DOM interaction adapter", () => {
  it("keeps base dom@1 at eight imports and enables only the exact two-operation extension", () => {
    const root = new TestRoot();
    const projector = (value: unknown): string => {
      if (typeof value !== "string") throw new TypeError("not a strict string");
      return value;
    };
    const base = createDomCapabilityAdapter({ root, toHostString: projector });
    expect(Object.keys(base.imports)).toHaveLength(8);
    expect(base.bind(INTERACTION_DESCRIPTORS[0]!)).toBeUndefined();

    const wrapped = new WeakMap<object, Function>();
    const interaction = createDomCapabilityAdapter({
      root,
      toHostString: projector,
      interaction: {
        wrapCallback: (carrier) => {
          if (carrier === null || typeof carrier !== "object") throw new TypeError("wrong carrier");
          let callback = wrapped.get(carrier);
          callback ??= () => undefined;
          wrapped.set(carrier, callback);
          return callback;
        },
      },
    });
    expect(Object.keys(interaction.imports)).toHaveLength(10);
    expect(Object.keys(interaction.imports)).toEqual(expect.arrayContaining([...DOM_INTERACTION_IMPORT_NAMES]));
    for (const descriptor of INTERACTION_DESCRIPTORS) expect(interaction.bind(descriptor)).toBeTypeOf("function");
    expect(
      interaction.bind({
        ...INTERACTION_DESCRIPTORS[0]!,
        paramCount: 3,
      }),
    ).toBeUndefined();
  });

  it("authorizes listener/style owners, projects strings strictly, and rejects options or foreign authority", () => {
    const root = new TestRoot();
    const carrier = opaqueCarrier();
    const eventTypeCarrier = {};
    const backgroundCarrier = {};
    let callbackCalls = 0;
    const sites: DomCapabilityStringSite[] = [];
    const adapter = createDomCapabilityAdapter({
      root,
      toHostString: (value, site) => {
        sites.push(site);
        if (value === eventTypeCarrier) return "click";
        if (value === backgroundCarrier) return "purple";
        throw new TypeError("strict string required");
      },
      interaction: {
        wrapCallback: (value) => {
          if (value !== carrier) throw new TypeError("wrong lifecycle carrier");
          return () => callbackCalls++;
        },
      },
    });
    const node = adapter.imports.Document_createElement(adapter.imports.global_document(), "button") as TestNode;
    const addEventListener = adapter.imports.HTMLElement_addEventListener!;
    addEventListener(node, eventTypeCarrier, carrier, null);
    node.fire("click");
    node.fire("click");
    expect(callbackCalls).toBe(2);

    const style = adapter.imports.HTMLElement_get_style(node);
    adapter.imports.CSSStyleDeclaration_set_background!(style, backgroundCarrier);
    expect(node.style.background).toBe("purple");
    expect(sites).toEqual(["HTMLElement.addEventListener type", "CSSStyleDeclaration.background"]);

    expect(() => addEventListener(node, "click", carrier, { once: true })).toThrow(/options.*null|undefined/i);
    expect(() => addEventListener(new TestNode("foreign"), "click", carrier, null)).toThrow(/authority|subtree/i);
    expect(() => adapter.imports.CSSStyleDeclaration_set_background!(new TestStyle(), "red")).toThrow(
      /provider style|authority/i,
    );
    expect(() => addEventListener(node, {}, carrier, null)).toThrow(/strict string/i);
  });
});

describe("#4577 authenticated reusable DOM callback bridge", () => {
  it("accepts the base three-slot string boundary without manufacturing callback authority", async () => {
    const root = Object.freeze({ root: "base" });
    const carrier = opaqueCarrier();
    const fixture = await boundaryFixture(3, root, new Map([[carrier, "base-three"]]), []);
    const bridge = createStandaloneDomStringBridge();
    const current = fixture.raw;
    const state = { getExports: () => current };
    bridge.bindCapabilityImport(fixture.bindings.get(0)!, root);
    bridge.bindCallbackState(state);
    expect(() => wrapStandaloneDomCallback(carrier, state)).toThrow(/base dom@1.*callback authority/i);
    bridge.recordExportView(fixture.raw, fixture.raw, true);
    expect(standaloneDomStringToHost(carrier, state)).toBe("base-three");
    expect(() => wrapStandaloneDomCallback(carrier, state)).toThrow(/base dom@1.*callback authority/i);
  });

  it("leaves the post-timer JavaScript-host Calendar lane at 38/38 without standalone callback authority", async () => {
    const lane = await observeSingleHostLane();
    const outcomes = lane.entries.flatMap((entry) => entry.outcomes);
    expect(outcomes.filter((outcome) => outcome.kind === "emitted")).toHaveLength(38);
    expect(outcomes.filter((outcome) => outcome.kind !== "emitted")).toHaveLength(0);
  });

  it("keeps equal-layout certified callback plans on distinct singleton/function arms", async () => {
    const [ir, direct] = await Promise.all(
      [true, false].map((experimentalIR) =>
        compile(CALENDAR_SOURCE, {
          fileName: "website/playground/examples/dom/calendar.ts",
          target: "standalone",
          experimentalIR,
          emitWat: true,
          hostBridge: "always",
          optimize: false,
        }),
      ),
    );
    for (const [lane, result] of [
      ["IR", ir],
      ["direct", direct],
    ] as const) {
      expect(result.success, result.errors.map(({ message }) => message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary), `${lane} binary`).toBe(true);
      expectPerPlanDomCallbackAuthority(result.wat ?? "", lane);
    }
  });

  it("dispatches lazily and repeatedly only through the current authenticated four-slot instance", async () => {
    const root = Object.freeze({ root: "interaction" });
    const carrier = opaqueCarrier();
    const observations: unknown[] = [];
    const fixture = await boundaryFixture(4, root, new Map([[carrier, "four"]]), observations, carrier);
    const bridge = createStandaloneDomStringBridge({ interaction: true });
    let current: Record<string, unknown> | undefined;
    const state = { getExports: () => current };
    bridge.bindCapabilityImport(fixture.bindings.get(0)!, root);
    bridge.bindCallbackState(state);
    bridge.recordExportView(fixture.raw, fixture.raw, true);

    const callback = wrapStandaloneDomCallback(carrier, state);
    expect(wrapStandaloneDomCallback(carrier, state)).toBe(callback);
    expect(observations).toEqual([]);
    expect(() => callback()).toThrow(/dispatcher.*not authenticated/i);

    current = fixture.raw;
    expect(callback()).toBeUndefined();
    expect(callback()).toBeUndefined();
    expect(observations).toEqual([carrier, carrier]);

    const collisionRaw = {
      ...fixture.raw,
      [DOM_CALLBACK_DISPATCH_EXPORT]: fixture.raw[DOM_STRING_PREPARE_PHYSICAL_BASE],
      [DOM_CALLBACK_DISPATCH_PHYSICAL_BASE]: fixture.raw[DOM_STRING_PREPARE_PHYSICAL_BASE],
      [`${DOM_CALLBACK_DISPATCH_PHYSICAL_BASE}$`]: fixture.dispatch,
    };
    const collisionBridge = createStandaloneDomStringBridge({ interaction: true });
    let collisionCurrent: Record<string, unknown> | undefined = collisionRaw;
    const collisionState = { getExports: () => collisionCurrent };
    collisionBridge.bindCapabilityImport(fixture.bindings.get(0)!, root);
    collisionBridge.bindCallbackState(collisionState);
    collisionBridge.recordExportView(collisionRaw, collisionRaw, true);
    expect(wrapStandaloneDomCallback(carrier, collisionState)()).toBeUndefined();
    expect(observations).toEqual([carrier, carrier, carrier]);
    collisionCurrent = undefined;

    current = {};
    expect(() => callback()).toThrow(/dispatcher.*not authenticated/i);
    current = fixture.raw;
    expect(callback()).toBeUndefined();
    expect(observations).toEqual([carrier, carrier, carrier, carrier]);

    expect(() => wrapStandaloneDomCallback({}, state)).toThrow(/non-closure callback carrier/i);
    expect(() => wrapStandaloneDomCallback(null, state)).toThrow(/non-closure callback carrier/i);
    const forged = opaqueCarrier();
    const forgedCallback = wrapStandaloneDomCallback(forged, state);
    expect(() => forgedCallback()).toThrow(/dedicated DOM callback dispatcher rejected a foreign carrier/i);
  });

  it("rejects donors, dispatch aliases that disagree with slot three, and live slot tampering", async () => {
    const root = Object.freeze({ root: "victim" });
    const carrier = opaqueCarrier();
    const victimObservations: unknown[] = [];
    const donorObservations: unknown[] = [];
    const [victim, donor] = await Promise.all([
      boundaryFixture(4, root, new Map(), victimObservations, carrier),
      boundaryFixture(4, root, new Map(), donorObservations, carrier),
    ]);
    const bridge = createStandaloneDomStringBridge({ interaction: true });
    let current: Record<string, unknown> | undefined;
    const state = { getExports: () => current };
    bridge.bindCapabilityImport(victim.bindings.get(0)!, root);
    bridge.bindCallbackState(state);

    // An unbranded/raw donor view cannot establish authority, even when it
    // returns the same root object.
    bridge.recordExportView(donor.raw, donor.raw, false);
    current = donor.raw;
    expect(() => wrapStandaloneDomCallback(carrier, state)()).toThrow(/dispatcher.*not authenticated/i);

    const mismatched = { ...victim.raw, [DOM_CALLBACK_DISPATCH_PHYSICAL_BASE]: donor.dispatch };
    bridge.recordExportView(mismatched, mismatched, true);
    current = mismatched;
    expect(() => wrapStandaloneDomCallback(carrier, state)()).toThrow(/dispatcher.*not authenticated/i);

    bridge.recordExportView(victim.raw, victim.raw, true);
    current = victim.raw;
    const callback = wrapStandaloneDomCallback(carrier, state);
    expect(callback()).toBeUndefined();
    expect(victimObservations).toEqual([carrier]);

    victim.bindings.set(3, donor.dispatch!);
    expect(() => callback()).toThrow(/dispatcher.*not authenticated/i);
    expect(donorObservations).toEqual([]);
    victim.bindings.set(3, victim.dispatch!);
    expect(callback()).toBeUndefined();
    expect(victimObservations).toEqual([carrier, carrier]);

    const forgedManifest = {
      ...victim.raw,
      [DOM_STRING_MANIFEST_PHYSICAL_BASE]: new WebAssembly.Global({ value: "i32", mutable: false }, 0),
    };
    const freshBridge = createStandaloneDomStringBridge({ interaction: true });
    let forgedCurrent: Record<string, unknown> | undefined = forgedManifest;
    const freshState = { getExports: () => forgedCurrent };
    freshBridge.bindCapabilityImport(victim.bindings.get(0)!, root);
    freshBridge.bindCallbackState(freshState);
    freshBridge.recordExportView(forgedManifest, forgedManifest, true);
    expect(() => wrapStandaloneDomCallback(carrier, freshState)()).toThrow(/dispatcher.*not authenticated/i);
    forgedCurrent = undefined;
  });
});
