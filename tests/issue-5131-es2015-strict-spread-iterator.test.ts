// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5131 — strict spread GetIterator/IteratorNext/materializer contract.
//
// These controls exercise the provider through dynamic Proxy argument-list
// evaluation. The host lane uses the canonical strict materializer; the
// standalone lane uses the native provider. Both lanes must expose the same
// observable protocol and standalone must remain host-import free.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Lane = "host" | "standalone";

async function run(source: string, lane: Lane, fileName: string): Promise<{ result: any; imports: string[] }> {
  const result = await compile(source, {
    fileName,
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const, nativeStrings: true } : {}),
  });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("\n")).toBe(true);
  if (!result.success) return { result: undefined, imports: [] };

  // Standalone deliberately has no import object. Keep the lifecycle type
  // explicit so the host-only `setInstance` hook cannot be lost to a union
  // with `{}` during test compilation.
  const imports: ReturnType<typeof buildImports> =
    lane === "host"
      ? buildImports(result.imports, undefined, result.stringPool)
      : ({} as ReturnType<typeof buildImports>);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  const moduleImports = WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map(
    (entry) => `${entry.module}::${entry.name}`,
  );
  return { result: instance.exports, imports: moduleImports };
}

const MATRIX_SOURCE = `
const target: any = {};
const handler: any = {};

function functionTarget(): void {}
function functionHandler(): void {}

function construct(source: any): number {
  try {
    const proxy: any = new Proxy(...source);
    return proxy === null ? 0 : 1;
  } catch (error) {
    return error instanceof TypeError ? 2 : 3;
  }
}

export function arrayHoles(): number {
  return construct([target, ,]);
}

export function targetHole(): number {
  return construct([, handler]);
}

export function arrayValues(): number {
  return construct([target, handler]);
}

export function functionOperands(): number {
  return construct([functionTarget, functionHandler]);
}

export function mapEntries(): number {
  const map: any = new Map();
  map.set(1, 2);
  map.set(3, 4);
  return construct(map);
}

export function mapProjection(): number {
  const map: any = new Map();
  const firstKey: any = {};
  const secondKey: any = {};
  map.set(firstKey, target);
  map.set(secondKey, handler);
  const entries: any[] = [...map];
  return entries.length === 2 &&
    entries[0][0] === firstKey && entries[0][1] === target &&
    entries[1][0] === secondKey && entries[1][1] === handler &&
    entries[0] !== entries[1] ? 1 : 0;
}

export function setValues(): number {
  const set: any = new Set();
  set.add(target);
  set.add(handler);
  return construct(set);
}

export function setProjection(): number {
  const set: any = new Set();
  set.add(target);
  set.add(handler);
  const values: any[] = [...set];
  return values.length === 2 && values[0] === target && values[1] === handler ? 1 : 0;
}

export function emptyTypedArray(): number {
  try {
    const proxy: any = new Proxy(target, ...(new Uint8Array(0) as any), handler);
    return proxy === null ? 0 : 1;
  } catch (error) {
    return error instanceof TypeError ? 2 : 3;
  }
}

export function emptyStringObject(): number {
  try {
    const proxy: any = new Proxy(target, ...(new String(\"\") as any), handler);
    return proxy === null ? 0 : 1;
  } catch (error) {
    return error instanceof TypeError ? 2 : 3;
  }
}

export function customIterable(): number {
  let index = 0;
  const source: any = {
    [Symbol.iterator](): any {
      return {
        next(): any {
          if (index++ === 0) return { value: target, done: false };
          if (index === 2) return { value: handler, done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
  return construct(source);
}

export function missingIterator(): number {
  return construct({ next(): any { return { value: target, done: false }; } });
}

export function nullIterator(): number {
  return construct({ [Symbol.iterator](): any { return null; } });
}

export function nonCallableIterator(): number {
  return construct({ [Symbol.iterator]: 1 });
}

export function throwingIterator(): number {
  let calls = 0;
  const source: any = {
    [Symbol.iterator](): any {
      calls++;
      throw new Error("iterator");
    },
  };
  try {
    new Proxy(...source);
    return 0;
  } catch (error) {
    return error instanceof Error && !(error instanceof TypeError) && calls === 1 ? 1 : 0;
  }
}

export function missingNext(): number {
  return construct({ [Symbol.iterator](): any { return {}; } });
}

export function nonCallableNext(): number {
  return construct({ [Symbol.iterator](): any { return { next: 1 }; } });
}

export function primitiveResult(): number {
  let polls = 0;
  const source: any = {
    [Symbol.iterator](): any {
      return { next(): any { polls++; return 7; } };
    },
  };
  const code = construct(source);
  return code === 2 && polls === 1 ? 1 : 0;
}

export function throwingNext(): number {
  let polls = 0;
  const source: any = {
    [Symbol.iterator](): any {
      return { next(): any { polls++; throw new Error(\"next\"); } };
    },
  };
  try {
    new Proxy(...source);
    return 0;
  } catch (error) {
    return error instanceof Error && !(error instanceof TypeError) && polls === 1 ? 1 : 0;
  }
}

export function laterAbrupt(): number {
  let polls = 0;
  const source: any = {
    [Symbol.iterator](): any {
      return {
        next(): any {
          polls++;
          if (polls === 1) return { value: target, done: false };
          throw new Error("later");
        },
      };
    },
  };
  try {
    new Proxy(...source);
    return 0;
  } catch (error) {
    return error instanceof Error && !(error instanceof TypeError) && polls === 2 ? 1 : 0;
  }
}

export function multipleSpreads(): number {
  try {
    const proxy: any = new Proxy(...[target], ...[handler]);
    return proxy === null ? 0 : 1;
  } catch (error) {
    return error instanceof TypeError ? 2 : 3;
  }
}

export function nestedSpread(): number {
  const first: any[] = [target, handler];
  const nested: any[] = [...first];
  return construct(nested);
}

// Keep an untracked PropertyAssignment allocation ahead of two exact method
// literals with the same explicit structural type. The predecessor must not
// consume either method identity: first stays an empty iterator while second
// contributes Proxy's target and handler. The predecessor-ready value keeps
// the earlier allocation live without relying on its own dynamic-call fallback.
type IteratorShape = { [Symbol.iterator]: () => any };
export function allocationProvenancePredecessor(): number {
  let firstCalls = 0;
  let secondCalls = 0;
  let secondIndex = 0;
  const predecessor: IteratorShape = {
    [Symbol.iterator]: function (): any {
      return { next(): any { return { done: true }; } };
    },
  };
  const predecessorReady = predecessor === null ? 0 : 1;
  const first: IteratorShape = {
    [Symbol.iterator](): any {
      firstCalls++;
      return { next(): any { return { done: true }; } };
    },
  };
  const second: IteratorShape = {
    [Symbol.iterator](): any {
      secondCalls++;
      return {
        next(): any {
          if (secondIndex++ === 0) return { value: target, done: false };
          if (secondIndex === 2) return { value: handler, done: false };
          return { done: true };
        },
      };
    },
  };
  const firstCode = construct(first);
  const secondCode = construct(second);
  return predecessorReady === 1 &&
    firstCode === 2 && secondCode === 1 &&
    firstCalls === 1 && secondCalls === 1 ? 1 : 0;
}

export function emptyCallSpread(): number {
  let observed = -1;
  let evaluations = 0;
  function capture(): void {
    observed = arguments.length;
  }
  function sourceFactory(): any {
    evaluations++;
    return [];
  }
  capture(...sourceFactory());
  return observed === 0 && evaluations === 1 ? 1 : 0;
}

export function trailingEmptyCallSpread(): number {
  let observed = -1;
  let first = -1;
  let last = -1;
  function capture(): void {
    observed = arguments.length;
    first = arguments[0];
    last = arguments[arguments.length - 1];
  }
  const source: any = [];
  capture(1, 2, 3, ...source);
  return observed === 3 && first === 1 && last === 3 ? 1 : 0;
}

export function fieldlessClassRejectsSpread(): number {
  class Empty {}
  return construct(new Empty() as any) === 2 ? 1 : 0;
}

export function doneSuppressesValue(): number {
  let valueReads = 0;
  const source: any = {
    [Symbol.iterator](): any {
      return {
        next(): any {
          return {
            done: true,
            get value() { valueReads++; return target; },
          };
        },
      };
    },
  };
  return construct(source) === 2 && valueReads === 0 ? 1 : 0;
}

// A source-owned property may use the old marker spelling with any value. The
// strict provider's synthetic identity slot must remain compiler-private and
// the empty iterator still contributes zero arguments to Proxy.
export function markerStringCollision(): number {
  let calls = 0;
  const source: any = {
    "$strict_method_id": "user-value",
    [Symbol.iterator](): any {
      calls++;
      return { next(): any { return { done: true }; } };
    },
  };
  return construct(source) === 2 && calls === 1 ? 1 : 0;
}

export function markerNumericCollision(): number {
  let calls = 0;
  const source: any = {
    "$strict_method_id": 99,
    [Symbol.iterator](): any {
      calls++;
      return { next(): any { return { done: true }; } };
    },
  };
  return construct(source) === 2 && calls === 1 ? 1 : 0;
}

// A non-null GC parameter cannot be padded with a sound representation when
// JavaScript invokes @@iterator with zero arguments. Keep this as a regression
// control: the strict direct arm must decline with a catchable TypeError rather
// than emit a null dereference. The pre-existing generic dynamic-call route
// does not yet invoke this required-parameter method with zero arguments.
export function typedIteratorParameterNoTrap(): number {
  const source: any = {
    [Symbol.iterator](arg: { value: number }): any {
      return { next(): any { return { done: true }; } };
    },
  };
  return construct(source) === 2 ? 1 : 0;
}

export function optionalIteratorParameter(): number {
  let calls = 0;
  let sawUndefined = false;
  let index = 0;
  const source: any = {
    [Symbol.iterator](arg?: { value: number }): any {
      calls++;
      sawUndefined = arg === undefined;
      if (arg === undefined)
        return {
          next(): any {
            if (index++ === 0) return { value: target, done: false };
            if (index === 2) return { value: handler, done: false };
            return { value: undefined, done: true };
          },
        };
      return null;
    },
  };
  const code = construct(source);
  return code === 1 && calls === 1 && sawUndefined ? 1 : 0;
}
`;

describe("#5131 strict spread iterator provider", () => {
  it("native-first: keeps Map values iteration off the compatibility iterator bridge", async () => {
    const compiled = await compile(
      `
        export function run(): number {
          const values = new Map<string, number>();
          values.set("a", 1); values.set("b", 2);
          let total = 0;
          for (const value of values.values()) total += value;
          return total;
        }
      `,
      {
        fileName: "issue-5131-native-first-map-values.ts",
        semanticProviders: "native-first",
      },
    );
    expect(compiled.success, compiled.success ? "" : compiled.errors.map((error) => error.message).join("\n")).toBe(
      true,
    );
    if (!compiled.success) return;

    const inventory = compiled.hostImportInventory ?? [];
    // This must stay non-vacuous: native Map values iteration has a concrete
    // JS-value bridge surface, but never the permissive compatibility iterator.
    expect(inventory.length).toBeGreaterThan(0);
    expect(inventory.some((entry) => entry.family === "js-value-bridge")).toBe(true);
    expect(inventory.some((entry) => entry.module === "env" && entry.name === "__iterator")).toBe(false);
    expect(
      inventory.filter((entry) => entry.classification === "legacy-semantic" || entry.classification === "unknown"),
    ).toEqual([]);
  }, 180_000);

  for (const lane of ["host", "standalone"] as const) {
    it(`${lane}: strict acquisition, step, projection, and materialization controls`, async () => {
      const { result, imports } = await run(MATRIX_SOURCE, lane, `issue-5131-${lane}.ts`);
      if (lane === "standalone") expect(imports).toEqual([]);

      expect(Number(result.arrayHoles())).toBe(2);
      expect(Number(result.targetHole())).toBe(2);
      expect(Number(result.arrayValues())).toBe(1);
      expect(Number(result.functionOperands())).toBe(1);
      expect(Number(result.mapEntries())).toBe(1);
      expect(Number(result.mapProjection())).toBe(1);
      expect(Number(result.setValues())).toBe(1);
      expect(Number(result.setProjection())).toBe(1);
      expect(Number(result.emptyTypedArray())).toBe(1);
      expect(Number(result.emptyStringObject())).toBe(1);
      expect(Number(result.customIterable())).toBe(1);
      expect(Number(result.missingIterator())).toBe(2);
      expect(Number(result.nullIterator())).toBe(2);
      expect(Number(result.nonCallableIterator())).toBe(2);
      expect(Number(result.throwingIterator())).toBe(1);
      expect(Number(result.missingNext())).toBe(2);
      expect(Number(result.nonCallableNext())).toBe(2);
      expect(Number(result.primitiveResult())).toBe(1);
      expect(Number(result.throwingNext())).toBe(1);
      expect(Number(result.laterAbrupt())).toBe(1);
      expect(Number(result.multipleSpreads())).toBe(1);
      expect(Number(result.nestedSpread())).toBe(1);
      expect(Number(result.allocationProvenancePredecessor())).toBe(1);
      expect(Number(result.emptyCallSpread())).toBe(1);
      expect(Number(result.trailingEmptyCallSpread())).toBe(1);
      expect(Number(result.fieldlessClassRejectsSpread())).toBe(1);
      expect(Number(result.doneSuppressesValue())).toBe(1);
      expect(Number(result.markerStringCollision())).toBe(1);
      expect(Number(result.markerNumericCollision())).toBe(1);
      expect(Number(result.typedIteratorParameterNoTrap())).toBe(1);
      expect(Number(result.optionalIteratorParameter())).toBe(1);
    }, 180_000);
  }
});
