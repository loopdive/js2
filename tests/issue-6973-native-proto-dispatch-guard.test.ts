// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6973 stage 2) `__call_fn_method_N` tests the #3992 transferred
// native-prototype receiver arms behind ONE outer `ref.test`: the arms' types
// are distinct IR indices of a single shape, which canonicalize to one Wasm
// type, so a closure that fails the outer test fails every arm. An ordinary
// method closure used to pay one type test per native member before reaching
// its own dispatch. This pins both sides of the guard in one module: several
// transferred native members (which enter it) and ordinary user methods
// dispatched through the same `__call_fn_method_N` (which skip it). Expected
// values are Node's.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SRC = `
function Box(v) { this.v = v; }
Box.prototype.get = function () { return this.v; };
Box.prototype.add = function (n) { return this.v + n; };
export function f(): number {
  var o: any = new Object(true);
  o.toLowerCase = String.prototype.toLowerCase;
  o.charAt = String.prototype.charAt;
  o.indexOf = String.prototype.indexOf;
  o.slice = String.prototype.slice;
  var r = 0;
  if (o.indexOf("u") === 2) r += 100;
  if (o.slice(1, 3) === "ru") r += 1000;
  var items: any[] = [new Box(4), new Box(5)];
  var s = 0;
  for (var i = 0; i < items.length; i++) s += items[i].get() + items[i].add(1);
  return r + s * 10000;
}
`;

describe("#6973 stage 2 — native-proto receiver arms behind one guard", () => {
  it("dispatches transferred native members and ordinary methods as Node does", async () => {
    const result = await compile(SRC, { target: "standalone" });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { f: () => number }).f()).toBe(201100);
  });
});
