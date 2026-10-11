// Hermetic metadata/source-patch gates. Tiny generated Wasm modules are MOCKS,
// never native producer acceptance evidence and never provider cache artifacts.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertQuickjsScriptPlanCapability,
  buildQuickjsAdapterSource,
  inspectQuickjsScriptPlanCapability,
  QUICKJS_ADAPTER_EXTERNS,
  QUICKJS_SCRIPT_PLAN_SIGNATURES,
  readQuickjsArtifact,
} from "../scripts/quickjs-eval-provider.mjs";
import { checkScriptPlanSource, readScriptPlanPatch } from "../scripts/quickjs-artifact/patches/script-plan-v1.mjs";
import {
  SCRIPT_PLAN_CASES,
  SCRIPT_PLAN_ALLOCATION_CASES,
} from "../scripts/quickjs-artifact/probe/script-plan-contract.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const leb = (n: number): number[] => (n < 128 ? [n] : [(n & 127) | 128, ...leb(n >>> 7)]);
const vector = (items: number[][]) => [...leb(items.length), ...items.flat()];
const text = (s: string) => {
  const bytes = [...new TextEncoder().encode(s)];
  return [...leb(bytes.length), ...bytes];
};
const section = (id: number, bytes: number[]) => [id, ...leb(bytes.length), ...bytes];
const types: Record<string, number> = { i32: 127, i64: 126 };

function mockBinary({ old = false, omit = "", wrongSignature = "", version = 1 } = {}): Uint8Array {
  const entries = old ? [] : Object.entries(QUICKJS_SCRIPT_PLAN_SIGNATURES).filter(([name]) => name !== omit);
  const signatures = entries.map(([name, sig]) => [
    96,
    ...vector(sig.params.map((param: string) => [name === wrongSignature ? types.i64 : types[param]])),
    ...vector(sig.results.map((result: string) => [types[result]])),
  ]);
  const bodies = entries.map(([name]) => {
    const body = [0, 65, name === "qjs_script_plan_version" ? version : 0, 11];
    return [...leb(body.length), ...body];
  });
  return new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, vector(signatures)),
    ...section(3, vector(entries.map((_, i) => leb(i)))),
    ...section(7, vector(entries.map(([name], i) => [...text(name), 0, ...leb(i)]))),
    ...section(10, vector(bodies)),
  ]);
}

// Deliberately synthetic value tags for source-generation equality only.
const mockAbi = () => ({
  tags: {
    INT: 0,
    FLOAT64: 7,
    BOOL: 1,
    NULL: 2,
    UNDEFINED: 3,
    STRING: -7,
    STRING_ROPE: -6,
    OBJECT: -1,
    SHORT_BIG_INT: -8,
  },
  value: { payloadOffset: 0 },
});
function mockArtifact(options: Parameters<typeof mockBinary>[0] = {}) {
  const binary = mockBinary(options);
  const scriptPlan = inspectQuickjsScriptPlanCapability(binary);
  const abi = { ...mockAbi(), capabilities: { scriptPlan } };
  const patch = readScriptPlanPatch();
  const abiSha256 = hash(JSON.stringify(abi));
  return {
    binary,
    abi,
    abiSha256,
    buildInfo: scriptPlan.version
      ? {
          quickjs_ng_ref: patch.manifest.upstreamCommit,
          sha256: hash(binary),
          abi_sha256: abiSha256,
          compiler: "MOCK compiler receipt",
          script_plan: {
            patch: { ...patch.manifest, manifestSha256: patch.manifestSha256 },
            testBuild: false,
            shim_sha256: hash(readFileSync(join(REPO, "scripts/quickjs-artifact/qjs_shim.c"))),
            build_script_sha256: hash(readFileSync(join(REPO, "scripts/quickjs-artifact/build.sh"))),
            patch_step_sha256: hash(readFileSync(join(REPO, "scripts/quickjs-artifact/patches/script-plan-v1.mjs"))),
            flags: ["--target=wasm32-wasip1", "-O2"],
            link_flags: ["-mexec-model=reactor"],
            archiver: "MOCK ar",
            ranlib: "MOCK ranlib",
            nm: "MOCK nm",
            linker: "MOCK wasm-ld",
          },
        }
      : null,
  };
}

describe("inactive Script-plan artifact gates", () => {
  it("preserves the frozen 42 + 7 denominators and all statuses before native execution", () => {
    expect(SCRIPT_PLAN_CASES).toHaveLength(42);
    expect(SCRIPT_PLAN_ALLOCATION_CASES).toHaveLength(7);
    for (const entry of [...SCRIPT_PLAN_CASES, ...SCRIPT_PLAN_ALLOCATION_CASES]) {
      expect(entry.sourceSha256).toBe(hash(entry.source));
      expect(entry.status).toBe("NOT_RUN");
    }
    expect(new Set(SCRIPT_PLAN_CASES.map((entry) => entry.id)).size).toBe(42);
  });
  it("old-artifact/old-adapter and new-artifact/old-adapter remain compatible", () => {
    const oldArtifact = mockArtifact({ old: true });
    const newArtifact = mockArtifact();
    expect(assertQuickjsScriptPlanCapability(oldArtifact, 0).version).toBe(0);
    expect(assertQuickjsScriptPlanCapability(newArtifact, 0).version).toBe(1);
    expect(buildQuickjsAdapterSource(newArtifact.abi)).toBe(buildQuickjsAdapterSource(oldArtifact.abi));
    expect(QUICKJS_ADAPTER_EXTERNS.some((name) => name.startsWith("qjs_script_plan_"))).toBe(false);
    expect(() => assertQuickjsScriptPlanCapability(oldArtifact, 1)).toThrow(/no Script-plan/);
  });
  it("requires every native export, its real signature and version", () => {
    expect(() => inspectQuickjsScriptPlanCapability(mockBinary({ omit: "qjs_script_plan_kind" }), 1)).toThrow(
      /incomplete/,
    );
    expect(() => inspectQuickjsScriptPlanCapability(mockBinary({ wrongSignature: "qjs_script_plan_eval" }), 1)).toThrow(
      /signature/,
    );
    expect(() => inspectQuickjsScriptPlanCapability(mockBinary({ version: 2 }), 1)).toThrow(/version/);
  });
  it("rejects JSON capability advertisement inconsistent with native exports", () => {
    const hidden: any = mockArtifact();
    Reflect.deleteProperty(hidden.abi, "capabilities");
    expect(() => assertQuickjsScriptPlanCapability(hidden)).toThrow(/advertised/);
    const falselyAdvertised: any = mockArtifact({ old: true });
    falselyAdvertised.abi.capabilities.scriptPlan = { version: 1 };
    expect(() => assertQuickjsScriptPlanCapability(falselyAdvertised)).toThrow(/advertised/);
    const wrongSignature: any = mockArtifact();
    wrongSignature.abi.capabilities.scriptPlan.exports.qjs_script_plan_eval.params = [];
    expect(() => assertQuickjsScriptPlanCapability(wrongSignature)).toThrow(/advertised/);
  });
  it.each(["missing-provenance", "binary-digest", "abi-digest", "patch-provenance", "wrong-pin", "wrong-mode"])(
    "rejects %s",
    (fault) => {
      const artifact: any = mockArtifact();
      if (fault === "missing-provenance") artifact.buildInfo = null;
      if (fault === "binary-digest") artifact.buildInfo.sha256 = "0".repeat(64);
      if (fault === "abi-digest") artifact.buildInfo.abi_sha256 = "0".repeat(64);
      if (fault === "patch-provenance") artifact.buildInfo.script_plan.patch.patchSha256 = "0".repeat(64);
      if (fault === "wrong-pin") artifact.buildInfo.quickjs_ng_ref = "0".repeat(40);
      if (fault === "wrong-mode") artifact.buildInfo.script_plan.testBuild = true;
      expect(() => assertQuickjsScriptPlanCapability(artifact, 1)).toThrow();
    },
  );
  it("validates reader and override inputs before use", () => {
    const root = mkdtempSync(join(tmpdir(), "5157-artifact-mock-"));
    const artifact: any = mockArtifact();
    writeFileSync(join(root, "libquickjs.wasm"), artifact.binary);
    writeFileSync(join(root, "qjs-abi.json"), JSON.stringify(artifact.abi));
    writeFileSync(join(root, "build-info.json"), JSON.stringify(artifact.buildInfo));
    expect(readQuickjsArtifact(root, { requiredScriptPlanVersion: 1 })?.sha256).toBe(hash(artifact.binary));
    artifact.buildInfo.sha256 = "0".repeat(64);
    writeFileSync(join(root, "build-info.json"), JSON.stringify(artifact.buildInfo));
    expect(() => readQuickjsArtifact(root)).toThrow(/digest/);
  });
  it.each([
    "shim_sha256",
    "build_script_sha256",
    "patch_step_sha256",
    "flags",
    "link_flags",
    "archiver",
    "ranlib",
    "nm",
    "linker",
  ])("rejects missing or mismatched %s provenance", (field) => {
    const artifact: any = mockArtifact();
    delete artifact.buildInfo.script_plan[field];
    expect(() => assertQuickjsScriptPlanCapability(artifact, 1)).toThrow();
    artifact.buildInfo.script_plan[field] = field.endsWith("sha256") ? "0".repeat(64) : "";
    expect(() => assertQuickjsScriptPlanCapability(artifact, 1)).toThrow();
  });
  it("requires a separately hashed test hook and declared compiler test mode", () => {
    const artifact: any = mockArtifact();
    artifact.buildInfo.script_plan.testBuild = true;
    artifact.buildInfo.script_plan.flags.push("-DJS2WASM_SCRIPT_PLAN_TEST");
    expect(() => assertQuickjsScriptPlanCapability(artifact, 1, { allowTestBuild: true })).toThrow(/test hook/);
    artifact.buildInfo.script_plan.test_hooks_sha256 = hash(
      readFileSync(join(REPO, "scripts/quickjs-artifact/probe/script-plan-test-hooks.c")),
    );
    expect(assertQuickjsScriptPlanCapability(artifact, 1, { allowTestBuild: true }).version).toBe(1);
    artifact.buildInfo.script_plan.flags.pop();
    expect(() => assertQuickjsScriptPlanCapability(artifact, 1, { allowTestBuild: true })).toThrow(/compiler mode/);
  });
  it("requires exact manifest schema and patch bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "5157-patch-mock-"));
    const patch = readScriptPlanPatch();
    const manifestPath = join(root, "manifest.json"),
      patchPath = join(root, "source.patch");
    writeFileSync(patchPath, patch.patchBytes);
    writeFileSync(manifestPath, patch.manifestBytes);
    expect(readScriptPlanPatch(manifestPath, patchPath).manifestSha256).toBe(patch.manifestSha256);
    writeFileSync(manifestPath, JSON.stringify({ ...patch.manifest, schemaVersion: 2 }));
    expect(() => readScriptPlanPatch(manifestPath, patchPath)).toThrow(/schema/);
    writeFileSync(manifestPath, patch.manifestBytes);
    writeFileSync(patchPath, Buffer.concat([patch.patchBytes, Buffer.from("\n")]));
    expect(() => readScriptPlanPatch(manifestPath, patchPath)).toThrow(/patch digest/);
  });
  it("rejects wrong pin, edited preimage, partial/second application and wrong postimage", () => {
    const root = mkdtempSync(join(tmpdir(), "5157-source-mock-"));
    const source = { "quickjs.c": "pristine c", "quickjs.h": "pristine h" };
    for (const [file, bytes] of Object.entries(source)) writeFileSync(join(root, file), bytes);
    const patch: any = {
      manifest: {
        upstreamCommit: "a".repeat(40),
        files: Object.fromEntries(
          Object.entries(source).map(([file, bytes]) => [
            file,
            { preimageSha256: hash(bytes), postimageSha256: hash(`patched ${bytes}`) },
          ]),
        ),
      },
    };
    expect(() => checkScriptPlanSource(root, "b".repeat(40), "preimage", patch)).toThrow(/pin/);
    expect(checkScriptPlanSource(root, patch.manifest.upstreamCommit, "preimage", patch)).toBe(patch);
    writeFileSync(join(root, "quickjs.c"), "edited c");
    expect(() => checkScriptPlanSource(root, patch.manifest.upstreamCommit, "preimage", patch)).toThrow(/preimage/);
    writeFileSync(join(root, "quickjs.c"), "patched pristine c");
    expect(() => checkScriptPlanSource(root, patch.manifest.upstreamCommit, "postimage", patch)).toThrow(/postimage/);
    writeFileSync(join(root, "quickjs.h"), "patched pristine h");
    expect(checkScriptPlanSource(root, patch.manifest.upstreamCommit, "postimage", patch)).toBe(patch);
    expect(() => checkScriptPlanSource(root, patch.manifest.upstreamCommit, "preimage", patch)).toThrow(/preimage/);
  });
  it("cache keys cover ordered manifest and patch bytes without changing tracked inputs", async () => {
    const root = mkdtempSync(join(tmpdir(), "5157-cache-mock-"));
    for (const dir of ["scripts", "scripts/quickjs-artifact", "scripts/quickjs-artifact/patches"])
      mkdirSync(join(root, dir), { recursive: true });
    for (const file of [
      "scripts/quickjs-eval-provider.mjs",
      "scripts/quickjs-artifact/wasi-stub.mjs",
      "scripts/quickjs-artifact/build.sh",
      "scripts/quickjs-artifact/qjs_shim.c",
      "scripts/quickjs-artifact/patches/script-plan-v1.mjs",
      "scripts/quickjs-artifact/patches/script-plan-v1.json",
      "scripts/quickjs-artifact/patches/script-plan-v1.patch",
    ])
      copyFileSync(join(REPO, file), join(root, file));
    const provider = await import(pathToFileURL(join(root, "scripts/quickjs-eval-provider.mjs")).href);
    const before = provider.quickjsArtifactCacheKey();
    const manifestPath = join(root, "scripts/quickjs-artifact/patches/script-plan-v1.json");
    const patchPath = join(root, "scripts/quickjs-artifact/patches/script-plan-v1.patch");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const compact = provider.quickjsArtifactCacheKey();
    expect(compact).not.toBe(before);
    const changedPatch = Buffer.concat([readFileSync(patchPath), Buffer.from("\n")]);
    writeFileSync(patchPath, changedPatch);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, patchSha256: hash(changedPatch) }));
    expect(provider.quickjsArtifactCacheKey()).not.toBe(compact);
  });
});
