import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2633 — the hallucinated `process.stdin.read` surface was removed; the
// inline-WASI native-messaging shape now exercises the stdout-write + exit path
// (synchronous stdin moved to `node:fs` `readSync` under --link node:fs).
const NATIVE_MESSAGING_DECL = `declare const process: {
  stdout: { write(c: Uint8Array | string): boolean };
  exit(code: number): void;
};`;

const NATIVE_MESSAGING_SHAPE = `${NATIVE_MESSAGING_DECL}
export function main(): void {
  const header = new Uint8Array(4);
  process.stdout.write(header);
  process.exit(0);
}`;

describe("#1751 WIT generator complete world surface", () => {
  it("emits configured package name plus WASI imports for the native-messaging shape", async () => {
    const result = await compile(NATIVE_MESSAGING_SHAPE, {
      fileName: "native-messaging-host.ts",
      target: "wasi",
      wit: { packageName: "native-messaging-host:native-messaging-js2" },
    });

    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(result.wat).toContain("wasi_snapshot_preview1");
    expect(result.wat).toContain("fd_write");
    expect(result.wat).toContain("proc_exit");

    const wit = result.wit!;
    expect(wit).toContain("package native-messaging-host:native-messaging-js2;");
    expect(wit).not.toContain("package local:module;");
    expect(wit).toContain("world module {");
    // The import annotation reads "Core provider import" since the native-first
    // host-semantics rework (dbccc693f6), which also annotates the capability.
    expect(wit).toContain("/// Core provider import: wasi_snapshot_preview1.fd_write");
    expect(wit).toContain("import fd-write: func(fd: s32, iovs: s32, iovs-len: s32, nwritten: s32) -> s32;");
    expect(wit).toContain("/// Core provider import: wasi_snapshot_preview1.proc_exit");
    expect(wit).toContain("import proc-exit: func(code: s32);");
    expect(wit).toContain("export main: func();");
  });

  it("derives a non-placeholder package name from fileName when none is supplied", async () => {
    const result = await compile(`export function main(): void {}`, {
      fileName: "/tmp/native-messaging-host.ts",
      target: "wasi",
      wit: true,
    });

    expect(result.success).toBe(true);
    expect(result.wit).toContain("package js2wasm:native-messaging-host;");
    expect(result.wit).not.toContain("package local:module;");
  });

  it("CLI --wit-package writes the requested package and implies --wit", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "issue-1751-cli-"));
    try {
      const inFile = path.join(dir, "native-messaging-host.ts");
      writeFileSync(inFile, NATIVE_MESSAGING_SHAPE);

      execFileSync(
        "npx",
        [
          "-y",
          "tsx",
          path.resolve("src/cli.ts"),
          inFile,
          "-o",
          dir,
          "--target",
          "wasi",
          "--wit-package",
          "native-messaging-host:native-messaging-js2",
          "--no-wat",
          "--no-dts",
          "--quiet",
        ],
        { cwd: process.cwd(), stdio: "pipe" },
      );

      const wit = readFileSync(path.join(dir, "native-messaging-host.wit"), "utf8");
      expect(wit).toContain("package native-messaging-host:native-messaging-js2;");
      expect(wit).toContain("import fd-write: func");
      expect(wit).toContain("import proc-exit: func");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
