// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { emitBinary } from "../src/emit/binary.js";
import { emitWat } from "../src/emit/wat.js";
import type { Instr } from "../src/wasm/model/instructions.js";

function setup() {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const token = tx.reserveFunction("main", "main", { params: [], results: [{ kind: "i32" }] });
  tx.freezeReservations();
  return { module, tx, token };
}
function definition() {
  const payload: Instr[] = [{ op: "i32.const", value: 7 }];
  return {
    locals: [],
    body: [{ op: "block", blockType: { kind: "val", type: { kind: "i32" } }, body: payload }] as Instr[],
    payload,
  };
}
function fixture(owned: boolean) {
  const f = setup(),
    d = definition();
  if (owned) f.tx.fillOwnedFunction(f.token, d);
  else f.tx.fillFunction(f.token, d);
  f.tx.defineExport("main:export", "main", f.token);
  f.tx.seal();
  return { ...f, d };
}
function result(bytes: ReturnType<typeof emitBinary>) {
  return (new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes))).exports.main as () => number)();
}
describe.sequential("owned function admission", () => {
  it("matches exact binary/WAT and executes real Wasm", () => {
    const a = fixture(false),
      b = fixture(true);
    expect(emitBinary(b.module)).toEqual(emitBinary(a.module));
    expect(emitWat(b.module)).toBe(emitWat(a.module));
    expect(result(emitBinary(b.module))).toBe(7);
  });
  it("detaches caller aliases without freezing caller data", () => {
    const f = fixture(true),
      before = emitBinary(f.module);
    (f.d.payload[0] as { value: number }).value = 99;
    f.d.body.push({ op: "nop" });
    expect(Object.isFrozen(f.d.body)).toBe(false);
    f.tx.assertCompletedReservation(f.token);
    expect(emitBinary(f.module)).toEqual(before);
    expect(result(emitBinary(f.module))).toBe(7);
  });
  it("leaves legacy fill live and rejects its later mutation", () => {
    const f = fixture(false);
    (f.d.payload[0] as { value: number }).value = 99;
    expect(() => f.tx.assertCompletedReservation(f.token)).toThrow(/altered completed function/);
  });
  it("protects own publication fields and nested instruction data", () => {
    const f = fixture(true);
    expect(() => Object.defineProperty(f.token.object, "body", { value: [] })).toThrow();
    expect(() => Object.defineProperty(f.token.object.body[0], "body", { value: [] })).toThrow();
    expect(Object.getPrototypeOf(f.token.object.body[0])).toBe(null);
  });
  it("retains live function-shell checking", () => {
    const f = fixture(true);
    (f.token.object as any).additional = "changed";
    expect(() => f.tx.assertCompletedReservation(f.token)).toThrow(/altered completed function/);
  });
  it("retains live mutable module population checking", () => {
    const f = fixture(true);
    f.module.functions.push(f.token.object);
    expect(() => f.tx.assertCompletedReservation(f.token)).toThrow(/population/);
  });
  it("resists ArrayIteratorPrototype.next substitution in real binary output", () => {
    const f = fixture(true),
      child = (f.token.object.body[0] as any).body[0];
    const proto = Object.getPrototypeOf([][Symbol.iterator]()),
      old = Object.getOwnPropertyDescriptor(proto, "next")!;
    let bytes: ReturnType<typeof emitBinary>;
    try {
      Object.defineProperty(proto, "next", {
        ...old,
        value: function () {
          const s = Reflect.apply(old.value, this, []) as IteratorResult<unknown>;
          return s.value === child ? { done: false, value: { op: "i32.const", value: 99 } } : s;
        },
      });
      bytes = emitBinary(f.module);
    } finally {
      Object.defineProperty(proto, "next", old);
    }
    expect(result(bytes!)).toBe(7);
  });
  it("records remaining ambient join sensitivity in emitter-created WAT arrays", () => {
    const f = fixture(true),
      child = (f.token.object.body[0] as any).body,
      before = emitWat(f.module);
    const old = Object.getOwnPropertyDescriptor(Array.prototype, "map")!,
      join = Object.getOwnPropertyDescriptor(Array.prototype, "join")!;
    let wat: string;
    try {
      Object.defineProperty(Array.prototype, "map", {
        ...old,
        value: function (cb: any, recv: any) {
          return Reflect.apply(old.value, this === child ? [{ op: "i32.const", value: 99 }] : this, [cb, recv]);
        },
      });
      Object.defineProperty(Array.prototype, "join", {
        ...join,
        value: function (sep: any) {
          return this.some((x: any) => typeof x === "string" && x.includes("i32.const 7"))
            ? "corrupt"
            : Reflect.apply(join.value, this, [sep]);
        },
      });
      wat = emitWat(f.module);
    } finally {
      Object.defineProperty(Array.prototype, "map", old);
      Object.defineProperty(Array.prototype, "join", join);
    }
    expect(wat!).not.toBe(before);
    expect(wat!).toContain("corrupt");
  });
  it("protects map results derived directly from the private nested body", () => {
    const f = fixture(true),
      before = emitWat(f.module),
      old = Object.getOwnPropertyDescriptor(Array.prototype, "join")!;
    let wat: string;
    try {
      Object.defineProperty(Array.prototype, "join", {
        ...old,
        value: function (sep: any) {
          return this.length === 1 && typeof this[0] === "string" && this[0].trim() === "i32.const 7"
            ? "corrupt"
            : Reflect.apply(old.value, this, [sep]);
        },
      });
      wat = emitWat(f.module);
    } finally {
      Object.defineProperty(Array.prototype, "join", old);
    }
    expect(wat!).toBe(before);
  });
  it("retains mixed legacy/owned function mutation detection", () => {
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const a = tx.reserveFunction("a", "a", { params: [], results: [] }),
      b = tx.reserveFunction("b", "b", { params: [], results: [] });
    tx.freezeReservations();
    tx.fillOwnedFunction(a, { locals: [], body: [] });
    const body: Instr[] = [{ op: "nop" }];
    tx.fillFunction(b, { locals: [], body });
    tx.assertCompletedReservation(a);
    tx.assertCompletedReservation(b);
    body.push({ op: "nop" });
    expect(() => tx.assertCompletedReservation(a)).toThrow(/altered completed function b/);
  });
  it.each([-0, NaN])("preserves floating-point binary and WAT payload %s", (value) => {
    const build = (owned: boolean) => {
      const module = createEmptyModule(),
        tx = new PhysicalModuleReservations(module);
      const token = tx.reserveFunction("f", "f", { params: [], results: [{ kind: "f64" }] });
      tx.freezeReservations();
      const d = {
        locals: [],
        body: [{ op: "f64.const", value, sourcePos: { file: "owned-fixture.ts", line: 2, column: 3 } }] as Instr[],
      };
      if (owned) tx.fillOwnedFunction(token, d);
      else tx.fillFunction(token, d);
      tx.defineExport("export", "f", token);
      tx.seal();
      return module;
    };
    const a = build(false),
      b = build(true);
    expect(emitBinary(b)).toEqual(emitBinary(a));
    expect(emitWat(b)).toBe(emitWat(a));
    const f = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(emitBinary(b)))).exports
      .f as () => number;
    expect(Object.is(f(), value)).toBe(true);
  });
  it("copies byte payloads but retains full live audit for mutable copies", () => {
    const f = setup(),
      bytes = new Uint8Array(16);
    f.tx.fillOwnedFunction(f.token, {
      locals: [],
      body: [{ op: "v128.const", bytes }, { op: "drop" }, { op: "i32.const", value: 7 }],
    });
    const copied = (f.token.object.body[0] as any).bytes;
    expect(copied).not.toBe(bytes);
    bytes[0] = 99;
    f.tx.assertCompletedReservation(f.token);
    copied[0] = 42;
    expect(() => f.tx.assertCompletedReservation(f.token)).toThrow(/altered completed function/);
  });
  it("blocks hidden byte callbacks that alter Wasm and restore indexed contents", () => {
    const f = setup();
    f.tx.fillOwnedFunction(f.token, {
      locals: [],
      body: [
        { op: "v128.const", bytes: new Uint8Array(16) },
        { op: "i32x4.extract_lane", lane: 0 },
      ],
    });
    f.tx.defineExport("main:export", "main", f.token);
    f.tx.seal();
    const bytes = (f.token.object.body[0] as Extract<Instr, { op: "v128.const" }>).bytes;
    const binary = emitBinary(f.module),
      wat = emitWat(f.module);
    let reads = 0;
    expect(() =>
      Object.defineProperty(bytes, "length", {
        get() {
          bytes[0] = ++reads === 3 ? 0 : 99;
          return 16;
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      Object.defineProperty(bytes, Symbol.iterator, {
        value: function* () {
          for (let i = 0; i < 16; i++) yield 99;
        },
      }),
    ).toThrow(TypeError);
    expect(() => Object.setPrototypeOf(bytes, {})).toThrow(TypeError);
    expect(reads).toBe(0);
    f.tx.assertCompletedReservation(f.token);
    expect(emitBinary(f.module)).toEqual(binary);
    expect(emitWat(f.module)).toBe(wat);
    expect(result(emitBinary(f.module))).toBe(0);
    f.tx.assertCompletedReservation(f.token);
  });
  it("keeps byte length and iteration independent of mutable inherited methods", () => {
    const f = setup();
    f.tx.fillOwnedFunction(f.token, {
      locals: [],
      body: [
        { op: "v128.const", bytes: new Uint8Array(16) },
        { op: "i32x4.extract_lane", lane: 0 },
      ],
    });
    f.tx.defineExport("main:export", "main", f.token);
    f.tx.seal();
    const bytes = (f.token.object.body[0] as Extract<Instr, { op: "v128.const" }>).bytes;
    const proto = Object.getPrototypeOf(Uint8Array.prototype);
    const length = Object.getOwnPropertyDescriptor(proto, "length")!;
    const iterator = Object.getOwnPropertyDescriptor(proto, Symbol.iterator)!;
    let lengthReads = 0,
      iteratorReads = 0;
    let values: number[], size: number;
    try {
      Object.defineProperty(proto, "length", {
        ...length,
        get() {
          lengthReads++;
          return 99;
        },
      });
      Object.defineProperty(proto, Symbol.iterator, {
        ...iterator,
        value: function* () {
          iteratorReads++;
          yield 99;
        },
      });
      size = bytes.length;
      values = Array.from(bytes);
    } finally {
      Object.defineProperty(proto, "length", length);
      Object.defineProperty(proto, Symbol.iterator, iterator);
    }
    expect(size!).toBe(16);
    expect(values!).toEqual(Array(16).fill(0));
    expect(lengthReads).toBe(0);
    expect(iteratorReads).toBe(0);
    f.tx.assertCompletedReservation(f.token);
    expect(result(emitBinary(f.module))).toBe(0);
  });
  it("preserves shared DAG references privately", () => {
    const f = setup(),
      shared: Instr = { op: "nop" };
    f.tx.fillOwnedFunction(f.token, { locals: [], body: [shared, shared, { op: "i32.const", value: 7 }] });
    expect(f.token.object.body[0]).toBe(f.token.object.body[1]);
    expect(f.token.object.body[0]).not.toBe(shared);
    (shared as any).op = "unreachable";
    f.tx.assertCompletedReservation(f.token);
  });
  it("copies a byte subview without retaining its backing storage", () => {
    const f = setup(),
      storage = new Uint8Array(32);
    storage[8] = 7;
    const bytes = storage.subarray(8, 24);
    f.tx.fillOwnedFunction(f.token, {
      locals: [],
      body: [{ op: "v128.const", bytes }, { op: "drop" }, { op: "i32.const", value: 7 }],
    });
    const copy = (f.token.object.body[0] as any).bytes;
    expect(copy.length).toBe(16);
    expect(copy[0]).toBe(7);
    expect(copy.buffer).not.toBe(storage.buffer);
    storage[8] = 99;
    expect(copy[0]).toBe(7);
    f.tx.assertCompletedReservation(f.token);
  });
  it("rejects extra byte-view metadata rather than silently losing it", () => {
    const f = setup(),
      bytes = new Uint8Array(16);
    (bytes as any).extra = { meaning: "retain" };
    expect(() =>
      f.tx.fillOwnedFunction(f.token, {
        locals: [],
        body: [{ op: "v128.const", bytes }, { op: "drop" }, { op: "i32.const", value: 7 }],
      }),
    ).toThrow(/only indexed data/);
    expect(f.tx.state).toBe("failed");
  });
  it("protects entries-derived pair lookup without changing nested values", () => {
    const f = fixture(true),
      body = f.token.object.body;
    const pair = body.entries().next().value!;
    expect(Object.getPrototypeOf(pair)).toBe(Object.getPrototypeOf(body));
    expect(pair[0]).toBe(0);
    expect(pair[1]).toBe(body[0]);
    expect(body.values().next().value).toBe(body[0]);
  });
  it("reports a ledger validation failure with a single prefix", () => {
    const f = setup();
    expect(() =>
      f.tx.fillOwnedFunction(f.token, { locals: [], body: [{ op: "call", funcIdx: 999 }] as Instr[] }),
    ).toThrow(/^physical module reservations: (?!physical module reservations:)/);
    expect(f.tx.state).toBe("failed");
  });
  it.each(["accessor", "cycle", "hole", "symbol", "extra-index"])("rejects unsupported input: %s", (kind) => {
    const f = setup(),
      d = definition();
    if (kind === "accessor")
      Object.defineProperty(d.payload[0], "value", {
        get() {
          throw Error("getter must not run");
        },
        enumerable: true,
      });
    if (kind === "cycle") (d.payload[0] as any).cycle = d.body;
    if (kind === "hole") expect(Reflect.deleteProperty(d.payload, "0")).toBe(true);
    if (kind === "symbol") (d.payload[0] as any)[Symbol("x")] = 1;
    if (kind === "extra-index") (d.payload as any).other = 1;
    expect(() => f.tx.fillOwnedFunction(f.token, d)).toThrow(/owned function data/);
    expect(f.tx.state).toBe("failed");
  });
  it("reauthenticates after copy proxy callbacks change the function header", () => {
    const f = setup(),
      d = definition();
    d.body[0] = new Proxy(d.body[0]!, {
      ownKeys(target) {
        f.token.object.name = "changed";
        return Reflect.ownKeys(target);
      },
    });
    expect(() => f.tx.fillOwnedFunction(f.token, d)).toThrow(/altered function descriptor/);
    expect(f.tx.state).toBe("failed");
  });
  it("rejects reentrant fill through copy proxy callbacks", () => {
    const f = setup(),
      d = definition();
    let once = false;
    d.body[0] = new Proxy(d.body[0]!, {
      ownKeys(target) {
        if (!once) {
          once = true;
          f.tx.fillFunction(f.token, { locals: [], body: [{ op: "i32.const", value: 99 }] });
        }
        return Reflect.ownKeys(target);
      },
    });
    expect(() => f.tx.fillOwnedFunction(f.token, d)).toThrow(/duplicate function fill/);
    expect(f.tx.state).toBe("failed");
  });
  it("rejects phase changes during copy callbacks", () => {
    const f = setup(),
      d = definition();
    let once = false;
    d.body[0] = new Proxy(d.body[0]!, {
      ownKeys(target) {
        if (!once) {
          once = true;
          f.tx.fillFunction(f.token, { locals: [], body: [{ op: "i32.const", value: 99 }] });
          f.tx.seal();
        }
        return Reflect.ownKeys(target);
      },
    });
    expect(() => f.tx.fillOwnedFunction(f.token, d)).toThrow(/requires filling, observed sealed/);
    expect(f.tx.state).toBe("failed");
  });
  it("closing audit rejects shell corruption after the publication snapshot", () => {
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const main = tx.reserveFunction("main", "main", { params: [], results: [] });
    const prior = tx.reserveFunction("prior", "prior", { params: [], results: [] });
    let changed = false;
    Object.defineProperty(prior.object, "metadata", {
      enumerable: true,
      get() {
        if (!changed && Object.getOwnPropertyDescriptor(main.object, "body")?.writable === false) {
          changed = true;
          (main.object as any).additional = "late corruption";
        }
        return "stable";
      },
    });
    tx.freezeReservations();
    tx.fillFunction(prior, { locals: [], body: [] });
    expect(() => tx.fillOwnedFunction(main, { locals: [], body: [] })).toThrow(/altered completed function main/);
    expect(changed).toBe(true);
    expect(tx.state).toBe("failed");
  });

  it.each([false, true])("does not rewrite reduce accumulator arrays frozen=%s", (frozen) => {
    const f = fixture(true),
      external: any[] = [];
    if (frozen) Object.freeze(external);
    const prototype = Object.getPrototypeOf(external);
    expect(f.token.object.body.reduce(() => external, external)).toBe(external);
    expect(f.token.object.body.reduceRight(() => external, external)).toBe(external);
    expect(Object.getPrototypeOf(external)).toBe(prototype);
  });
  it("does not rewrite a borrowed map method's custom species result", () => {
    const f = fixture(true),
      external: any[] = [],
      receiver: any[] = [7];
    Object.defineProperty(receiver, "constructor", {
      value: {
        // biome-ignore lint/complexity/useArrowFunction: ArraySpeciesCreate requires a constructable function.
        [Symbol.species]: function () {
          return external;
        },
      },
    });
    const prototype = Object.getPrototypeOf(external);
    expect(Reflect.apply(f.token.object.body.map, receiver, [(x: any) => x])).toBe(external);
    expect(Object.getPrototypeOf(external)).toBe(prototype);
    expect(external).toEqual([7]);
  });
});
