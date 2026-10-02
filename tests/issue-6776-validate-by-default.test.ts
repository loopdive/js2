// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6776 — compile() validates the emitted module by default.
//
// `success: true` used to mean "codegen ran to completion", not "the engine
// accepts these bytes". A type-confused lowering therefore shipped as a green
// compile, and only `WebAssembly.instantiate` noticed. The gate now runs on
// every compile (the shared pipeline exit, `finalizePipelineModule`, which
// compile / compileMulti / compileFiles all return through): an engine
// rejection becomes `success: false` plus an `invalid-module` error carrying
// the engine's message. `validate: false` is the explicit opt-out.
import { afterEach, describe, expect, it, vi } from "vitest";

import { compile, compileMulti, validateEmittedBinary, type CompileError } from "../src/index.js";

// The test hook: when armed, the emitter receives a module with ONE bad
// instruction (a `drop` on an empty operand stack) at the top of the first
// exported function. Injected at emit time so it cannot be fixed by a codegen
// change — unlike the two probes below, it stays invalid forever.
const hook = vi.hoisted(() => ({ armed: false }));

vi.mock("../src/emit/binary.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/emit/binary.js")>();
  return {
    ...actual,
    emitBinary(...args: Parameters<typeof actual.emitBinary>) {
      const [mod] = args;
      if (hook.armed) {
        const target = mod.functions.find((fn) => fn.exported) ?? mod.functions[0];
        target?.body.unshift({ op: "drop" });
      }
      return actual.emitBinary(...args);
    },
  };
});

afterEach(() => {
  hook.armed = false;
  vi.unstubAllGlobals();
});

const GOOD = `export function add(a: number, b: number): number { return a + b; }`;

// The two review probes. Their lowerings are bugs owned by #6777 (`in` on an
// array carrier) and #6778 (linear mixed-operand `+`).
const PROBES = [
  {
    lane: "WasmGC",
    source: `export function run(){ const arr: any[] = [1,2,3]; arr[5] = 9; return JSON.stringify([2 in arr]); }`,
    options: {},
  },
  {
    lane: "linear",
    source: `export function f(): number { const s = "1" + 2; return s.length; }`,
    options: { target: "linear" as const },
  },
];

const invalidModuleErrors = (errors: CompileError[]) => errors.filter((e) => e.code === "invalid-module");

describe("#6776 — an engine-rejected binary is a compile failure", () => {
  it("a deliberately corrupted body fails the compile instead of throwing at instantiate", async () => {
    hook.armed = true;
    const result = await compile(GOOD);
    expect(result.success).toBe(false);
    const [error, ...rest] = invalidModuleErrors(result.errors);
    expect(rest).toEqual([]);
    expect(error?.severity).toBe("error");
    // The engine's own complaint is carried, naming the injected instruction.
    expect(error?.message).toMatch(/drop/);
    // The bytes are still handed back for dumping/diffing.
    expect(result.binary.length).toBeGreaterThan(0);
    expect(WebAssembly.validate(result.binary)).toBe(false);
  });

  it("compileMulti goes through the same gate", async () => {
    hook.armed = true;
    const result = await compileMulti({ "./main.ts": GOOD }, "./main.ts");
    expect(result.success).toBe(false);
    expect(invalidModuleErrors(result.errors)).toHaveLength(1);
  });

  it("validate: false restores the old behaviour (success, and the engine throws later)", async () => {
    hook.armed = true;
    const result = await compile(GOOD, { validate: false });
    expect(result.success).toBe(true);
    expect(invalidModuleErrors(result.errors)).toEqual([]);
    expect(() => new WebAssembly.Module(result.binary as BufferSource)).toThrow(WebAssembly.CompileError);
  });

  // While #6777 / #6778 are open, both probes emit bytes the engine rejects and
  // must fail the compile. Once a fix lands the probe's binary validates, and
  // the gate must then stay out of the way. Either way the compile verdict has
  // to agree with the engine — which is the whole contract of this issue.
  for (const probe of PROBES) {
    it(`${probe.lane} review probe: the compile verdict agrees with the engine`, async () => {
      const ungated = await compile(probe.source, { ...probe.options, validate: false });
      expect(ungated.success, ungated.errors.map((e) => e.message).join("\n")).toBe(true);
      const engine = validateEmittedBinary(ungated.binary);

      const gated = await compile(probe.source, probe.options);
      expect(gated.success).toBe(engine.valid);
      if (engine.valid) {
        expect(invalidModuleErrors(gated.errors)).toEqual([]);
        return;
      }
      const [error] = invalidModuleErrors(gated.errors);
      expect(error?.severity).toBe("error");
      expect(engine.detail).toBeTruthy();
      expect(error?.message).toContain(engine.detail!);
    });
  }

  it("a known-good program compiles with no invalid-module entry", async () => {
    const result = await compile(GOOD);
    expect(result.success).toBe(true);
    expect(invalidModuleErrors(result.errors)).toEqual([]);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("a host without a WebAssembly global gets a validation-skipped warning, not silence", async () => {
    vi.stubGlobal("WebAssembly", undefined);
    const result = await compile(GOOD);
    vi.unstubAllGlobals();
    expect(result.success).toBe(true);
    const skipped = result.errors.filter((e) => e.code === "validation-skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.severity).toBe("warning");
  });
});
