// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { projectIrBackendTargetProfile } from "../src/ir/backend/legality.js";
import {
  REMOVED_SEMANTIC_PROVIDER_RELEASE,
  resolveCompileTargetProfile,
  type TargetProfileInput,
} from "../src/target-profile.js";

const cases: ReadonlyArray<readonly [string, TargetProfileInput, ReturnType<typeof resolveCompileTargetProfile>]> = [
  [
    // (#6708 S6) native-first is the default in every environment.
    "default gc (native-first since S6)",
    {},
    {
      target: "gc",
      backend: "wasmgc",
      environment: "javascript",
      capabilityPolicy: "ambient-js",
      semanticProviders: "native-first",
      hostValueInterop: "required",
      strictEnvImportGate: false,
      nativeRegime: true,
      nativeStringsRequiredByPolicy: true,
    },
  ],
  [
    "strict gc host",
    { strictNoHostImports: true },
    {
      target: "gc",
      backend: "wasmgc",
      environment: "javascript",
      capabilityPolicy: "explicit-only",
      semanticProviders: "native-first",
      hostValueInterop: "required",
      strictEnvImportGate: true,
      // (#6979 S7-b) the strict gc build runs on the native regime too
      nativeRegime: true,
      nativeStringsRequiredByPolicy: true,
    },
  ],
  [
    "standalone",
    { target: "standalone" },
    {
      target: "standalone",
      backend: "wasmgc",
      environment: "none",
      capabilityPolicy: "explicit-only",
      semanticProviders: "native-first",
      hostValueInterop: "off",
      strictEnvImportGate: false,
      nativeRegime: true,
      nativeStringsRequiredByPolicy: true,
    },
  ],
  [
    "wasi",
    { target: "wasi" },
    {
      target: "wasi",
      backend: "wasmgc",
      environment: "wasi",
      capabilityPolicy: "explicit-only",
      semanticProviders: "native-first",
      hostValueInterop: "off",
      strictEnvImportGate: true,
      nativeRegime: true, // (#6979 S7-c) WASI lowers with the regime
      nativeStringsRequiredByPolicy: true,
    },
  ],
  [
    "wasi compatibility escape hatch (native-first by default since S6)",
    { target: "wasi", strictNoHostImports: false },
    {
      target: "wasi",
      backend: "wasmgc",
      environment: "wasi",
      capabilityPolicy: "ambient-js",
      semanticProviders: "native-first",
      hostValueInterop: "off",
      strictEnvImportGate: false,
      nativeRegime: true,
      nativeStringsRequiredByPolicy: true,
    },
  ],
  [
    "native-first semantics in a JavaScript environment",
    { semanticProviders: "native-first" },
    {
      target: "gc",
      backend: "wasmgc",
      environment: "javascript",
      capabilityPolicy: "ambient-js",
      semanticProviders: "native-first",
      hostValueInterop: "required",
      strictEnvImportGate: false,
      nativeRegime: true,
      nativeStringsRequiredByPolicy: true,
    },
  ],
  [
    "legacy linear target",
    { target: "linear" },
    {
      target: "linear",
      backend: "linear",
      environment: "unknown",
      capabilityPolicy: "backend-defined",
      semanticProviders: "backend-defined",
      hostValueInterop: "off",
      strictEnvImportGate: false,
      nativeRegime: false,
      nativeStringsRequiredByPolicy: false,
    },
  ],
];

describe("#4396 target policy normalization", () => {
  for (const [name, input, expected] of cases) {
    it(`normalizes ${name}`, () => {
      const profile = resolveCompileTargetProfile(input);
      expect(profile).toEqual(expected);
      expect(Object.isFrozen(profile)).toBe(true);
    });
  }

  it("keeps JS value interop independent from semantic host assistance", () => {
    const strictJs = resolveCompileTargetProfile({ strictNoHostImports: true });
    expect(strictJs.semanticProviders).toBe("native-first");
    expect(strictJs.hostValueInterop).toBe("required");

    const noBridge = resolveCompileTargetProfile({ strictNoHostImports: true, hostBridge: "off" });
    expect(noBridge.semanticProviders).toBe("native-first");
    expect(noBridge.hostValueInterop).toBe("off");

    const inspectedStandalone = resolveCompileTargetProfile({ target: "standalone", hostBridge: "always" });
    expect(inspectedStandalone.semanticProviders).toBe("native-first");
    expect(inspectedStandalone.hostValueInterop).toBe("enabled");
  });

  it("rejects a contradictory native-first string representation override", () => {
    expect(() => resolveCompileTargetProfile({ semanticProviders: "native-first", nativeStrings: false })).toThrow(
      'semanticProviders: "native-first" conflicts with nativeStrings: false',
    );
  });

  // (#6979 S7) The host-assisted profile and the "auto" alias are gone: every
  // spelling that selected them is a compile error naming the issue and the
  // last release that accepted it.
  it.each([
    ["host-assisted", { semanticProviders: "host-assisted" }],
    ["auto", { semanticProviders: "auto" }],
    ["implicit nativeStrings: false", { nativeStrings: false }],
    ["fast + nativeStrings: false", { fast: true, nativeStrings: false } as TargetProfileInput],
    ["standalone + host-assisted", { target: "standalone", semanticProviders: "host-assisted" }],
  ])("rejects the removed %s spelling with the S7 message", (_name, input) => {
    expect(() => resolveCompileTargetProfile(input as TargetProfileInput)).toThrow(
      `#6979 removed (last accepted by js2wasm ${REMOVED_SEMANTIC_PROVIDER_RELEASE})`,
    );
  });

  it("keeps nativeStrings: false a no-op where the JS host semantics never applied", () => {
    for (const input of [
      { target: "standalone" },
      { target: "wasi" },
      { strictNoHostImports: true },
      { target: "linear" },
    ] as const) {
      expect(resolveCompileTargetProfile({ ...input, nativeStrings: false })).toEqual(
        resolveCompileTargetProfile(input),
      );
    }
  });

  it("the compiler surfaces the S7 rejection", async () => {
    const source = "export function add(a: number, b: number): number { return a + b; }";
    await expect(compile(source, { semanticProviders: "host-assisted" as unknown as "native-first" })).rejects.toThrow(
      "#6979",
    );
  });

  it("publishes a user-declared host function under the universal #4401/#6979 gate", async () => {
    // A user-declared host function is an explicit embedder capability
    // (`declared_function`, #6979), so the gate — which now applies to every
    // WasmGC profile — publishes it whether or not native-first is spelled out.
    const source =
      "declare function hostTick(n: number): number;\nexport function run(): number { return hostTick(1); }";
    for (const options of [{}, { semanticProviders: "native-first" as const }]) {
      const result = await compile(source, options);
      expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
    }
  });

  it("normalizes the internal codegen boolean projection through the same resolver", () => {
    expect(resolveCompileTargetProfile({ wasi: true })).toEqual(resolveCompileTargetProfile({ target: "wasi" }));
    expect(resolveCompileTargetProfile({ standalone: true })).toEqual(
      resolveCompileTargetProfile({ target: "standalone" }),
    );
    expect(() => resolveCompileTargetProfile({ wasi: true, standalone: true })).toThrow(
      "wasi and standalone are both enabled",
    );
  });

  it("projects IR capability policy without conflating it with JS value interop", () => {
    const strictJs = resolveCompileTargetProfile({ strictNoHostImports: true });
    expect(strictJs.hostValueInterop).toBe("required");
    // (#6979 S7-b) the strict gc build lowers on the native regime, so the IR
    // sees standalone provider facts, as for the ambient JS environment.
    expect(projectIrBackendTargetProfile(strictJs, { fast: true })).toEqual({
      backend: "wasmgc",
      target: "standalone",
      allowHostImports: false,
      fast: true,
    });

    const permissiveWasi = resolveCompileTargetProfile({ target: "wasi", strictNoHostImports: false });
    expect(projectIrBackendTargetProfile(permissiveWasi).allowHostImports).toBe(false);

    // (#5385) native-first in a JS environment lowers with the standalone
    // semantic regime: the IR sees the same provider facts as a standalone
    // build, while the profile itself keeps its JS environment and value bridge.
    // (#5385 S5) The regime is the default for native-first in a JS environment,
    // and (#6708 S6) native-first is the default policy.
    expect(resolveCompileTargetProfile()).toEqual(resolveCompileTargetProfile({ semanticProviders: "native-first" }));
    const nativeFirstJs = resolveCompileTargetProfile({ semanticProviders: "native-first" });
    expect(nativeFirstJs.environment).toBe("javascript");
    expect(nativeFirstJs.hostValueInterop).toBe("required");
    expect(nativeFirstJs.nativeRegime).toBe(true);
    expect(projectIrBackendTargetProfile(nativeFirstJs)).toEqual({
      backend: "wasmgc",
      target: "standalone",
      allowHostImports: false,
      fast: undefined,
    });

    // (#6979) The S6 kill switch is gone: the environment no longer matters.
    const previous = process.env.JS2WASM_NATIVE_REGIME_JS;
    process.env.JS2WASM_NATIVE_REGIME_JS = "0";
    try {
      expect(resolveCompileTargetProfile().nativeRegime).toBe(true);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_NATIVE_REGIME_JS");
      else process.env.JS2WASM_NATIVE_REGIME_JS = previous;
    }
  });

  it("preserves legacy default projections byte-for-byte", async () => {
    const source = "export function add(a: number, b: number): number { return a + b; }";
    const pairs: ReadonlyArray<readonly [TargetProfileInput, TargetProfileInput]> = [
      [{}, { target: "gc", strictNoHostImports: false }],
      [{ target: "standalone" }, { target: "standalone", strictNoHostImports: false }],
      [{ target: "wasi" }, { target: "wasi", strictNoHostImports: true }],
    ];

    for (const [implicit, explicit] of pairs) {
      const left = await compile(source, implicit);
      const right = await compile(source, explicit);
      expect(left.success, left.errors.map((error) => error.message).join("; ")).toBe(true);
      expect(right.success, right.errors.map((error) => error.message).join("; ")).toBe(true);
      expect(left.binary).toEqual(right.binary);
    }
  });

  it("(#6708) {} is byte-identical to native-first and emits no legacy or unknown import", async () => {
    const sources = [
      "export function add(a: number, b: number): number { return a + b; }",
      `export function greet(name: string, csv: string): string {
  const parts = csv.split(",");
  const msg = \`Hello, \${name}! You have \${parts.length} items: \${parts.join(" | ")}\`;
  return msg.replace("Hello", "Hi");
}`,
    ];
    for (const source of sources) {
      const implicit = await compile(source, {});
      const nativeFirst = await compile(source, { semanticProviders: "native-first" });
      for (const result of [implicit, nativeFirst]) {
        expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
      }
      expect(implicit.binary).toEqual(nativeFirst.binary);
      expect(implicit.hostImportSummary?.byClassification.unknown).toBe(0);
      expect(implicit.hostImportSummary?.byClassification.unknown).toBe(0);
    }
  });
});
