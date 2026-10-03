// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import ts from "typescript";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import type { Instr, LocalDef } from "../src/wasm/model/instructions.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";

// Exact independent textual oracle from e4737c9f1dcb632c56f3cc3a31e3ad47cd7f848e.
// Entire historical module SHA256: 693befe89f7d5533c7ce41c7df465973fc48a2f6873201bac3229a0634f65210.
// The literal is fixed test evidence, never fetched from Git or the changed comparator.
const ORIGINAL_TEXTUAL_ALGORITHM = [
  "function dataText(data: PhysicalData): string {",
  "  const active = new Set<object>();",
  "  const numberBits = new DataView(new ArrayBuffer(8));",
  "  const encode = (value: object | string | number | bigint | boolean | undefined | null): string => {",
  '    if (value === null) return "null";',
  '    if (value === undefined) return "undefined";',
  "    switch (typeof value) {",
  '      case "string":',
  "        return `string:${JSON.stringify(value)}`;",
  '      case "boolean":',
  "        return `boolean:${value}`;",
  '      case "bigint":',
  "        return `bigint:${value}`;",
  '      case "number":',
  "        // Same Float64 store as WasmEncoder.f64: even distinct NaN payloads",
  "        // can change emitted bytes. Do not normalize or stringify the value.",
  "        numberBits.setFloat64(0, value, true);",
  '        return `number:${numberBits.getUint32(4, true).toString(16).padStart(8, "0")}${numberBits.getUint32(0, true).toString(16).padStart(8, "0")}`;',
  '      case "object": {',
  '        if (active.has(value)) throw new Error("cyclic physical descriptor");',
  "        active.add(value);",
  '        const tag = Array.isArray(value) ? `array:${value.length}` : value instanceof Uint8Array ? "bytes" : "object";',
  "        const fields = Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}:${encode(entry)}`);",
  "        active.delete(value);",
  '        return `${tag}{${fields.join(",")}}`;',
  "      }",
  "      default:",
  '        throw new Error("unsupported physical descriptor value");',
  "    }",
  "  };",
  "  return encode(data);",
  "}",
].join("\n");
const ORIGINAL_TEXTUAL_SHA256 = "8779b9b6ff208763e3a251c41c7bc808a4a66aa45592ce0b6b24bc095a4e87c1";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
let originalText: (value: unknown) => string;
beforeAll(() => {
  if (hash(ORIGINAL_TEXTUAL_ALGORITHM) !== ORIGINAL_TEXTUAL_SHA256)
    throw Error("changed pinned textual snapshot oracle");
  const javascript = ts.transpileModule(ORIGINAL_TEXTUAL_ALGORITHM, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  originalText = new Function(javascript + ";return dataText;")() as (value: unknown) => string;
});
afterEach(async () => await setImmediate());

type FunctionData = Record<string, unknown> & { locals: LocalDef[]; body: Instr[] };
const altered = "physical module reservations: altered completed function control";
function observed(operation: () => unknown) {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
function historicalText(value: unknown): string {
  try {
    return originalText(value);
  } catch (error) {
    throw Error("physical module reservations: " + (error instanceof Error ? error.message : String(error)));
  }
}

/** Actual public ledger, paired with only the original full-text and outer identity checks. */
function pair(make: (events: string[]) => unknown = () => ({ nested: { value: 1 } })) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module),
    token = tx.reserveFunction("control", "snapshotControl", { params: [], results: [] });
  tx.freezeReservations();
  const events = { actual: [] as string[], original: [] as string[] },
    actual = token.object as unknown as FunctionData,
    reference = { ...token.object } as unknown as FunctionData,
    definition = { locals: [] as LocalDef[], body: [{ op: "nop" }] as Instr[] },
    oldDefinition = { locals: [] as LocalDef[], body: [{ op: "nop" }] as Instr[] };
  actual.audit = make(events.actual);
  reference.audit = make(events.original);
  reference.locals = oldDefinition.locals;
  reference.body = oldDefinition.body;
  let expected = "";
  const oldCapture = observed(() => {
      expected = historicalText(reference);
    }),
    newCapture = observed(() => tx.fillFunction(token, definition));
  return {
    tx,
    token,
    actual,
    reference,
    events,
    oldCapture,
    newCapture,
    both(change: (fn: FunctionData) => void) {
      change(actual);
      change(reference);
    },
    check() {
      const oldResult = observed(() => {
        if (
          reference.locals !== oldDefinition.locals ||
          reference.body !== oldDefinition.body ||
          historicalText(reference) !== expected
        )
          throw Error(altered);
        return [0];
      });
      return { actual: observed(() => tx.physicalIndices([token])), original: oldResult };
    },
  };
}
function passes(p: ReturnType<typeof pair>) {
  expect(p.newCapture).toEqual(p.oldCapture);
  expect(p.newCapture).toEqual({ ok: true, value: undefined });
  const result = p.check();
  expect(result.actual).toEqual(result.original);
  expect(result.actual).toEqual({ ok: true, value: [0] });
}
function refuses(p: ReturnType<typeof pair>, message = altered) {
  const result = p.check();
  expect(result.actual).toEqual(result.original);
  expect(result.actual).toEqual({ ok: false, error: message });
}
function nan(high: number, low: number): number {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setUint32(4, high, true);
  bits.setUint32(0, low, true);
  return bits.getFloat64(0, true);
}
function words(value: number) {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value, true);
  return [bits.getUint32(4, true), bits.getUint32(0, true)];
}

describe("fresh filled-function snapshots match the historical textual algorithm", () => {
  it("pins the independent original algorithm and keeps other ledger snapshots on that exact implementation", () => {
    const text = readFileSync(new URL("../src/wasm/physical/module-reservations.ts", import.meta.url), "utf8"),
      file = ts.createSourceFile("module-reservations.ts", text, ts.ScriptTarget.Latest, true),
      donors = file.statements.filter(
        (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "dataText",
      );
    expect(donors).toHaveLength(1);
    expect(hash(donors[0]!.getText(file))).toBe(ORIGINAL_TEXTUAL_SHA256);
    expect(hash(ORIGINAL_TEXTUAL_ALGORITHM)).toBe(ORIGINAL_TEXTUAL_SHA256);
  });
  it("retains primitive kinds, raw float words, escaped keys, lone surrogates and present undefined", () => {
    const make = () => ({
      values: [
        -0,
        0,
        Infinity,
        -Infinity,
        nan(0x7ff80000, 1),
        nan(0xfff80000, 2),
        4n,
        -9n,
        true,
        false,
        undefined,
        null,
        'quote"\\\n',
        "\ud800",
        "\udfff",
      ],
      'key"\\\n\ud800': { present: undefined },
      array: Object.assign(new Array<unknown>(3), { 1: 7, 2: undefined, extra: "value" }),
    });
    const p = pair(make);
    expect(words(nan(0x7ff80000, 1))).not.toEqual(words(nan(0x7ff80000, 2)));
    for (let repeat = 0; repeat < 3; repeat++) passes(p);
  });
  it.each([
    ["negative-zero", () => -0, () => 0],
    ["positive-zero", () => 0, () => -0],
    ["infinity-sign", () => Infinity, () => -Infinity],
    ["finite-to-infinity", () => 17, () => Infinity],
    ["NaN-payload", () => nan(0x7ff80000, 1), () => nan(0x7ff80000, 2)],
    ["NaN-sign", () => nan(0x7ff80000, 1), () => nan(0xfff80000, 1)],
    ["bigint", () => 1n, () => 2n],
    ["bigint-to-number", () => 1n, () => 1],
    ["boolean", () => true, () => false],
    ["null-to-undefined", () => null, () => undefined],
    ["lone-surrogate", () => "\ud800", () => "\ud801"],
    ["escaped-string", () => '"\\', () => '\\"'],
  ] as const)("detects warmed scalar change: %s", (_name, initial, changed) => {
    const p = pair(() => ({ value: initial() }));
    passes(p);
    passes(p);
    p.both((fn) => {
      (fn.audit as { value: unknown }).value = changed();
    });
    refuses(p);
  });
  it.each([
    [
      "nested instruction",
      (fn: FunctionData) => {
        fn.body[0] = { op: "block", blockType: { kind: "empty" }, body: [{ op: "nop" }] };
      },
    ],
    [
      "local population",
      (fn: FunctionData) => {
        fn.locals.push({ name: "new", type: { kind: "i32" } });
      },
    ],
    [
      "undefined presence",
      (fn: FunctionData) => {
        Object.defineProperty(fn.audit, "extra", { value: undefined, enumerable: true });
      },
    ],
    [
      "removed field",
      (fn: FunctionData) => {
        Reflect.deleteProperty(fn, "audit");
      },
    ],
    [
      "nested value",
      (fn: FunctionData) => {
        (fn.audit as { nested: { value: number } }).nested.value = 2;
      },
    ],
  ] as const)("detects %s after repeated successful public audits", (_name, change) => {
    const p = pair();
    passes(p);
    passes(p);
    p.both(change);
    refuses(p);
  });
  it.each(["length", "hole", "extra", "order"])("preserves array %s observability", (change) => {
    const p = pair(() => Object.assign(new Array<unknown>(2), { 1: undefined, first: "a", second: "b" }));
    passes(p);
    p.both((fn) => {
      const value = fn.audit as unknown[] & { first: string; second: string; extra?: unknown };
      if (change === "length") value.length = 4;
      if (change === "hole") value[0] = undefined;
      if (change === "extra") value.extra = undefined;
      if (change === "order") {
        Reflect.deleteProperty(value, "first");
        value.first = "a";
      }
    });
    refuses(p);
  });
  it("preserves ordered escaped object keys", () => {
    const p = pair(() => ({ 'a"\\': 1, "b\ud800": 2 }));
    passes(p);
    p.both((fn) => {
      const value = fn.audit as Record<string, unknown>;
      Reflect.deleteProperty(value, 'a"\\');
      value['a"\\'] = 1;
    });
    refuses(p);
  });
  it.each(["byte", "object", "tag"])("preserves byte-array %s changes", (change) => {
    const p = pair(() => new Uint8Array([1, 255]));
    passes(p);
    p.both((fn) => {
      if (change === "byte") (fn.audit as Uint8Array)[1] = 254;
      if (change === "object") fn.audit = { 0: 1, 1: 255 };
      if (change === "tag") Object.setPrototypeOf(fn.audit, Object.prototype);
    });
    refuses(p);
  });
  it("preserves the old instanceof bytes tag instead of adding an internal-slot admission rule", () => {
    const p = pair(() => new Uint8Array([1, 255]));
    passes(p);
    p.both((fn) => {
      fn.audit = Object.assign(Object.create(Uint8Array.prototype), { 0: 1, 1: 255 });
    });
    passes(p);
  });
  it.each(["hidden", "symbol", "prototype"])("keeps %s differences ignored as before", (change) => {
    const p = pair();
    passes(p);
    p.both((fn) => {
      if (change === "hidden") Object.defineProperty(fn.audit, "hidden", { value: () => 1 });
      if (change === "symbol") Object.defineProperty(fn.audit, Symbol("hidden"), { value: Symbol("ignored") });
      if (change === "prototype") Object.setPrototypeOf(fn.audit, { inherited: () => 1 });
    });
    passes(p);
  });
  it("allows shared acyclic subtrees and equivalent replacement, then detects their mutation", () => {
    const p = pair(() => {
      const shared = { value: 1 };
      return { first: shared, second: shared };
    });
    passes(p);
    p.both((fn) => {
      (fn.audit as { second: unknown }).second = { value: 1 };
    });
    passes(p);
    p.both((fn) => {
      (fn.audit as { first: { value: number } }).first.value = 2;
    });
    refuses(p);
  });
  it.each(["function", "symbol", "cycle"])("matches original %s refusal during the single capture", (kind) => {
    const p = pair(() => {
      if (kind === "function") return { value: () => 1 };
      if (kind === "symbol") return { value: Symbol("bad") };
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    });
    expect(p.newCapture).toEqual(p.oldCapture);
    expect(p.newCapture).toEqual({
      ok: false,
      error:
        "physical module reservations: " +
        (kind === "cycle" ? "cyclic physical descriptor" : "unsupported physical descriptor value"),
    });
  });
  it.each(["function", "symbol", "cycle"])("walks later %s values after an earlier mismatch", (kind) => {
    const p = pair(() => ({ first: 1, later: { value: 2 } }));
    passes(p);
    p.both((fn) => {
      const value = fn.audit as Record<string, unknown>;
      value.first = 999;
      if (kind === "function") value.later = () => 1;
      if (kind === "symbol") value.later = Symbol("bad");
      if (kind === "cycle") value.later = value;
    });
    refuses(
      p,
      "physical module reservations: " +
        (kind === "cycle" ? "cyclic physical descriptor" : "unsupported physical descriptor value"),
    );
  });
});

describe("snapshot traversal keeps original observable evaluation order", () => {
  it("captures getter values exactly once and all siblings before their children", () => {
    const p = pair((events) => {
      const child = (name: string) =>
        Object.defineProperty({}, "leaf", {
          enumerable: true,
          get() {
            events.push(name + ".leaf");
            return 1;
          },
        });
      return Object.defineProperties(
        {},
        {
          first: {
            enumerable: true,
            get() {
              events.push("first");
              return child("first");
            },
          },
          second: {
            enumerable: true,
            get() {
              events.push("second");
              return child("second");
            },
          },
        },
      );
    });
    expect(p.newCapture).toEqual(p.oldCapture);
    expect(p.events.actual).toEqual(["first", "second", "first.leaf", "second.leaf"]);
    expect(p.events.actual).toEqual(p.events.original);
    for (let repeat = 0; repeat < 3; repeat++) {
      p.events.actual.length = 0;
      p.events.original.length = 0;
      passes(p);
      expect(p.events.actual).toEqual(["first", "second", "first.leaf", "second.leaf"]);
      expect(p.events.actual).toEqual(p.events.original);
    }
  });
  it("compares captured siblings even when an earlier child mutates their live fields", () => {
    const p = pair((events) => {
      const value = { first: {}, second: 2 };
      Object.defineProperty(value.first, "leaf", {
        enumerable: true,
        get() {
          events.push("mutate");
          value.second = 3;
          return 1;
        },
      });
      return value;
    });
    expect(p.newCapture).toEqual(p.oldCapture);
    p.both((fn) => {
      (fn.audit as { second: number }).second = 2;
    });
    p.events.actual.length = 0;
    p.events.original.length = 0;
    passes(p);
    expect((p.actual.audit as { second: number }).second).toBe(3);
    expect(p.events.actual).toEqual(["mutate"]);
    expect(p.events.actual).toEqual(p.events.original);
  });
  it.each(["extra-child", "different-kind"])("does not skip a later getter/error in %s", (mode) => {
    const p = pair(() => (mode === "different-kind" ? null : { first: 1 }));
    passes(p);
    for (const [fn, events] of [
      [p.actual, p.events.actual],
      [p.reference, p.events.original],
    ] as const) {
      const value = Object.defineProperties(
        {},
        {
          first: {
            enumerable: true,
            get() {
              events.push("first");
              return 2;
            },
          },
          last: {
            enumerable: true,
            get() {
              events.push("last");
              return Object.defineProperty({}, "fail", {
                enumerable: true,
                get() {
                  events.push("throw");
                  throw Error("later getter error");
                },
              });
            },
          },
        },
      );
      fn.audit = value;
    }
    refuses(p, "physical module reservations: later getter error");
    expect(p.events.actual).toEqual(["first", "last", "throw"]);
    expect(p.events.actual).toEqual(p.events.original);
  });
  it("preserves array length coercion before Object.entries and still walks fields after tag mismatch", () => {
    const controls: { length: string }[] = [];
    const p = pair((events) => {
      const state = { length: "1" };
      controls.push(state);
      return new Proxy([7], {
        get(target, key, receiver) {
          if (key === "length") {
            events.push("length");
            return {
              [Symbol.toPrimitive](hint: string) {
                events.push("coerce:" + hint);
                return state.length;
              },
            };
          }
          events.push("get:" + String(key));
          return Reflect.get(target, key, receiver);
        },
        ownKeys(target) {
          events.push("keys");
          return Reflect.ownKeys(target);
        },
      });
    });
    expect(p.newCapture).toEqual(p.oldCapture);
    expect(p.events.actual).toEqual(["length", "coerce:string", "keys", "get:0"]);
    expect(p.events.actual).toEqual(p.events.original);
    p.events.actual.length = 0;
    p.events.original.length = 0;
    for (const state of controls) state.length = "2";
    refuses(p);
    expect(p.events.actual).toEqual(["length", "coerce:string", "keys", "get:0"]);
    expect(p.events.actual).toEqual(p.events.original);
  });
  it.each(["length", "entries"])("keeps %s failures ahead of snapshot mismatch and wraps non-Error throws", (stage) => {
    const controls: { fail: boolean }[] = [];
    const p = pair((events) => {
      const state = { fail: false };
      controls.push(state);
      return new Proxy([7], {
        get(target, key, receiver) {
          if (key === "length") {
            events.push("length");
            if (state.fail && stage === "length") throw "length failure";
          }
          return Reflect.get(target, key, receiver);
        },
        ownKeys(target) {
          events.push("entries");
          if (state.fail && stage === "entries") throw 17;
          return Reflect.ownKeys(target);
        },
      });
    });
    passes(p);
    p.events.actual.length = 0;
    p.events.original.length = 0;
    for (const control of controls) control.fail = true;
    refuses(p, "physical module reservations: " + (stage === "length" ? "length failure" : "17"));
    expect(p.events.actual).toEqual(stage === "length" ? ["length"] : ["length", "entries"]);
    expect(p.events.actual).toEqual(p.events.original);
  });
  it.each(["locals", "body"])("retains the outer %s identity short circuit", (changed) => {
    const p = pair();
    passes(p);
    p.both((fn) => {
      fn[changed] = [];
      Object.defineProperty(fn, changed === "locals" ? "body" : "audit", {
        enumerable: true,
        get() {
          throw Error("must not read after identity mismatch");
        },
      });
    });
    refuses(p);
  });
});

describe("batch indices cannot escape a failed private ledger state", () => {
  it.each([false, true])("checks state again after a getter swallows an audit failure, shadowed=%s", (shadowed) => {
    const p = pair();
    passes(p);
    let swallowed = 0;
    Object.defineProperty(p.token.object, "name", {
      enumerable: true,
      get() {
        try {
          p.tx.reserveType("forbidden", { kind: "struct", name: "forbidden", fields: [] });
        } catch {
          swallowed++;
        }
        return "snapshotControl";
      },
    });
    if (shadowed) Object.defineProperty(p.tx, "state", { get: () => "filling" });
    expect(() => p.tx.physicalIndices([p.token])).toThrow(
      "physical module reservations: physical index requested in failed",
    );
    expect(swallowed).toBeGreaterThan(0);
    expect(p.tx.state).toBe(shadowed ? "filling" : "failed");
  });
});
