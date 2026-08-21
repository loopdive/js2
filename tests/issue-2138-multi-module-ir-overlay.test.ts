// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2138 M0 — bounded multi-module IR overlay. Multi-source WasmGC compiles
// legacy bodies first, then lets IR replace only unambiguous top-level function
// slots. #3214 A+B1 additionally admits checker-certified host imported direct
// calls (including exact bare top-level callbacks). Class members, module init,
// and IR-first body skipping remain legacy-owned.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileFiles, compileMulti, compileProject, type CompileResult } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const MULTI_FILES = {
  "./dep.ts": `
    export function depPure(x: number): number {
      return x * 3;
    }
  `,
  "./entry.ts": `
    import { depPure as renamedPure } from "./dep";

    let initialized: number = 40;

    function initHelper(x: number): number {
      return x + 2;
    }

    initialized = initHelper(initialized);

    export function entryPure(x: number): number {
      return x + 4;
    }

    export function callRenamed(x: number): number {
      return renamedPure(x);
    }

    export function readInit(): number {
      return initialized;
    }
  `,
} as const;

function expectSuccess(result: CompileResult, label: string): void {
  expect(
    result.success,
    `${label} failed:\n${result.errors.map((error) => `${error.severity}: ${error.message}`).join("\n")}`,
  ).toBe(true);
}

async function instantiate(result: CompileResult): Promise<Record<string, (...args: number[]) => number>> {
  const instance = await instantiateWithRuntime(result);
  return instance.exports as unknown as Record<string, (...args: number[]) => number>;
}

describe("#2138 M0 — multi-module top-level IR overlay", () => {
  it("IR-emits pure functions and certified imported calls while module init stays legacy", async () => {
    const ir = await compileMulti(MULTI_FILES, "./entry.ts", { experimentalIR: true });
    const legacy = await compileMulti(MULTI_FILES, "./entry.ts", { experimentalIR: false });
    expectSuccess(ir, "IR multi compile");
    expectSuccess(legacy, "legacy multi compile");

    const compiled = new Set(ir.irCompiledFuncs ?? []);
    // Anti-vacuity: one independent pure function from EACH source file really
    // had its existing slot patched by the IR integration pass.
    expect(compiled.has("depPure")).toBe(true);
    expect(compiled.has("entryPure")).toBe(true);

    // #3214 A+B1: the checker-certified renamed import is now a symbolic IR
    // call to the existing legacy/IR target slot. Module state/init stay legacy.
    expect(compiled.has("callRenamed")).toBe(true);
    expect(compiled.has("readInit")).toBe(false);
    expect(compiled.has("initHelper")).toBe(false);
    expect(compiled.has("<module-init>")).toBe(false);
    expect(ir.irFirstSkipped).toBeUndefined();
    expect(ir.irPostClaimErrors ?? []).toEqual([]);

    // `experimentalIR: false` remains an exact opt-out for every multi entry.
    expect(legacy.irCompiledFuncs ?? []).toEqual([]);
    expect(legacy.irFirstSkipped).toBeUndefined();
    expect(legacy.irPostClaimErrors ?? []).toEqual([]);

    const irExports = await instantiate(ir);
    const legacyExports = await instantiate(legacy);
    const observed = (exports: typeof irExports) => [
      exports.entryPure!(5),
      exports.callRenamed!(5),
      exports.readInit!(),
    ];
    expect(observed(irExports)).toEqual([9, 15, 42]);
    expect(observed(irExports)).toEqual(observed(legacyExports));
  });

  it("keeps flat cross-file name collisions and their local callers on legacy", async () => {
    const files = {
      "./dep.ts": `
        export function shared(x: number): number { return x + 1; }
        export function depCaller(x: number): number { return shared(x); }
        export function depLeaf(x: number): number { return x * 2; }
      `,
      "./entry.ts": `
        import { depCaller } from "./dep";
        function shared(x: number): number { return x + 10; }
        export function entryCaller(x: number): number { return shared(x); }
        export function entryLeaf(x: number): number { return x - 1; }
        export function runDep(x: number): number { return depCaller(x); }
      `,
    };
    const ir = await compileMulti(files, "./entry.ts", { experimentalIR: true });
    const legacy = await compileMulti(files, "./entry.ts", { experimentalIR: false });
    expectSuccess(ir, "collision IR compile");
    expectSuccess(legacy, "collision legacy compile");

    const compiled = new Set(ir.irCompiledFuncs ?? []);
    expect(compiled.has("shared")).toBe(false);
    expect(compiled.has("depCaller")).toBe(false);
    expect(compiled.has("entryCaller")).toBe(false);
    // The imported caller itself is safe: it symbolically calls depCaller's
    // retained legacy slot and does not join the collided local component.
    expect(compiled.has("runDep")).toBe(true);
    // The guard is component-local, not a blanket shutdown of either file.
    expect(compiled.has("depLeaf")).toBe(true);
    expect(compiled.has("entryLeaf")).toBe(true);
    expect(ir.irPostClaimErrors ?? []).toEqual([]);

    const irExports = await instantiate(ir);
    const legacyExports = await instantiate(legacy);
    for (const name of ["entryCaller", "entryLeaf", "runDep"] as const) {
      expect(irExports[name]!(7), `${name} must retain legacy runtime parity`).toBe(legacyExports[name]!(7));
    }
  });

  it("keeps imported targets legacy-owned on standalone while retaining independent entry coverage", async () => {
    const result = await compileMulti(MULTI_FILES, "./entry.ts", {
      experimentalIR: true,
      target: "standalone",
    });
    expectSuccess(result, "standalone multi compile");

    const compiled = new Set(result.irCompiledFuncs ?? []);
    expect(compiled.has("depPure"), "legacy imported caller is outside the dependency call graph").toBe(false);
    expect(compiled.has("entryPure"), "independent entry function still proves genuine emission").toBe(true);
    expect(compiled.has("callRenamed")).toBe(false);
    expect(compiled.has("initHelper")).toBe(false);
    expect(compiled.has("<module-init>")).toBe(false);
    expect(result.irPostClaimErrors ?? []).toEqual([]);

    const exports = await instantiate(result);
    expect([exports.entryPure!(5), exports.callRenamed!(5), exports.readInit!()]).toEqual([9, 15, 42]);
  });

  it("closes checker-resolved global-script caller ABI edges without import syntax", async () => {
    const files = {
      "./globals.ts": `
        function apply(fn: (x: number) => number, x: number): number {
          return fn(x);
        }

        function identity(fn: (x: number) => number): (x: number) => number {
          return fn;
        }

        function triple(x: number): number {
          return x * 3;
        }

        function dependencyLeaf(x: number): number {
          return x + 10;
        }
      `,
      "./entry.ts": `
        function increment(x: number): number {
          return x + 1;
        }

        export function callApply(x: number): number {
          return apply(increment, x);
        }

        export function callIdentity(x: number): number {
          const fn = identity(increment);
          return fn(x);
        }

        export function callTriple(x: number): number {
          return triple(x);
        }

        export function entryLeaf(x: number): number {
          return x - 1;
        }
      `,
    };

    for (const [label, options] of [
      ["host", {}],
      ["standalone", { target: "standalone" as const }],
    ] as const) {
      const ir = await compileMulti(files, "./entry.ts", { experimentalIR: true, ...options });
      const legacy = await compileMulti(files, "./entry.ts", { experimentalIR: false, ...options });
      expectSuccess(ir, `${label} global-script IR compile`);
      expectSuccess(legacy, `${label} global-script legacy compile`);

      const compiled = new Set(ir.irCompiledFuncs ?? []);
      // B0's canonical callable ABI makes the target itself safe in host mode.
      // The caller is still outside A+B1 because this global-script edge has no
      // supported ESM import binding; standalone remains conservative.
      expect(compiled.has("apply"), `${label}: callable target mode gate`).toBe(label === "host");
      expect(compiled.has("identity"), `${label}: callable-result target stays legacy`).toBe(false);
      expect(compiled.has("callApply"), `${label}: cross-file caller stays legacy`).toBe(false);
      expect(compiled.has("callIdentity"), `${label}: callable-result caller stays legacy`).toBe(false);
      // Host numeric calls share the scalar ABI; standalone/WASI conservatively
      // keep every cross-file target legacy-owned until the canonical ABI slice.
      expect(compiled.has("triple"), `${label}: numeric target mode gate`).toBe(label === "host");
      expect(compiled.has("callTriple"), `${label}: numeric caller stays legacy`).toBe(false);
      expect(compiled.has("dependencyLeaf"), `${label}: dependency anti-vacuity`).toBe(true);
      expect(compiled.has("entryLeaf"), `${label}: entry anti-vacuity`).toBe(true);
      expect(ir.irPostClaimErrors ?? []).toEqual([]);

      const irExports = await instantiate(ir);
      const legacyExports = await instantiate(legacy);
      expect(irExports.callApply!(5), `${label}: callable runtime parity`).toBe(legacyExports.callApply!(5));
      expect(irExports.callIdentity!(5), `${label}: callable-result runtime parity`).toBe(
        legacyExports.callIdentity!(5),
      );
      expect(irExports.callTriple!(5), `${label}: numeric runtime parity`).toBe(legacyExports.callTriple!(5));
      expect([irExports.callApply!(5), irExports.callIdentity!(5), irExports.callTriple!(5)]).toEqual([6, 6, 15]);
    }
  });

  it("keeps class member slots legacy-owned while overlaying an eligible top-level user", async () => {
    const files = {
      "./dep.ts": `
        export class Box {
          value: number;

          constructor(value: number) {
            this.value = value;
          }

          get(): number {
            return this.value;
          }
        }

        export function classUser(x: number): number {
          return new Box(x).get();
        }
      `,
      "./entry.ts": `
        import { classUser } from "./dep";

        export function runClass(x: number): number {
          return classUser(x);
        }
      `,
    };
    const ir = await compileMulti(files, "./entry.ts", { experimentalIR: true });
    const legacy = await compileMulti(files, "./entry.ts", { experimentalIR: false });
    expectSuccess(ir, "class boundary IR compile");
    expectSuccess(legacy, "class boundary legacy compile");

    const compiled = new Set(ir.irCompiledFuncs ?? []);
    expect(compiled.has("classUser"), "top-level anti-vacuity").toBe(true);
    expect(compiled.has("Box_new"), "constructor stays legacy").toBe(false);
    expect(compiled.has("Box_get"), "method stays legacy").toBe(false);
    expect(ir.irPostClaimErrors ?? []).toEqual([]);

    const irExports = await instantiate(ir);
    const legacyExports = await instantiate(legacy);
    expect(irExports.runClass!(8)).toBe(legacyExports.runClass!(8));
    expect(irExports.runClass!(8)).toBe(8);
  });

  it("reaches the same bounded overlay through compileFiles and compileProject", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js2wasm-2138-m0-"));
    const depPath = join(dir, "dep.ts");
    const entryPath = join(dir, "entry.ts");
    writeFileSync(depPath, MULTI_FILES["./dep.ts"]);
    writeFileSync(entryPath, MULTI_FILES["./entry.ts"]);
    try {
      for (const [label, compileDisk] of [
        ["compileFiles", compileFiles],
        ["compileProject", compileProject],
      ] as const) {
        const result = await compileDisk(entryPath, { experimentalIR: true });
        expectSuccess(result, label);
        const compiled = new Set(result.irCompiledFuncs ?? []);
        expect(compiled.has("depPure"), `${label}: dependency anti-vacuity`).toBe(true);
        expect(compiled.has("entryPure"), `${label}: entry anti-vacuity`).toBe(true);
        expect(compiled.has("callRenamed"), `${label}: imported caller is IR-emitted`).toBe(true);
        expect(compiled.has("initHelper"), `${label}: module-init callee stays legacy`).toBe(false);
        expect(compiled.has("<module-init>"), `${label}: shared module init stays legacy`).toBe(false);
        expect(result.irPostClaimErrors ?? []).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
