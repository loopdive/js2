// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3029-S1/S4 + #3030-T1 — backend-contract + IR-interchange freeze smoke.
//
// The COMPILE-TIME conformance proof lives in
// src/ir/backend/contract-conformance.ts (tsc-checked via `pnpm run
// typecheck`; vitest does not typecheck). This file exercises the runtime
// behaviors the freeze pins down:
//   - the stub ModuleAssembler's index-identity protocol (invariants A1–A5),
//     including the headline property: a LATE IMPORT never invalidates a
//     handle minted earlier (the #2078 / __gen_eager_mode bug class is
//     unrepresentable through the contract);
//   - legalityFor() as the contract form of the legality checker;
//   - the IR interchange surface (IR_FORMAT_VERSION, schema file validity).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StubModuleAssembler, emittersConform, makeStubBackend } from "../src/ir/backend/contract-conformance.js";
import { legalityFor } from "../src/ir/backend/contract.js";
import { IR_FORMAT_VERSION } from "../src/ir/contract.js";
import type { TypeHandle } from "../src/ir/types.js";

const TYPE_H = 0 as TypeHandle;

describe("ModuleAssembler index identity (#3029-S4 invariants)", () => {
  it("A3/A5 — a late import never invalidates an earlier handle", () => {
    const asm = new StubModuleAssembler();
    // Producer mints a handle and "bakes" it (e.g. into a call immediate)
    // long before the import exists — the historical bug setup.
    const fMain = asm.declareFunc("main");
    asm.defineFunc(fMain, "body:main");
    // LATE import — under eager index binding this shifted every defined
    // function index (+1) and required a body-walking fixup pass.
    const fImp = asm.importFunc("env", "late_helper", TYPE_H, "late_helper");
    const layout = asm.finalize();
    // Imports occupy the front of the index space; the handle minted BEFORE
    // the import still resolves correctly with zero fixup.
    expect(layout.func(fImp)).toBe(0);
    expect(layout.func(fMain)).toBe(1);
  });

  it("A2 — declare/define is two-phase and exactly-once", () => {
    const asm = new StubModuleAssembler();
    const h = asm.declareFunc("f");
    // Nested emission between mint and define is legal.
    const inner = asm.declareFunc("g");
    asm.defineFunc(inner, "body:g");
    asm.defineFunc(h, "body:f");
    expect(() => asm.defineFunc(h, "body:f2")).toThrow(/double define/);
    // Declared-but-never-defined fails loudly at finalize.
    const asm2 = new StubModuleAssembler();
    asm2.declareFunc("never-defined");
    expect(() => asm2.finalize()).toThrow(/never defined/);
  });

  it("A4 — finalize is single-shot and freezes mutation", () => {
    const asm = new StubModuleAssembler();
    const h = asm.declareFunc("f");
    asm.defineFunc(h, "body");
    asm.finalize();
    expect(() => asm.finalize()).toThrow(/twice/);
    expect(() => asm.declareFunc("late")).toThrow(/after finalize/);
    expect(() => asm.importFunc("env", "x", TYPE_H, "x")).toThrow(/after finalize/);
  });

  it("A6 — name lookup returns handles, and globals/types mirror the protocol", () => {
    const asm = new StubModuleAssembler();
    const g = asm.declareGlobal("counter");
    asm.defineGlobal(g, "global:counter");
    const gImp = asm.importGlobal("env", "str0", { kind: "externref" }, false, "str0");
    expect(asm.lookupGlobal("counter")).toBe(g);
    const t1 = asm.internType("struct{a}", "$A");
    const t2 = asm.internType("struct{a}");
    expect(t2).toBe(t1); // structural dedup
    expect(asm.lookupType("$A")).toBe(t1);
    const layout = asm.finalize();
    expect(layout.global(gImp)).toBe(0); // imports first
    expect(layout.global(g)).toBe(1);
  });
});

describe("five-part contract surface (#3029-S1)", () => {
  it("compile-time emitter conformance is banked", () => {
    expect(emittersConform).toBe(true);
  });

  it("the stub backend assembles all five parts and its emitter drives a foreign sink", () => {
    const backend = makeStubBackend();
    expect(backend.types.convertType({ kind: "string" })).toEqual(["slot:string"]);
    const out = backend.emitter.newSink();
    backend.emitter.emitBinary("f64.add", out);
    const inner = backend.emitter.newSink();
    backend.emitter.emitUnary("f64.neg", inner);
    backend.emitter.emitBlock({ kind: "empty" }, inner, out);
    expect(out).toEqual(["binary:f64.add", "block", "unary:f64.neg", "end"]);
  });

  it("legalityFor wraps the production legality checker per backend", () => {
    for (const kind of ["wasmgc", "linear", "bytecode", "porffor"] as const) {
      const legality = legalityFor(kind);
      expect(legality.backend).toBe(kind);
      expect(typeof legality.checkFunction).toBe("function");
    }
  });
});

describe("IR interchange contract surface (#3030-T1)", () => {
  it("exports the frozen format version", () => {
    expect(IR_FORMAT_VERSION).toBe("5.1");
    expect(IR_FORMAT_VERSION).toMatch(/^\d+\.\d+$/);
  });

  it("ships a parseable JSON Schema whose frozen tables match the contract", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const schema = JSON.parse(readFileSync(join(here, "../docs/ir/ir-module.schema.json"), "utf-8"));
    expect(schema.$schema).toContain("2020-12");
    expect(schema.required).toEqual(["irVersion", "coverage", "functions"]);
    const kinds: string[] = schema.$defs.instrKind.enum;
    // D4: raw.wasm is never serialized.
    expect(kinds).not.toContain("raw.wasm");
    // Spot-check the dynamic-boundary trio (D3.4 — the AOT payload).
    expect(kinds).toContain("box");
    expect(kinds).toContain("unbox");
    expect(kinds).toContain("tag.test");
    // D5: the scalar set is closed and index-free.
    const scalars: string[] = schema.$defs.scalarValKind.enum;
    expect(scalars).toContain("externref");
    expect(scalars).not.toContain("ref");
    expect(scalars).not.toContain("ref_null");
    expect(schema.$defs.function.required).toContain("unitId");
    expect(schema.$defs.coverageEntry.required).toContain("unitId");
    expect(schema.$defs.classShape.required).toContain("classId");
    expect(schema.$defs.funcRef.required).toContain("binding");
    expect(
      schema.$defs.callableBinding.oneOf.map(
        (variant: { properties: { kind: { const: string } } }) => variant.properties.kind.const,
      ),
    ).toEqual(["unit", "import", "runtime", "intrinsic", "support"]);
  });
});
