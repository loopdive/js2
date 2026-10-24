// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import type { Instr } from "../src/wasm/model/instructions.js";
import { PhysicalModuleReservations, type FunctionReservation } from "../src/wasm/physical/module-reservations.js";
import { requireCanonicalNativeFunctions } from "../src/backend/wasmgc/resources/native-resource-declarations.js";

function fixture(lateBody: Instr[] = [{ op: "nop" }]) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const functions = ["first", "later"].map((name) => tx.reserveFunction(name, name, { params: [], results: [] }));
  const global = tx.reserveGlobal("global", "global", { kind: "i32" }, false);
  tx.freezeReservations();
  tx.fillFunction(functions[0]!, { locals: [], body: [{ op: "nop" }] });
  tx.fillFunction(functions[1]!, { locals: [], body: lateBody });
  tx.fillGlobal(global, [{ op: "i32.const", value: 0 }]);
  const rows = functions.map((token) => ({ token, definition: { locals: [], body: [{ op: "nop" } as Instr] } }));
  return { module, tx, functions, global, rows };
}

it("validates independent canonical definitions before and after sealing", () => {
  const { tx, rows } = fixture();
  requireCanonicalNativeFunctions(tx, rows);
  tx.seal();
  requireCanonicalNativeFunctions(tx, rows);
});

it.each(["noncanonical", "copied", "foreign", "global"] as const)("rejects %s executable evidence", (kind) => {
  const { tx, rows, global } = fixture();
  if (kind === "noncanonical") rows[1]!.definition.body = [];
  else
    rows[1]!.token =
      kind === "copied"
        ? { ...rows[1]!.token }
        : kind === "foreign"
          ? fixture().functions[1]!
          : (global as unknown as FunctionReservation);
  expect(() => requireCanonicalNativeFunctions(tx, rows)).toThrow(
    kind === "noncanonical" ? /noncanonical/ : kind === "global" ? /requires a function/ : /foreign or forged/,
  );
});

it.each(["sparse", "row", "token", "definition", "instruction"] as const)(
  "rejects %s access without executing getters",
  (kind) => {
    const { tx, rows } = fixture();
    let reads = 0;
    const getter = {
      get() {
        reads++;
        return undefined;
      },
    };
    if (kind === "sparse") Reflect.deleteProperty(rows, 1);
    else if (kind === "row") Object.defineProperty(rows, 1, getter);
    else if (kind === "instruction") Object.defineProperty(rows[1]!.definition.body[0], "op", getter);
    else Object.defineProperty(rows[1], kind, getter);
    expect(() => requireCanonicalNativeFunctions(tx, rows)).toThrow(/non-data/);
    expect(reads).toBe(0);
  },
);

it("does not consult public row getters or iterators", () => {
  const { tx, rows } = fixture();
  let reads = 0;
  requireCanonicalNativeFunctions(
    tx,
    new Proxy(rows, {
      get(target, key, receiver) {
        reads++;
        return Reflect.get(target, key, receiver);
      },
    }),
  );
  expect(reads).toBe(0);
});

it("detects a ledger mutation during definition capture", () => {
  const { tx, rows, functions } = fixture();
  rows[1]!.definition = new Proxy(rows[1]!.definition, {
    ownKeys(target) {
      functions[0]!.object.body.push({ op: "nop" });
      return Reflect.ownKeys(target);
    },
  });
  expect(() => requireCanonicalNativeFunctions(tx, rows)).toThrow(/altered completed function first/);
});

it("copies earlier expected definitions before later capture can change them", () => {
  const { tx, rows } = fixture();
  rows[1]!.definition = new Proxy(rows[1]!.definition, {
    ownKeys(target) {
      rows[0]!.definition.body.push({ op: "nop" });
      return Reflect.ownKeys(target);
    },
  });
  requireCanonicalNativeFunctions(tx, rows);
  expect(rows[0]!.definition.body).toHaveLength(2);
  // A new call captures the changed expectation; no cached proof may survive.
  expect(() => requireCanonicalNativeFunctions(tx, rows)).toThrow(/noncanonical.*first/);
});

it("audits again when a later canonical comparison alters an earlier function", () => {
  let visit = 0,
    armed = false,
    mutated = false;
  const body = new Proxy<Instr[]>([{ op: "nop" }], {
    ownKeys(target) {
      if (armed && ++visit === 2) {
        first.object.body.push({ op: "nop" });
        mutated = true;
      }
      return Reflect.ownKeys(target);
    },
  });
  const { tx, rows, functions } = fixture(body);
  const first = functions[0]!;
  armed = true;
  expect(() => requireCanonicalNativeFunctions(tx, rows)).toThrow(/altered completed function first/);
  expect(mutated).toBe(true);
  expect(tx.state).toBe("failed");
});

it("authenticates forged tokens before reading their kind or object", () => {
  const { tx, rows } = fixture();
  let reads = 0;
  rows[0]!.token = new Proxy(rows[0]!.token, {
    get(target, key, receiver) {
      reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  expect(() => requireCanonicalNativeFunctions(tx, rows)).toThrow(/foreign or forged/);
  expect(reads).toBe(0);
});

it.each(["entry", "token", "instruction"] as const)(
  "rejects inherited descriptor values at %s capture without getters",
  (kind) => {
    const { tx, rows } = fixture();
    let reads = 0,
      failure: unknown;
    const fake = kind === "entry" ? rows[0] : kind === "token" ? rows[0]!.token : "nop";
    const accessor = {
      get() {
        reads++;
        return fake;
      },
    };
    if (kind === "entry") Object.defineProperty(rows, 0, accessor);
    else if (kind === "token") Object.defineProperty(rows[0], "token", accessor);
    else Object.defineProperty(rows[0]!.definition.body[0], "op", accessor);
    Object.defineProperty(Object.prototype, "value", {
      configurable: true,
      get() {
        reads++;
        return fake;
      },
    });
    try {
      requireCanonicalNativeFunctions(tx, rows);
    } catch (error) {
      failure = error;
    } finally {
      Reflect.deleteProperty(Object.prototype, "value");
    }
    expect(String(failure)).toMatch(/non-data/);
    expect(reads).toBe(0);
  },
);
