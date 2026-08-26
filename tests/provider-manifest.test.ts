// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2527 — embedded provider-manifest authority.

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WasmEncoder } from "../src/emit/encoder.js";
import {
  appendProviderManifest,
  decodeProviderManifest,
  PROVIDER_COMPILER_ABI_VERSION,
  PROVIDER_LINKER_ABI_VERSION,
  PROVIDER_MANIFEST_SECTION_NAME,
} from "../src/provider-manifest.js";
import { RUNTIME_RECGROUP_ABI_VERSION } from "../src/emit/canonical-recgroup.js";
import { clearPackageProviderMemoryCacheForTests } from "../src/package-linker.js";
import { compile, compileProject, instantiateLinkedProject } from "../src/index.js";

const manifestExpectations = {
  linkerAbiVersion: PROVIDER_LINKER_ABI_VERSION,
  compilerAbiVersion: PROVIDER_COMPILER_ABI_VERSION,
  recgroupAbiVersion: RUNTIME_RECGROUP_ABI_VERSION,
};

function project(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `js2-${prefix}-`));
}

function writePackage(root: string, name: string, source: string): void {
  const packageRoot = join(root, "node_modules", ...name.split("/"));
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name, main: "index.ts" }));
  writeFileSync(join(packageRoot, "index.ts"), source);
}

async function linkedFixture(prefix: string, cacheDirName = ".cache") {
  const root = project(prefix);
  writePackage(root, "manifest-pkg", "export function add(a: number, b: number): number { return a + b; }\n");
  writeFileSync(
    join(root, "main.ts"),
    'import { add } from "manifest-pkg"; export function run(): number { return add(2, 3); }\n',
  );
  const cacheDir = join(root, cacheDirName);
  const result = await compileProject(join(root, "main.ts"), {
    allowJs: true,
    emitWat: false,
    packageCacheDir: cacheDir,
  });
  return { root, cacheDir, result };
}

function appendRawManifestPayload(binary: Uint8Array, payload: string): Uint8Array {
  const enc = new WasmEncoder();
  enc.bytes(binary);
  enc.section(0, (section) => {
    section.name(PROVIDER_MANIFEST_SECTION_NAME);
    section.bytes(new TextEncoder().encode(payload));
  });
  return enc.finish();
}

describe("#2527 provider manifest custom section", () => {
  it("round-trips the canonical embedded manifest and exposes one exact section", async () => {
    const { result } = await linkedFixture("provider-manifest-roundtrip");
    expect(result.linkPlan?.mode).toBe("separate");
    const artifact = result.linkedModules?.[0];
    expect(artifact).toBeDefined();
    const manifest = decodeProviderManifest(artifact!.binary, manifestExpectations);
    expect(manifest.section).toBe(PROVIDER_MANIFEST_SECTION_NAME);
    expect(manifest.version).toBe(1);
    expect(manifest.packageName).toBe("manifest-pkg");
    expect(manifest.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.exports).toEqual(["add"]);
    expect(manifest.providerMetadata).toEqual(artifact!.providerMetadata);
    expect(
      WebAssembly.Module.customSections(new WebAssembly.Module(artifact!.binary), PROVIDER_MANIFEST_SECTION_NAME),
    ).toHaveLength(1);
    const finalHash = createHash("sha256").update(artifact!.binary).digest("hex");
    expect(artifact!.cacheKey).toBe(finalHash);
  });

  it("rejects malformed and unknown-version provider sections", async () => {
    const result = await compile("export function add(a: number, b: number): number { return a + b; }");
    expect(result.success).toBe(true);
    expect(() => decodeProviderManifest(appendRawManifestPayload(result.binary, "{"), manifestExpectations)).toThrow(
      /JSON/,
    );
    expect(() =>
      decodeProviderManifest(
        appendRawManifestPayload(
          result.binary,
          JSON.stringify({ section: PROVIDER_MANIFEST_SECTION_NAME, version: 99 }),
        ),
        manifestExpectations,
      ),
    ).toThrow(/version/);
  });

  it("recovers from the Wasm cache when the optional source index is absent", async () => {
    clearPackageProviderMemoryCacheForTests();
    const first = await linkedFixture("provider-manifest-no-index");
    const index = readdirSync(first.cacheDir).find((name) => name.endsWith(".ref.json"));
    expect(index).toBeDefined();
    unlinkSync(join(first.cacheDir, index!));
    clearPackageProviderMemoryCacheForTests();

    const second = await compileProject(join(first.root, "main.ts"), {
      allowJs: true,
      emitWat: false,
      packageCacheDir: first.cacheDir,
    });
    expect(second.linkPlan).toMatchObject({ mode: "separate", compiledProviders: 0, cachedProviders: 1 });
  });

  it("rejects tampered cache bytes and convenience metadata mismatches", async () => {
    clearPackageProviderMemoryCacheForTests();
    const first = await linkedFixture("provider-manifest-tamper");
    const wasm = readdirSync(first.cacheDir).find((name) => name.endsWith(".wasm"));
    expect(wasm).toBeDefined();
    const tampered = new Uint8Array(readFileSync(join(first.cacheDir, wasm!)));
    tampered[tampered.length - 1] ^= 0x01;
    writeFileSync(join(first.cacheDir, wasm!), tampered);
    clearPackageProviderMemoryCacheForTests();
    const rebuilt = await compileProject(join(first.root, "main.ts"), {
      allowJs: true,
      emitWat: false,
      packageCacheDir: first.cacheDir,
    });
    expect(rebuilt.linkPlan).toMatchObject({ mode: "separate", compiledProviders: 1, cachedProviders: 0 });

    const artifact = rebuilt.linkedModules![0]!;
    const mismatched = {
      ...artifact,
      providerMetadata: { ...artifact.providerMetadata!, stringPool: ["tampered"] },
    };
    await expect(instantiateLinkedProject({ ...rebuilt, linkedModules: [mismatched] })).rejects.toThrow(
      /convenience metadata/,
    );
  });

  it("rejects duplicate manifest sections instead of choosing an authority", async () => {
    const { result } = await linkedFixture("provider-manifest-duplicate");
    const artifact = result.linkedModules![0]!;
    expect(() =>
      appendProviderManifest(artifact.binary, decodeProviderManifest(artifact.binary, manifestExpectations)),
    ).toThrow(/already contains/);
  });
});
