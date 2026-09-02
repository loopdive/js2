// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { compile, compileMulti, type CompileOptions, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ALGORITHMS_URL = new URL("../website/playground/examples/js/algorithms.ts", import.meta.url);
const ALGORITHMS_SOURCE = readFileSync(ALGORITHMS_URL, "utf8");
const MAP_SOURCE = `
  const cache = new Map<number, number>();
  export function memo(n: number): number {
    if (n < 2) return n;
    const hit = cache.get(n);
    if (hit !== undefined) return hit;
    const value = memo(n - 1) + memo(n - 2);
    cache.set(n, value);
    return value;
  }
`;

const previousIrFirst = process.env.JS2WASM_IR_FIRST;
afterEach(() => {
  if (previousIrFirst === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_FIRST");
  else process.env.JS2WASM_IR_FIRST = previousIrFirst;
});

function expectSuccess(result: CompileResult): void {
  expect(result.success, result.errors.map((error) => `${error.severity}: ${error.message}`).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
}

function mapImportNames(result: CompileResult): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(result.binary))
    .filter((entry) => entry.kind === "function" && entry.module === "env" && entry.name.startsWith("Map_"))
    .map((entry) => entry.name)
    .sort();
}

async function tracked(source: string, options: CompileOptions = {}): Promise<CompileResult> {
  return compile(source, {
    fileName: "issue-3517-map-module-init.ts",
    experimentalIR: true,
    trackFallbacks: true,
    skipSemanticDiagnostics: true,
    ...options,
  });
}

describe("#3517 exact generic Map module initializer", () => {
  for (const irFirst of ["0", "1"] as const) {
    it(`IR-emits and runs the exact algorithms source with JS2WASM_IR_FIRST=${irFirst}`, async () => {
      process.env.JS2WASM_IR_FIRST = irFirst;
      const result = await tracked(ALGORITHMS_SOURCE, { fileName: ALGORITHMS_URL.pathname });

      expectSuccess(result);
      expect(result.irCompiledFuncs ?? []).toContain("<module-init>");
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(mapImportNames(result)).toEqual(["Map_get", "Map_new", "Map_set"]);

      const built = buildImports(result.imports, undefined, result.stringPool);
      const env = built.env as Record<string, (...args: unknown[]) => unknown>;
      const originalNew = env.Map_new!;
      const originalGet = env.Map_get!;
      const originalSet = env.Map_set!;
      const maps: unknown[] = [];
      let getCalls = 0;
      let setCalls = 0;
      const logs: string[] = [];
      env.console_log_string = (value: unknown) => logs.push(String(value));
      env.Map_new = (...args: unknown[]) => {
        const map = originalNew(...args);
        maps.push(map);
        return map;
      };
      env.Map_get = (receiver: unknown, ...args: unknown[]) => {
        getCalls++;
        expect(receiver).toBe(maps[0]);
        return originalGet(receiver, ...args);
      };
      env.Map_set = (receiver: unknown, ...args: unknown[]) => {
        setCalls++;
        expect(receiver).toBe(maps[0]);
        return originalSet(receiver, ...args);
      };

      const imports: WebAssembly.Imports = { env: built.env, string_constants: built.string_constants };
      imports["wasm:js-string"] = built["wasm:js-string"] as unknown as WebAssembly.ModuleImports;
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      built.setExports?.(instance.exports as Record<string, Function>);
      expect(maps).toHaveLength(1);

      const main = instance.exports.main as () => void;
      main();
      const firstLogs = [...logs];
      const firstGets = getCalls;
      const firstSets = setCalls;
      expect(firstGets).toBeGreaterThan(0);
      expect(firstSets).toBeGreaterThan(0);
      expect(firstLogs.at(-1)).toBe("after  = [0,1,2,3,4,5,6,7,8,9]");

      main();
      expect(logs.slice(firstLogs.length)).toEqual(firstLogs);
      expect(getCalls).toBeGreaterThan(firstGets);
      expect(setCalls, "the second run reuses the populated module Map").toBe(firstSets);
      expect(maps).toHaveLength(1);
    });
  }

  it.each([
    ["let binding", `let cache = new Map<number, number>(); export function read(): number { return 1; }`],
    ["one type argument", `const cache = new Map<number>(); export function read(): number { return 1; }`],
    [
      "runtime argument",
      `const cache = new Map<number, number>([[1, 2]]); export function read(): number { return 1; }`,
    ],
    [
      "conditional wrapper",
      `const cache = true ? new Map<number, number>() : new Map<number, number>(); export function read(): number { return 1; }`,
    ],
    [
      "shadowed Map",
      `class Map<K, V> {} const cache = new Map<number, number>(); export function read(): number { return 1; }`,
    ],
  ])("keeps the unsupported %s module shape on the direct initializer", async (_label, source) => {
    const result = await tracked(source);
    expectSuccess(result);
    expect(result.irCompiledFuncs ?? []).not.toContain("<module-init>");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps typed local constructors outside the exception", async () => {
    const result = await tracked(`
      class Box<T, U> {}
      export function make(): number {
        const value = new Box<number, number>();
        return value === null ? 0 : 1;
      }
    `);
    expectSuccess(result);
    expect(result.irCompiledFuncs ?? []).not.toContain("make");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  /**
   * (#5259) The five lane pins below asserted `<module-init>` ∉ `irCompiledFuncs`
   * — a "these lanes are legacy-owned" assumption that the IR module-init work
   * has since retired lane by lane, leaving this file red 5/14 on main. Every
   * lane here now IR-compiles the Map initializer; what still differs per lane
   * is WHICH route claims it:
   *
   * - **overlay** — the #3142 slice-2 module-init lowering patches the IR body
   *   into the `__module_init` slot while the legacy body dispatcher still
   *   runs, so the outcome row reads `legacy 1 · IR 1`.
   * - **prepared** — `preparedExactLexicalModuleInit`
   *   (`src/codegen/index.ts:4269-4310`) owns the body outright and emits no
   *   legacy body at all: `legacy 0 · IR 1`.
   */
  interface ModuleInitLaneRouting {
    readonly label: string;
    readonly route: "overlay" | "prepared";
    readonly options: CompileOptions;
    /** `irCompiledFuncs`, in order, exactly as this lane produces it. */
    readonly irCompiledFuncs: readonly string[];
    /** Module-init outcome row: the legacy body dispatcher emitted a body. */
    readonly legacyBodyEmitted: boolean;
    /** Module-init outcome row: the IR body dispatcher emitted a body. */
    readonly irBodyEmitted: boolean;
    /** Post-claim demotions this lane legitimately still reports, by unit. */
    readonly postClaimErrorFuncs: readonly string[];
  }

  const MODULE_INIT_LANES: ModuleInitLaneRouting[] = [
    {
      // Routing owner: #3142 slice 2 (PR #3168) — the IR module-init overlay.
      // The prepared lane's host arm requires `!ctx.nativeStrings` (index.ts:4270)
      // and its standalone arm requires `ctx.standalone` (:4276), so native
      // strings on gc keeps the overlay's dual emission. `memo` demotes
      // post-claim under the gc number-boundary policy, which is a function-lane
      // fact, not a module-init one.
      label: "native strings",
      route: "overlay",
      options: { nativeStrings: true },
      irCompiledFuncs: ["<module-init>"],
      legacyBodyEmitted: true,
      irBodyEmitted: true,
      postClaimErrorFuncs: ["memo"],
    },
    {
      // Routing owner: #3142 slice 2 (PR #3168) — the IR module-init overlay.
      // `ctx.fast` is refused outright by the prepared lane (index.ts:4292), so
      // fast mode can only ever reach `<module-init>` through the overlay.
      label: "fast",
      route: "overlay",
      options: { fast: true },
      irCompiledFuncs: ["<module-init>"],
      legacyBodyEmitted: true,
      irBodyEmitted: true,
      postClaimErrorFuncs: ["memo"],
    },
    {
      // Routing owner: #3523 "retire standalone lexical module-init bodies"
      // (PR #4662) — the prepared lane's standalone native-first arm
      // (index.ts:4275-4280). No legacy body is emitted on this lane.
      label: "standalone",
      route: "prepared",
      options: { target: "standalone" as const },
      irCompiledFuncs: ["memo", "<module-init>"],
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      postClaimErrorFuncs: [],
    },
    {
      // Routing owner: #3523 gap 3 (PR #5425) — WASI joined the prepared lane
      // via the invocation-policy-driven `_start` guard (index.ts:4281-4290),
      // so the prepared route is `legacy 0 · IR 1` here too.
      label: "WASI",
      route: "prepared",
      options: { target: "wasi" as const },
      irCompiledFuncs: ["memo", "<module-init>"],
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      postClaimErrorFuncs: [],
    },
    {
      // Routing owner: #3142 slice 2 (PR #3168) — the IR module-init overlay.
      // An EXPLICIT `--no-host-imports` gc build stays refused by the prepared
      // lane by design (index.ts:4293-4299, #3523 gap 3), so this lane keeps a
      // legacy body alongside the overlay's IR body.
      label: "strict no-host",
      route: "overlay",
      options: { strictNoHostImports: true },
      irCompiledFuncs: ["memo", "<module-init>"],
      legacyBodyEmitted: true,
      irBodyEmitted: true,
      postClaimErrorFuncs: [],
    },
  ];

  it.each(MODULE_INIT_LANES)("routes the Map module initializer through the $route lane in $label", async (lane) => {
    const result = await tracked(MAP_SOURCE, { ...lane.options, trackIrOutcomes: true });
    expectSuccess(result);
    expect(result.irCompiledFuncs ?? []).toEqual(lane.irCompiledFuncs);

    const moduleInitRows = (result.irOutcomes ?? []).filter((outcome) => outcome.unitKind === "module-init");
    expect(moduleInitRows).toHaveLength(1);
    expect({
      kind: moduleInitRows[0]!.kind,
      legacyBodyEmitted: moduleInitRows[0]!.legacyBodyEmitted,
      irBodyEmitted: moduleInitRows[0]!.irBodyEmitted,
    }).toEqual({
      kind: "emitted",
      legacyBodyEmitted: lane.legacyBodyEmitted,
      irBodyEmitted: lane.irBodyEmitted,
    });

    expect((result.irPostClaimErrors ?? []).map((error) => error.func)).toEqual(lane.postClaimErrorFuncs);
  });

  it("keeps module init legacy-owned in the M0 multi-source overlay", async () => {
    const result = await compileMulti(
      {
        "./dep.ts": `export function identity(value: number): number { return value; }`,
        "./entry.ts": `
          import { identity } from "./dep";
          ${MAP_SOURCE}
          export function run(n: number): number { return identity(memo(n)); }
        `,
      },
      "./entry.ts",
      {
        experimentalIR: true,
        trackFallbacks: true,
        skipSemanticDiagnostics: true,
      },
    );
    expectSuccess(result);
    expect(result.irCompiledFuncs ?? []).not.toContain("<module-init>");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });
});
