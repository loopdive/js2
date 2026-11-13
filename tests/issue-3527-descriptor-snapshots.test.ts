// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import type { StructTypeDef } from "../src/wasm/model/module-records.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { originalText } from "./helpers/physical-snapshot-oracle.js";

type Control = StructTypeDef & { audit: unknown };
function observe(run: () => unknown) {
  try {
    run();
    return "ok";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
function pair(make: (events: string[]) => unknown) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const events = { actual: [] as string[], original: [] as string[] };
  const actual: Control = { kind: "struct", name: "control", fields: [], audit: make(events.actual) };
  const reference: Control = { kind: "struct", name: "control", fields: [], audit: make(events.original) };
  const token = tx.reserveType("control", actual);
  const expectedType = originalText(reference);
  const expectedToken = originalText(reference);
  events.actual.length = events.original.length = 0;
  return {
    actual,
    reference,
    events,
    tx,
    both(change: (value: Control) => void) {
      change(actual);
      change(reference);
    },
    check() {
      events.actual.length = events.original.length = 0;
      // A reserved type is checked once as a token and once in the interned type census.
      const old = observe(() => {
        if (originalText(reference) !== expectedToken) throw Error("altered type descriptor control");
        if (originalText(reference) !== expectedType) throw Error("altered reserved type definition/signature");
      });
      const current = observe(() => tx.assertTypeReservation(token));
      expect(current).toBe(old === "ok" ? old : "physical module reservations: " + old);
      expect(events.actual).toEqual(events.original);
      return current;
    },
  };
}
function nan(low: number) {
  const data = new DataView(new ArrayBuffer(8));
  data.setUint32(4, 0x7ff80000, true);
  data.setUint32(0, low, true);
  return data.getFloat64(0, true);
}

describe("fresh descriptor audits preserve the pinned textual algorithm", () => {
  it.each([
    { reads: [1, 2, 2, 1], result: "ok", checked: [2, 1] },
    { reads: [1, 2, 3, 1], result: "physical module reservations: altered type descriptor control", checked: [3] },
    {
      reads: [1, 2, 2, 3],
      result: "physical module reservations: altered reserved type definition/signature",
      checked: [2, 3],
    },
  ])("captures type and token separately, then audits token before type: $reads", ({ reads, result, checked }) => {
    const p = pair((events) => {
      let index = 0;
      return {
        get value() {
          const value = reads[index++];
          events.push(String(value));
          return value;
        },
      };
    });
    expect(p.check()).toBe(result);
    expect(p.events.actual).toEqual(checked.map(String));
  });
  it("accepts equal data repeatedly without retaining a successful audit", () => {
    const p = pair(() => ({
      raw: [-0, Infinity, nan(3), 7n, undefined, "\ud800"],
      bytes: new Uint8Array([1, 2]),
      sparse: Object.assign(new Array(3), { 1: 4, extra: true }),
    }));
    expect(p.check()).toBe("ok");
    expect(p.check()).toBe("ok");
    p.both((row) => {
      (row.audit as { bytes: Uint8Array }).bytes[1] = 3;
    });
    expect(p.check()).toContain("altered type descriptor");
    expect(p.tx.state).toBe("failed");
  });
  it.each([
    ["signed zero", (): unknown => -0, (): unknown => 0],
    ["NaN payload", (): unknown => nan(1), (): unknown => nan(2)],
    ["infinity sign", (): unknown => Infinity, (): unknown => -Infinity],
    ["present undefined", (): unknown => ({ x: undefined }), (): unknown => ({})],
    ["key order", (): unknown => ({ a: 1, b: 2 }), (): unknown => ({ b: 2, a: 1 })],
    ["array hole", (): unknown => new Array(1), (): unknown => [undefined]],
    ["byte tag", (): unknown => new Uint8Array([4]), (): unknown => ({ 0: 4 })],
  ] as const)("rejects changed %s", (_name, before, after) => {
    const p = pair(before);
    expect(p.check()).toBe("ok");
    p.both((row) => {
      row.audit = after();
    });
    expect(p.check()).toContain("altered type descriptor");
  });
  it("preserves sibling getter order and a later error ahead of mismatch", () => {
    const p = pair(() => ({ first: 1, second: 2 }));
    for (const [row, events] of [
      [p.actual, p.events.actual],
      [p.reference, p.events.original],
    ] as const) {
      row.audit = Object.defineProperties(
        {},
        {
          first: {
            enumerable: true,
            get() {
              events.push("first");
              return 9;
            },
          },
          second: {
            enumerable: true,
            get() {
              events.push("second");
              return {
                get child() {
                  events.push("child");
                  throw Error("later error");
                },
              };
            },
          },
        },
      );
    }
    expect(p.check()).toBe("physical module reservations: later error");
    expect(p.events.actual).toEqual(["first", "second", "child"]);
  });
  it.each(["cycle", "symbol", "function"])("preserves %s error precedence", (kind) => {
    const p = pair(() => ({ first: 1 }));
    p.both((row) => {
      const value: Record<string, unknown> = { first: 2 };
      value.last = kind === "cycle" ? value : kind === "symbol" ? Symbol() : () => 1;
      row.audit = value;
    });
    expect(p.check()).toContain(
      kind === "cycle" ? "cyclic physical descriptor" : "unsupported physical descriptor value",
    );
  });
  it("preserves Proxy reads in both token and type audits", () => {
    const p = pair(
      (events) =>
        new Proxy([1], {
          get(target, key, receiver) {
            events.push("get:" + String(key));
            return Reflect.get(target, key, receiver);
          },
          ownKeys(target) {
            events.push("keys");
            return Reflect.ownKeys(target);
          },
        }),
    );
    expect(p.check()).toBe("ok");
    expect(p.events.actual).toEqual(["get:length", "keys", "get:0", "get:length", "keys", "get:0"]);
  });
});

it.each(["function", "global", "interned-type", "rec-member"] as const)(
  "authenticates current %s without using a prior success",
  (kind) => {
    const m = createEmptyModule(),
      tx = new PhysicalModuleReservations(m);
    const fn = tx.reserveFunction("fn", "fn", { params: [], results: [] });
    const global = tx.reserveGlobal("g", "g", { kind: "i32" }, true);
    const member: StructTypeDef = { kind: "struct", name: "member", fields: [] };
    const typeToken = tx.reserveType("rec", { kind: "rec", types: [member] });
    tx.assertTypeReservation(typeToken);
    if (kind === "function") fn.object.exported = true;
    else if (kind === "global") global.object.type = { kind: "f64" };
    else if (kind === "interned-type") {
      const type = m.types[0]!;
      if (type.kind !== "func") throw Error("expected actual interned function signature");
      type.name = "changed";
    } else member.fields.push({ name: "new", type: { kind: "i32" }, mutable: true });
    expect(() => tx.assertTypeReservation(typeToken)).toThrow(/altered/);
    expect(tx.state).toBe("failed");
  },
);
