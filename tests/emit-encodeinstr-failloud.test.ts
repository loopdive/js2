// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1939 — the binary emitter's `encodeInstr` had NO default arm, so an op
// string with no matching case (the failure shape the ~170 `as unknown as
// Instr` casts invite) was **silently omitted from the binary** — surfacing,
// at best, as an opaque wasm validation error far downstream. `encodeValType`
// likewise silently encoded packed i8/i16 as i32 in a value position. This
// suite locks in the fail-loud behaviour and the no-silent-drop property that
// flushed three latent union members (`i32.trunc_f64_u`, `br_table`, `end`).
import { describe, it, expect } from "vitest";
import { WasmEncoder } from "../src/emit/encoder.js";
import { encodeInstr, encodeValType } from "../src/emit/binary.js";
import type { Instr, ValType } from "../src/ir/types.js";

function encodeOne(instr: Instr): Uint8Array {
  const enc = new WasmEncoder();
  encodeInstr(instr, enc);
  return enc.finish();
}

describe("encodeInstr fail-loud (#1939)", () => {
  it("throws on an unknown op instead of silently emitting nothing", () => {
    // The cast escape hatch that the union forbids: an op string with no case.
    const bogus = { op: "totally.not.a.real.op" } as unknown as Instr;
    expect(() => encodeOne(bogus)).toThrow(/unknown op/i);
  });

  it("throws on br_table (declared in the union but has no encodable payload)", () => {
    // `{ op: "br_table" }` carries no target table, so there is no correct
    // encoding — must fail loud rather than emit a truncated branch.
    expect(() => encodeOne({ op: "br_table" } as Instr)).toThrow(/br_table/);
  });

  it("encodes the three previously-dropped simple ops to ≥1 byte", () => {
    // These were union members with no encoder case (silent drops if emitted).
    expect(encodeOne({ op: "i32.trunc_f64_u" } as Instr)).toEqual(new Uint8Array([0xab]));
    expect(encodeOne({ op: "end" } as Instr)).toEqual(new Uint8Array([0x0b]));
  });

  it("no-silent-drop property: representative simple ops each encode to ≥1 byte", () => {
    // A spot-check that the common nullary numeric/ref/stack ops all produce
    // output. The exhaustiveness `never` check in encodeInstr already enforces
    // this at compile time for the whole union; this is the runtime backstop.
    const simpleOps: Instr[] = [
      { op: "i32.add" },
      { op: "i32.sub" },
      { op: "i32.eqz" },
      { op: "i32.and" },
      { op: "i32.or" },
      { op: "f64.add" },
      { op: "f64.ne" },
      { op: "f64.eq" },
      { op: "f64.neg" },
      { op: "i32.trunc_f64_s" },
      { op: "i32.trunc_f64_u" },
      { op: "f64.convert_i32_s" },
      { op: "i32.wrap_i64" },
      { op: "drop" },
      { op: "return" },
      { op: "end" },
      { op: "unreachable" },
      { op: "nop" },
    ];
    for (const op of simpleOps) {
      const bytes = encodeOne(op);
      expect(bytes.length, `op "${op.op}" must encode to ≥1 byte`).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("encodeValType fail-loud on packed types in value position (#1939)", () => {
  it("throws when i8 leaks into a value position", () => {
    const enc = new WasmEncoder();
    expect(() => encodeValType({ kind: "i8" } as ValType, enc)).toThrow(/packed storage type/i);
  });

  it("throws when i16 leaks into a value position", () => {
    const enc = new WasmEncoder();
    expect(() => encodeValType({ kind: "i16" } as ValType, enc)).toThrow(/packed storage type/i);
  });

  it("still encodes ordinary value types (i32/f64) without throwing", () => {
    const enc = new WasmEncoder();
    expect(() => encodeValType({ kind: "i32" }, enc)).not.toThrow();
    expect(() => encodeValType({ kind: "f64" }, enc)).not.toThrow();
    expect(enc.finish().length).toBeGreaterThanOrEqual(2);
  });
});
