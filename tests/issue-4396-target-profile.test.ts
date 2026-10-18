// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it, vi } from "vitest";
import { compile } from "../src/index.js";
import { projectIrBackendTargetProfile } from "../src/ir/backend/legality.js";
import {
  resetSemanticProviderDeprecationWarnings,
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
    // (#6708 S6) The explicit rollback is exactly the pre-S6 gc default.
    "host-assisted compatibility profile",
    { semanticProviders: "host-assisted" },
    {
      target: "gc",
      backend: "wasmgc",
      environment: "javascript",
      capabilityPolicy: "ambient-js",
      semanticProviders: "host-assisted",
      hostValueInterop: "required",
      strictEnvImportGate: false,
      nativeRegime: false,
      nativeStringsRequiredByPolicy: false,
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
      nativeRegime: false,
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
      nativeRegime: false,
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
      nativeRegime: false,
      nativeStringsRequiredByPolicy: true,
    },
  ],
  [
    "wasi compatibility escape hatch with the host-assisted profile",
    { target: "wasi", strictNoHostImports: false, semanticProviders: "host-assisted" },
    {
      target: "wasi",
      backend: "wasmgc",
      environment: "wasi",
      capabilityPolicy: "ambient-js",
      semanticProviders: "host-assisted",
      hostValueInterop: "off",
      strictEnvImportGate: false,
      nativeRegime: false,
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

  it("keeps the pre-S6 host-assisted profile for an implicit selection with nativeStrings: false, warning once", () => {
    resetSemanticProviderDeprecationWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const implicit = resolveCompileTargetProfile({ nativeStrings: false });
      expect(implicit).toEqual(resolveCompileTargetProfile({ semanticProviders: "host-assisted" }));
      resolveCompileTargetProfile({ nativeStrings: false });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('"host-assisted" compatibility profile');
    } finally {
      warn.mockRestore();
      resetSemanticProviderDeprecationWarnings();
    }
  });

  it('accepts "auto" as a deprecated alias of the default and warns exactly once per process', () => {
    resetSemanticProviderDeprecationWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveCompileTargetProfile({ semanticProviders: "auto" })).toEqual(resolveCompileTargetProfile({}));
      expect(resolveCompileTargetProfile({ semanticProviders: "auto" })).toEqual(
        resolveCompileTargetProfile({ semanticProviders: "native-first" }),
      );
      // "auto" keeps meaning "the default": the target-derived standalone profile.
      expect(resolveCompileTargetProfile({ target: "standalone", semanticProviders: "auto" })).toEqual(
        resolveCompileTargetProfile({ target: "standalone" }),
      );
      const autoWarnings = warn.mock.calls.filter((call) => String(call[0]).includes('"auto" is a deprecated alias'));
      expect(autoWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
      resetSemanticProviderDeprecationWarnings();
    }
  });

  it("keeps the #4401 publication contract for an explicit native-first spelling only", async () => {
    // A user-declared host function is an explicit embedder capability the
    // classifier cannot name (`unknown`). The default compiles it; only the
    // explicit native-first contract (#4401) refuses to publish it.
    const source =
      "declare function hostTick(n: number): number;\nexport function run(): number { return hostTick(1); }";
    const implicit = await compile(source, {});
    expect(implicit.success, implicit.errors.map((error) => error.message).join("; ")).toBe(true);
    const explicit = await compile(source, { semanticProviders: "native-first" });
    expect(explicit.success).toBe(false);
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
    const host = resolveCompileTargetProfile({ semanticProviders: "host-assisted" });
    expect(projectIrBackendTargetProfile(host)).toEqual({
      backend: "wasmgc",
      target: "gc",
      allowHostImports: true,
      fast: undefined,
    });

    const strictJs = resolveCompileTargetProfile({ strictNoHostImports: true });
    expect(strictJs.hostValueInterop).toBe("required");
    expect(projectIrBackendTargetProfile(strictJs, { fast: true })).toEqual({
      backend: "wasmgc",
      target: "gc",
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

    // The one-release kill switch restores the pre-S5 per-family reroute —
    // for the default too (#6708).
    const previous = process.env.JS2WASM_NATIVE_REGIME_JS;
    process.env.JS2WASM_NATIVE_REGIME_JS = "0";
    try {
      const killed = resolveCompileTargetProfile({ semanticProviders: "native-first" });
      expect(killed.nativeRegime).toBe(false);
      expect(projectIrBackendTargetProfile(killed).target).toBe("gc");
      const killedDefault = resolveCompileTargetProfile();
      expect(killedDefault.nativeRegime).toBe(false);
      expect(killedDefault.semanticProviders).toBe("native-first");
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

  it("(#6708) {} is byte-identical to native-first; host-assisted is the legacy-importing rollback", async () => {
    // The pre-flip hashes of these programs under the pre-S6 default are
    // recorded in plan/issues/6708-*.md; `host-assisted` reproduced all three.
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
      const hostAssisted = await compile(source, { semanticProviders: "host-assisted" });
      for (const result of [implicit, nativeFirst, hostAssisted]) {
        expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
      }
      expect(implicit.binary).toEqual(nativeFirst.binary);
      expect(hostAssisted.binary).not.toEqual(implicit.binary);
      expect(implicit.hostImportSummary?.byClassification["legacy-semantic"]).toBe(0);
      expect(implicit.hostImportSummary?.byClassification.unknown).toBe(0);
      // Non-vacuity: the rollback really is the host-assisted profile.
      expect(hostAssisted.hostImportSummary?.byClassification["legacy-semantic"]).toBeGreaterThanOrEqual(1);
    }
  });
});
