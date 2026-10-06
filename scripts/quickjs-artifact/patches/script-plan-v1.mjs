// Maintained deterministic source-patch step. Every check precedes compilation;
// no reset, reverse application, fuzzy patch or foreign donor mutation.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCRIPT_PLAN_PATCH_PATH = join(HERE, "script-plan-v1.patch");
export const SCRIPT_PLAN_MANIFEST_PATH = join(HERE, "script-plan-v1.json");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function readScriptPlanPatch(manifestPath = SCRIPT_PLAN_MANIFEST_PATH, patchPath = SCRIPT_PLAN_PATCH_PATH) {
  const manifestBytes = readFileSync(manifestPath);
  const patchBytes = readFileSync(patchPath);
  const manifest = JSON.parse(manifestBytes);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.capabilityVersion !== 1 ||
    !/^[a-f0-9]{40}$/.test(manifest.upstreamCommit) ||
    Object.keys(manifest.files ?? {})
      .sort()
      .join(",") !== "quickjs.c,quickjs.h"
  ) {
    throw new Error("invalid Script-plan patch manifest schema");
  }
  for (const entry of Object.values(manifest.files)) {
    for (const name of ["preimageSha256", "postimageSha256"]) {
      if (!/^[a-f0-9]{64}$/.test(entry[name])) throw new Error(`invalid Script-plan ${name}`);
    }
  }
  if (hash(patchBytes) !== manifest.patchSha256) throw new Error("Script-plan patch digest mismatch");
  return { manifest, manifestBytes, patchBytes, manifestSha256: hash(manifestBytes) };
}

export function checkScriptPlanSource(sourceDir, upstreamCommit, image, patch = readScriptPlanPatch()) {
  if (upstreamCommit !== patch.manifest.upstreamCommit) throw new Error("Script-plan upstream pin mismatch");
  if (image !== "preimage" && image !== "postimage") throw new Error("invalid Script-plan source image check");
  for (const [file, expected] of Object.entries(patch.manifest.files)) {
    if (hash(readFileSync(join(sourceDir, file))) !== expected[`${image}Sha256`]) {
      throw new Error(`Script-plan ${file} ${image} digest mismatch`);
    }
  }
  return patch;
}

export function applyScriptPlanPatch(sourceDir, upstreamCommit) {
  const patch = checkScriptPlanSource(sourceDir, upstreamCommit, "preimage");
  const actualHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceDir, encoding: "utf8" }).trim();
  if (actualHead !== upstreamCommit) throw new Error("Script-plan source checkout HEAD mismatch");
  execFileSync("git", ["apply", "--check", "--whitespace=error-all", SCRIPT_PLAN_PATCH_PATH], { cwd: sourceDir });
  execFileSync("git", ["apply", "--whitespace=error-all", SCRIPT_PLAN_PATCH_PATH], { cwd: sourceDir });
  checkScriptPlanSource(sourceDir, upstreamCommit, "postimage", patch);
  return { ...patch.manifest, manifestSha256: patch.manifestSha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--build-info") {
    const [
      outDir,
      receiptText,
      testBuild,
      quickjsRef,
      wasiRef,
      builtinsUrl,
      target,
      cc,
      ar,
      ranlib,
      nm,
      separator,
      ...arguments_
    ] = process.argv.slice(3);
    const boundary = arguments_.indexOf("--link-flags");
    const flags = arguments_.slice(0, boundary),
      linkFlags = arguments_.slice(boundary + 1);
    if (separator !== "--" || boundary < 1 || !linkFlags.length || !["true", "false"].includes(testBuild))
      throw new Error("invalid Script-plan build-info arguments");
    const binary = readFileSync(join(outDir, "libquickjs.wasm"));
    const version = (tool) => execFileSync(tool, ["--version"], { encoding: "utf8" }).split("\n")[0];
    const info = {
      quickjs_ng_ref: quickjsRef,
      wasi_libc_ref: wasiRef,
      builtins_url: builtinsUrl,
      target_triple: target,
      compiler: version(cc),
      raw_bytes: binary.length,
      gzip_bytes: gzipSync(binary, { level: 9 }).length,
      sha256: hash(binary),
      abi_sha256: hash(readFileSync(join(outDir, "qjs-abi.json"))),
      script_plan: {
        patch: JSON.parse(receiptText),
        testBuild: testBuild === "true",
        shim_sha256: hash(readFileSync(join(HERE, "..", "qjs_shim.c"))),
        build_script_sha256: hash(readFileSync(join(HERE, "..", "build.sh"))),
        patch_step_sha256: hash(readFileSync(fileURLToPath(import.meta.url))),
        ...(testBuild === "true"
          ? { test_hooks_sha256: hash(readFileSync(join(HERE, "..", "probe", "script-plan-test-hooks.c"))) }
          : {}),
        flags,
        link_flags: linkFlags,
        archiver: version(ar),
        ranlib: version(ranlib),
        nm: version(nm),
        linker: version(execFileSync(cc, ["-print-prog-name=wasm-ld"], { encoding: "utf8" }).trim()),
      },
    };
    writeFileSync(join(outDir, "build-info.json"), JSON.stringify(info, null, 2) + "\n");
  } else {
    const [sourceDir, upstreamCommit] = process.argv.slice(2);
    if (!sourceDir || !upstreamCommit) throw new Error("usage: script-plan-v1.mjs SOURCE_DIR UPSTREAM_COMMIT");
    console.log(JSON.stringify(applyScriptPlanPatch(resolve(sourceDir), upstreamCommit)));
  }
}
