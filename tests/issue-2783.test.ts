// #2783 — general `--link <namespace>` dynamic-linking flag (S1–S3).
//
// Replaces the single `linkNodeShims` boolean with an orthogonal, per-namespace
// axis: `--link <ns>` (repeatable) / `link: string[]` leaves `<ns>::*` as
// link-time imports (satisfied by a preloaded provider) instead of
// inline-lowering it. There is NO `--link-node-shims` alias — `--link node:fs`
// (CLI) / `link: ["node:fs"]` (programmatic) is the only spelling.
//
// Coverage:
//  S1     (a) — `--link node:fs` selects the import-and-link std-IO path
//              (node:fs memory + writeSync imports; no wasi_snapshot_preview1).
//  S2     (b) — the strict-gate generalization: an ARBITRARY `--link`'d
//              namespace's imports survive the `--no-host-imports` / WASI
//              strict gate instead of being rejected (the one genuinely-new
//              capability). Tested at the gate (`isHostImportAllowed` /
//              `scanForLeakedHostImports`).
//  S3     (c) — the removed `--link-node-shims` flag is rejected by the CLI.
//  S3     (d) — multi-file (`compileProject`) honors `link`.
//  S3     (e) — byte-neutral when no `--link` is passed (existing single-source
//              compiles are unchanged).

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compile } from "../src/index.js";
import { isHostImportAllowed, scanForLeakedHostImports } from "../src/codegen/host-import-allowlist.js";

const ECHO = `export function main(): void { console.log("hello, link"); }`;

describe("#2783 S1 — `--link node:fs` selects the import-and-link std-IO path", () => {
  it("`link: ['node:fs']` leaves node:fs (memory + writeSync) as imports", async () => {
    const r = await compile(ECHO, { fileName: "x.ts", target: "wasi", link: ["node:fs"] });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const wat = r.wat ?? "";
    expect(wat).toContain('(import "node:fs" "memory" (memory');
    expect(wat).toContain('(import "node:fs" "writeSync"');
    // No wasi_snapshot_preview1 import survives for the stream IO path.
    expect(wat).not.toContain("wasi_snapshot_preview1");
  });
});

describe("#2783 S2 — arbitrary `--link`'d namespace survives the strict gate", () => {
  it("isHostImportAllowed permits a linked arbitrary namespace, rejects it otherwise", () => {
    // Without --link: an arbitrary namespace is a host-only module → rejected.
    expect(isHostImportAllowed("acme:telemetry", "record")).toEqual({
      allowed: false,
      reason: "non-env-host-module",
    });
    // With --link acme:telemetry: permitted (left as a link-time import).
    expect(isHostImportAllowed("acme:telemetry", "record", new Set(["acme:telemetry"]))).toEqual({
      allowed: true,
    });
  });

  it("scanForLeakedHostImports does not flag a linked namespace's imports", () => {
    const imports = [{ module: "acme:telemetry", name: "record" }];
    // Strict gate WITHOUT the link set → a leak is reported.
    const leaksUnlinked = scanForLeakedHostImports(imports);
    expect(leaksUnlinked).toEqual([{ module: "acme:telemetry", name: "record", reason: "non-env-host-module" }]);
    // Strict gate WITH the namespace linked → it survives (no leak).
    const leaksLinked = scanForLeakedHostImports(imports, new Set(["acme:telemetry"]));
    expect(leaksLinked).toEqual([]);
  });

  it("linking is per-namespace: an UNlinked host module is still rejected", () => {
    // `--link acme:telemetry` does not blanket-permit a different host module.
    const leaks = scanForLeakedHostImports(
      [
        { module: "acme:telemetry", name: "record" },
        { module: "other:thing", name: "leak" },
      ],
      new Set(["acme:telemetry"]),
    );
    expect(leaks).toEqual([{ module: "other:thing", name: "leak", reason: "non-env-host-module" }]);
  });

  it("`env` host bindings are NOT overridable via --link (only real namespaces)", () => {
    // Even if a user tried `--link env`, `env` JS-host bindings stay allowlist-gated.
    expect(isHostImportAllowed("env", "__not_a_real_host_import", new Set(["env"]))).toEqual({
      allowed: false,
      reason: "env-not-on-allowlist",
    });
  });

  it("retains an explicit provider namespace outside WASI without a host-leak warning", async () => {
    const source = `
      declare function record(value: number): number;
      export function run(): number { return record(1); }
    `;
    const unlinked = await compile(source, {
      fileName: "standalone-unlinked-provider.ts",
      target: "standalone",
      externImportModule: "acme:telemetry",
    });
    const linked = await compile(source, {
      fileName: "standalone-linked-provider.ts",
      target: "standalone",
      externImportModule: "acme:telemetry",
      link: ["acme:telemetry"],
    });

    expect(unlinked.errors.some((error) => error.message.includes("Host import leak"))).toBe(true);
    expect(linked.success, linked.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(linked.errors.some((error) => error.message.includes("Host import leak"))).toBe(false);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(linked.binary))).toContainEqual({
      module: "acme:telemetry",
      name: "record",
      kind: "function",
    });
  });
});

describe("#2783 S3 — byte-neutral when no `--link` is passed", () => {
  it("omitting link and passing an empty link array are byte-identical, and differ from linked", async () => {
    const noField = await compile(ECHO, { fileName: "x.ts", target: "wasi" });
    const emptyArr = await compile(ECHO, { fileName: "x.ts", target: "wasi", link: [] });
    const linked = await compile(ECHO, { fileName: "x.ts", target: "wasi", link: ["node:fs"] });
    expect(noField.success && emptyArr.success && linked.success).toBe(true);
    // No `--link` (omitted) === empty array: unchanged standalone/inline path.
    expect(Buffer.compare(Buffer.from(noField.binary), Buffer.from(emptyArr.binary))).toBe(0);
    // And the default path is the self-contained inline fd_write path.
    expect(noField.wat ?? "").toContain("wasi_snapshot_preview1");
    expect(noField.wat ?? "").toContain("fd_write");
    // Linking flips it: distinct output from the inline default.
    expect(Buffer.compare(Buffer.from(noField.binary), Buffer.from(linked.binary))).not.toBe(0);
  });
});

describe("#2783 S3 — the removed `--link-node-shims` flag and the `--link` CLI", () => {
  function runCli(extraArgs: string): { stderr: string; status: number } {
    const dir = mkdtempSync(path.join(tmpdir(), "issue-2783-cli-"));
    const inFile = path.join(dir, "input.ts");
    writeFileSync(inFile, ECHO);
    // spawnSync (not execSync): capture stderr regardless of exit code.
    const args = [
      path.resolve("src/cli.ts"),
      inFile,
      "-o",
      dir,
      "--target",
      "wasi",
      "--no-dts",
      "--quiet",
      ...extraArgs.split(" ").filter(Boolean),
    ];
    const r = spawnSync("npx", ["-y", "tsx", ...args], { cwd: process.cwd(), encoding: "utf8" });
    return { stderr: r.stderr ?? "", status: r.status ?? 1 };
  }

  it("the removed --link-node-shims flag is rejected as unknown", () => {
    const { status } = runCli("--link-node-shims");
    // The CLI's unknown-flag handler exits non-zero; the alias no longer exists.
    expect(status).not.toBe(0);
  });

  it("--link node:fs compiles cleanly (no deprecation note)", () => {
    const { stderr, status } = runCli("--link node:fs");
    expect(status, stderr).toBe(0);
    expect(stderr).not.toMatch(/deprecated/);
  });
});

describe("#2783 S3 — multi-file (compileProject) honors `link`", () => {
  it("a bundled program with link: ['node:fs'] forwards the link policy (node:fs left as imports)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "issue-2783-proj-"));
    const helper = path.join(dir, "helper.ts");
    const entry = path.join(dir, "entry.ts");
    writeFileSync(helper, `export function greet(): void { console.log("from helper"); }`);
    writeFileSync(entry, `import { greet } from "./helper.js";\nexport function main(): void { greet(); }`);
    const { compileProject } = await import("../src/index.js");
    const linked = await compileProject(entry, { target: "wasi", link: ["node:fs"] });
    expect(linked.success, linked.errors.map((e) => e.message).join("\n")).toBe(true);
    // The `link` policy threaded through `compileProject` → `buildCodegenOptions`:
    // node:fs is left as a link-time import (its shim-owned memory is imported)
    // rather than the strict gate rejecting it or the inline path owning memory.
    // (The full std-IO→node:fs writeSync lowering in the bundled path is the
    // separate #2779 codegen-gap work — out of scope for this flag generalization;
    // here we only assert the policy is FORWARDED, which the node:fs import proves.)
    const wat = linked.wat ?? "";
    expect(wat).toContain('(import "node:fs"');
    // Control: WITHOUT link, the bundled program does not import node:fs.
    const unlinked = await compileProject(entry, { target: "wasi" });
    expect(unlinked.success).toBe(true);
    expect(unlinked.wat ?? "").not.toContain('(import "node:fs"');
  });
});
