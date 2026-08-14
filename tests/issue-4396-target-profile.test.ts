// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { projectIrBackendTargetProfile } from "../src/ir/backend/legality.js";
import { resolveCompileTargetProfile, type TargetProfileInput } from "../src/target-profile.js";

const cases: ReadonlyArray<readonly [string, TargetProfileInput, ReturnType<typeof resolveCompileTargetProfile>]> = [
  [
    "default gc host",
    {},
    {
      target: "gc",
      backend: "wasmgc",
      environment: "javascript",
      capabilityPolicy: "ambient-js",
      semanticProviders: "host-assisted",
      hostValueInterop: "required",
      strictEnvImportGate: false,
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
      nativeStringsRequiredByPolicy: true,
    },
  ],
  [
    "wasi compatibility escape hatch",
    { target: "wasi", strictNoHostImports: false },
    {
      target: "wasi",
      backend: "wasmgc",
      environment: "wasi",
      capabilityPolicy: "ambient-js",
      semanticProviders: "host-assisted",
      hostValueInterop: "off",
      strictEnvImportGate: false,
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
    const host = resolveCompileTargetProfile();
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
});
