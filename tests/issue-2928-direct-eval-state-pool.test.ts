// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2928 — the caller-owned direct-eval state must stay compact.
 *
 * The provider ABI is a flat 256-ref-cell pool (64 visible bindings at stride
 * four), but those carriers do not need 256 persistent Wasm locals or 64
 * unrolled sibling-read branches. The caller now owns one externref pool local
 * and delegates construction/lookup to shared module-level loops.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { restoreLocals, snapshotLocals } from "../src/codegen/context/locals.js";
import type { FunctionContext } from "../src/codegen/context/types.js";
import { compile } from "../src/index.js";
import { RUNTIME_EVAL_IMPORT_MODULE, instantiateRuntimeEvalNamespace } from "../scripts/runtime-eval-provider.mjs";

const OPTIONS = {
  target: "standalone",
  experimentalIR: false,
  inferModuleStrictArguments: false,
  skipSemanticDiagnostics: true,
} as const;

async function compileStandalone(source: string, emitWat = false) {
  const result = await compile(source, { ...OPTIONS, emitWat });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  return result;
}

function minimalFunctionContext(): FunctionContext {
  return {
    params: [],
    locals: [],
    localMap: new Map(),
    body: [],
    labelMap: new Map(),
  } as unknown as FunctionContext;
}

let stubProviderModule: WebAssembly.Module;

beforeAll(async () => {
  const provider = await compileStandalone(`
    interface Cell { value: any }
    function result(ok: boolean, value: any): any {
      const out: any[] = [ok, __runtime_eval_wrap_result(value)];
      return out;
    }
    function refuse(): any { return result(false, new TypeError("unused")); }
    function install(state: any, offset: number, name: string, value: any, deletable: boolean): void {
      const nameCell = state[offset] as Cell;
      const valueCell = state[offset + 1] as Cell;
      const markerNameCell = state[offset + 2] as Cell;
      const markerValueCell = state[offset + 3] as Cell;
      nameCell.value = name;
      valueCell.value = value;
      markerNameCell.value = deletable ? "\\0js2wasm:deletable-eval-binding" : "not-an-eval-binding";
      markerValueCell.value = undefined;
    }
    function installWrapped(state: any, offset: number, name: string, value: any): void {
      const nameCell = state[offset] as Cell;
      const valueCell = state[offset + 1] as Cell;
      const markerNameCell = state[offset + 2] as Cell;
      const markerValueCell = state[offset + 3] as Cell;
      nameCell.value = __runtime_eval_wrap_result(name);
      valueCell.value = __runtime_eval_wrap_result(value);
      markerNameCell.value = __runtime_eval_wrap_result("\0js2wasm:deletable-eval-binding");
      markerValueCell.value = __runtime_eval_wrap_result(undefined);
    }
    export function __runtime_direct_eval(
      source: any, globalObject: any, thisArg: any, activationState: any,
      activationSeedNames: any, activationSeedSlots: any, lexicalNames: any,
      lexicalSlots: any, outerNames: any, outerSlots: any,
      callerStrict: boolean, mappedParamNames: any
    ): any {
      if (source === "reuse-x-slot") {
        // The RHS deletes x and immediately reuses its old four-cell group for
        // y. The caller's already-resolved x Reference must not write into y.
        install(activationState, 12, "y", 2, true);
        return result(true, 9);
      }
      if (source === "create-ordered") {
        // The LHS lookup already missed. Creating the name during RHS
        // evaluation must not retroactively change that Reference decision.
        install(activationState, 20, "ordered", 2, true);
        return result(true, 9);
      }
      if (source === "call-made") {
        const callable = (activationState[1] as Cell).value;
        return result(true, callable(41));
      }
      if (source === "wrapped-state") {
        // A separately compiled provider cannot store its private primitive
        // boxes directly in the caller-owned pool. QuickJS therefore stores
        // the canonical cross-module value carrier in every cell.
        installWrapped(activationState, 0, "wrappedMade", 41);
        return result(true, 0);
      }
      install(activationState, 0, "made", 41, true);
      install(activationState, 4, "Object", 3, true);
      install(activationState, 8, "nested", 17, true);
      install(activationState, 12, "x", 41, true);
      install(activationState, 16, "guarded", 23, false);
      return result(true, 0);
    }
    export function __runtime_indirect_eval(source: any, globalObject: any): any { return refuse(); }
    export function __runtime_new_function(params: any, body: any, globalObject: any): any { return refuse(); }
    export function __runtime_apply_interpreted(
      callable: any, receiver: any, argc: number,
      a0: any, a1: any, a2: any, a3: any, a4: any, a5: any, a6: any, a7: any
    ): any { return refuse(); }
  `);
  stubProviderModule = new WebAssembly.Module(provider.binary);
  expect(WebAssembly.Module.imports(stubProviderModule)).toEqual([]);
});

async function runWithStubProvider(source: string): Promise<number> {
  const user = await compileStandalone(source);
  const userModule = new WebAssembly.Module(user.binary);
  const instance = new WebAssembly.Instance(userModule, {
    [RUNTIME_EVAL_IMPORT_MODULE]: instantiateRuntimeEvalNamespace(stubProviderModule),
  });
  return (instance.exports.run as () => number)();
}

const JOIN_HELPER = `
  function join(parts: string[]): string {
    var out = "";
    for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
    return out;
  }
`;

describe("#2928 — compact caller-owned direct-eval state pool", () => {
  it("uses one persistent pool local and shared loop helpers", async () => {
    const result = await compileStandalone(
      `
        function join(parts: string[]): string {
          var out = "";
          for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
          return out;
        }
        export function run(): number {
          eval(join(["var made = 4", "1"]));
          eval(join(["made = made + ", "1"]));
          return made;
        }
      `,
      true,
    );

    const wat = result.wat ?? "";
    expect(wat).toContain("__runtime_eval_new_activation_state_pool");
    expect(wat).toContain("__runtime_eval_find_activation_state_value_cell");
    expect(wat).toContain("i32.const 256");
    expect(wat.match(/runtime_direct_eval_activation_state_pool/g) ?? []).toHaveLength(1);
    expect(wat).not.toContain("runtime_direct_eval_state_cell");
  });

  it("reads an eval-created sibling through the compact value-cell lookup", async () => {
    expect(
      await runWithStubProvider(`
      ${JOIN_HELPER}
      export function run(): number {
        eval(join(["var ignored = ", "0"]));
        return made + 1;
      }
    `),
    ).toBe(42);
  });

  it("unwraps cross-module name and marker carriers before lookup and delete", async () => {
    expect(
      await runWithStubProvider(`
        ${JOIN_HELPER}
        export function run(): number {
          eval(join(["wrapped-", "state"]));
          var seen = wrappedMade;
          var deleted = delete wrappedMade;
          return seen + (deleted ? 10 : 0) + (typeof wrappedMade === "undefined" ? 1 : 0);
        }
      `),
    ).toBe(52);
  });

  it("finds an eval-created binding on a later loop iteration when the read was emitted first", async () => {
    expect(
      await runWithStubProvider(`
        ${JOIN_HELPER}
        export function run(): number {
          while (true) {
            if (typeof made !== "undefined") return made;
            eval(join(["var ignored = ", "0"]));
          }
        }
      `),
    ).toBe(41);
  });

  it("writes through a present eval-created binding instead of creating a global", async () => {
    expect(
      await runWithStubProvider(`
        ${JOIN_HELPER}
        export function run(): number {
          eval(join(["var ignored = ", "0"]));
          made = 9;
          return made;
        }
      `),
    ).toBe(9);
  });

  it("recreates the resolved binding when the RHS deletes its cell and reuses that group", async () => {
    expect(
      await runWithStubProvider(`
        ${JOIN_HELPER}
        export function run(): number {
          eval(join(["var ignored = ", "0"]));
          x = eval(join(["reuse-x", "-slot"]));
          return x * 10 + y;
        }
      `),
    ).toBe(92);
  });

  it("keeps the pre-RHS miss decision when the RHS creates the same activation name", async () => {
    expect(
      await runWithStubProvider(`
        ${JOIN_HELPER}
        export function run(): number {
          eval(join(["var ignored = ", "0"]));
          ordered = eval(join(["create-", "ordered"]));
          return ordered * 10 + globalThis.ordered;
        }
      `),
    ).toBe(29);
  });

  it("deletes and tombstones a present eval-created binding", async () => {
    expect(
      await runWithStubProvider(`
        ${JOIN_HELPER}
        export function run(): number {
          eval(join(["var ignored = ", "0"]));
          var deleted = delete made;
          return (deleted ? 10 : 0) + (typeof made === "undefined" ? 1 : 0);
        }
      `),
    ).toBe(11);
  });

  it("requires the exact eval deletability marker before tombstoning", async () => {
    expect(
      await runWithStubProvider(`
        ${JOIN_HELPER}
        export function run(): number {
          eval(join(["var ignored = ", "0"]));
          var deleted = delete guarded;
          return (deleted ? 10 : 0) + (guarded === 23 ? 1 : 0);
        }
      `),
    ).toBe(11);
  });

  it("lets an eval-created binding shadow an ambient global in typeof", async () => {
    expect(
      await runWithStubProvider(`
        ${JOIN_HELPER}
        export function run(): number {
          eval(join(["var ignored = ", "0"]));
          return typeof Object === "number" ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("threads the owning activation pool into a nested getter created before eval", async () => {
    expect(
      await runWithStubProvider(`
        ${JOIN_HELPER}
        export function run(): number {
          const getter: any = () => nested;
          eval(join(["var ignored = ", "0"]));
          return getter();
        }
      `),
    ).toBe(17);
  });

  it("propagates the owning pool through two capture-only closure levels", async () => {
    expect(
      await runWithStubProvider(`
        ${JOIN_HELPER}
        export function run(): number {
          const outer: any = () => {
            const inner: any = () => nested;
            return inner;
          };
          const getter: any = outer();
          eval(join(["var ignored = ", "0"]));
          return getter();
        }
      `),
    ).toBe(17);
  });

  it("lets an eval var shadow a resolved outer capture on assignment", async () => {
    expect(
      await runWithStubProvider(`
        ${JOIN_HELPER}
        export function run(): number {
          var x = 2;
          const assign: any = () => {
            eval(join(["var ignored = ", "0"]));
            x = 9;
            return x;
          };
          return assign() * 10 + x;
        }
      `),
    ).toBe(92);
  });

  it("keeps an active block lexical ahead of same-name eval state on read", async () => {
    expect(
      await runWithStubProvider(`
        ${JOIN_HELPER}
        export function run(): number {
          var x = 2;
          const read: any = () => {
            eval(join(["var ignored = ", "0"]));
            var inside = 0;
            {
              let x = 5;
              inside = x;
            }
            return inside * 100 + x;
          };
          return read();
        }
      `),
    ).toBe(541);
  });

  it("keeps an active block lexical ahead of same-name eval state on write", async () => {
    expect(
      await runWithStubProvider(`
        ${JOIN_HELPER}
        export function run(): number {
          var x = 2;
          const write: any = () => {
            eval(join(["var ignored = ", "0"]));
            var inside = 0;
            {
              let x = 5;
              x = 7;
              inside = x;
            }
            return inside * 100 + x;
          };
          return write();
        }
      `),
    ).toBe(741);
  });

  it("does not delete same-name eval state through an active block lexical", async () => {
    expect(
      await runWithStubProvider(`
        ${JOIN_HELPER}
        export function run(): number {
          var x = 2;
          const remove: any = () => {
            eval(join(["var ignored = ", "0"]));
            var inside = 0;
            {
              let x = 5;
              inside = (delete x ? 100 : 0) + x;
            }
            return inside * 100 + x;
          };
          return remove();
        }
      `),
    ).toBe(541);
  });

  it("threads the owning activation pool into a nested function declaration", async () => {
    expect(
      await runWithStubProvider(`
        ${JOIN_HELPER}
        export function run(): number {
          function getter(): number { return nested; }
          eval(join(["var ignored = ", "0"]));
          return getter();
        }
      `),
    ).toBe(17);
  });

  it("lets an eval var shadow an ambient binding on assignment", async () => {
    expect(
      await runWithStubProvider(`
        ${JOIN_HELPER}
        export function run(): number {
          eval(join(["var ignored = ", "0"]));
          Object = 9;
          return Object;
        }
      `),
    ).toBe(9);
  });

  it("does not let the ambient Object miss arm poison the fallback after eval delete", async () => {
    expect(
      await runWithStubProvider(`
        ${JOIN_HELPER}
        export function run(): number {
          eval(join(["var ignored = ", "0"]));
          Object = 9;
          var before = Object;
          var removed = delete Object;
          return before * 100 + (removed ? 10 : 0) + (typeof Object === "function" ? 1 : 0);
        }
      `),
    ).toBe(911);
  });

  it("stores an AOT callable carrier that a later provider entry can invoke", async () => {
    expect(
      await runWithStubProvider(`
        ${JOIN_HELPER}
        export function run(): number {
          eval(join(["var ignored = ", "0"]));
          made = function (value: number): number { return value + 1; };
          return eval(join(["call-", "made"]));
        }
      `),
    ).toBe(42);
  });

  it("restores the persistent pool-local pointer after a speculative route", () => {
    const fctx = minimalFunctionContext();
    fctx.directEvalActivationStatePoolLocal = 7;
    const present = snapshotLocals(fctx);
    fctx.directEvalActivationStatePoolLocal = 11;
    restoreLocals(fctx, present);
    expect(fctx.directEvalActivationStatePoolLocal).toBe(7);

    const absentFctx = minimalFunctionContext();
    const absent = snapshotLocals(absentFctx);
    absentFctx.directEvalActivationStatePoolLocal = 3;
    restoreLocals(absentFctx, absent);
    expect(absentFctx.directEvalActivationStatePoolLocal).toBeUndefined();
  });
});
