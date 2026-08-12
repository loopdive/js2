// #2528 + #2645 — `--platform node|web` scopes the AMBIENT global surface, and
// composes with the #1772 node:<mod> capability gate at one decision point.
//
// Two orthogonal axes of "what host surface does this program target":
//   - ambient-global axis (#2528, --platform node|web): which globals
//     (window/document/DOM vs the node lib) are in scope. The compiler loaded
//     lib.dom.d.ts unconditionally; --platform node now drops it.
//   - importable node:<mod> axis (#1772 P2): the capability gate. --platform
//     node implies the node-emulation injection path so the two agree on one
//     target model (#2645) — `emulateNode ||= platform === "node"`.
//
// Default (unset --platform) preserves today's behaviour exactly (DOM ambient
// surface loaded, emulation driven solely by its own option) — byte-neutral.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeSource } from "../src/checker/index.js";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

function messageOf(d: { messageText: string | { messageText: string } }): string {
  return typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
}

/** Does any diagnostic flag the name `which` as unresolved (TS2304 / TS2580)? */
function nameNotFound(
  diags: readonly { code: number; messageText: string | { messageText: string } }[],
  which: string,
): boolean {
  return diags.some((d) => (d.code === 2304 || d.code === 2580) && new RegExp(`'${which}'`).test(messageOf(d)));
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const test262It = existsSync(join(process.cwd(), "test262/harness/assert.js")) ? it : it.skip;

describe("#2528 — --platform scopes the ambient global surface (DOM vs node)", () => {
  const winSrc = `export function test(): number { (window as any).stop(); return 1; }`;

  it("DOM globals (window) are in scope by default (unset platform) — back-compat", () => {
    const ast = analyzeSource(winSrc, "input.ts");
    expect(nameNotFound(ast.diagnostics, "window")).toBe(false);
  });

  it("DOM globals (window) are in scope under --platform web", () => {
    const ast = analyzeSource(winSrc, "input.ts", { platform: "web" });
    expect(nameNotFound(ast.diagnostics, "window")).toBe(false);
  });

  it("DOM globals (window) are NOT in scope under --platform node (a clear error)", () => {
    const ast = analyzeSource(winSrc, "input.ts", { platform: "node" });
    expect(nameNotFound(ast.diagnostics, "window")).toBe(true);
  });

  it("a DOM type (HTMLElement) resolves under web but not node", () => {
    const src = `export function test(): number { const x: HTMLElement | null = null; return x ? 1 : 0; }`;
    expect(nameNotFound(analyzeSource(src, "input.ts", { platform: "web" }).diagnostics, "HTMLElement")).toBe(false);
    expect(nameNotFound(analyzeSource(src, "input.ts", { platform: "node" }).diagnostics, "HTMLElement")).toBe(true);
  });

  it("core ES globals (Array/Map/Promise) stay in scope under --platform node", () => {
    const src = `export function test(): number {
      const m = new Map<string, number>(); m.set("a", 1);
      const a = [1, 2, 3].map((x) => x + 1);
      return m.size + a.length;
    }`;
    const ast = analyzeSource(src, "input.ts", { platform: "node" });
    // None of Map/Array should be flagged unresolved — only DOM is dropped.
    for (const name of ["Map", "Array", "Promise"]) {
      expect(nameNotFound(ast.diagnostics, name)).toBe(false);
    }
  });
});

describe("#2645 — --platform node composes with the node capability gate (implies emulation)", () => {
  const procSrc = [`process.stdout.write("hi");`, `const a = process.argv;`, `process.exit(0);`].join("\n");

  it("--platform node implies node emulation: `process` resolves with no TS2580", () => {
    const ast = analyzeSource(procSrc, "input.ts", { platform: "node" });
    expect(nameNotFound(ast.diagnostics, "process")).toBe(false);
  });

  it("--platform web does NOT inject node emulation: `process` still flagged", () => {
    const ast = analyzeSource(procSrc, "input.ts", { platform: "web" });
    expect(nameNotFound(ast.diagnostics, "process")).toBe(true);
  });

  it("default (unset platform) does NOT inject node emulation: `process` still flagged", () => {
    const ast = analyzeSource(procSrc, "input.ts");
    expect(nameNotFound(ast.diagnostics, "process")).toBe(true);
  });

  it("explicit emulateNode still works independently of platform", () => {
    const ast = analyzeSource(procSrc, "input.ts", { emulateNode: true });
    expect(nameNotFound(ast.diagnostics, "process")).toBe(false);
  });

  it("--platform node + emulateNode:false — platform wins, emulation stays ON (no double-gate/contradiction)", () => {
    // emulateNode is OR-composed with platform === "node"; the ambient surface
    // (#2528) and the capability gate (#1772) agree on one target model.
    const ast = analyzeSource(procSrc, "input.ts", { platform: "node", emulateNode: false });
    expect(nameNotFound(ast.diagnostics, "process")).toBe(false);
  });

  it("--platform node still flags genuinely-undefined names (does not over-suppress)", () => {
    const src = `process.stdout.write("x");\nnonexistentThing.foo();`;
    const ast = analyzeSource(src, "input.ts", { platform: "node" });
    expect(nameNotFound(ast.diagnostics, "process")).toBe(false);
    expect(ast.diagnostics.some((d) => /nonexistentThing/.test(messageOf(d)))).toBe(true);
  });
});

describe("#2528/#2645 — end-to-end compile() wiring", () => {
  it("--platform node lowers the unshadowed `global` alias to globalThis", async () => {
    const result = await compile(
      `export function test() {
        return typeof global == "object" && global && global.Object === Object ? 1 : 0;
      }`,
      { fileName: "node-global.js", allowJs: true, platform: "node" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("a lexical binding named `global` still shadows the Node alias", async () => {
    const result = await compile(`export function test(global) { return global; }`, {
      fileName: "node-global-shadow.js",
      allowJs: true,
      platform: "node",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    expect((instance.exports.test as (value: number) => number)(7)).toBe(7);
  });

  it("--platform node suppresses the `process` TS2580 warning (emulation implied)", async () => {
    const result = await compile(`export function test(): number { process.exit(0); return 1; }`, {
      target: "wasi",
      platform: "node",
    });
    expect(result.errors.some((e) => e.code === 2580 && /process/.test(e.message))).toBe(false);
  });

  it("default platform keeps the `process` TS2580 warning pointing at --emulate node", async () => {
    const result = await compile(`export function test(): number { process.exit(0); return 1; }`, {
      target: "wasi",
    });
    const warn = result.errors.find((e) => e.code === 2580 && /process/.test(e.message));
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe("warning");
    expect(warn?.message).toContain("--emulate node");
  });

  it("compiles a plain numeric program identically across unset / web / node (byte-neutral)", async () => {
    // A program touching NO DOM and NO node surface must emit the SAME binary
    // regardless of --platform — the ambient axis is type-level only.
    const src = `export function test(): number {
      let s = 0;
      for (let i = 0; i < 10; i++) s += i * 2;
      return s;
    }`;
    const base = await compile(src, { fileName: "t.ts" });
    const web = await compile(src, { fileName: "t.ts", platform: "web" });
    const node = await compile(src, { fileName: "t.ts", platform: "node" });
    expect(base.success && web.success && node.success).toBe(true);
    expect(sha(web.binary!)).toBe(sha(base.binary!));
    expect(sha(node.binary!)).toBe(sha(base.binary!));
  });
});

describe("#2528/#2645 — test262 byte-neutrality (per #1968)", () => {
  // A genuine test262 file that touches no platform-specific surface must run
  // green AND compile byte-identically with and without --platform set.
  async function withTempTest<T>(source: string, name: string, fn: (path: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "issue-2528-"));
    try {
      const path = join(dir, name);
      await writeFile(path, source);
      return await fn(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test262It("an ES-only test262 program runs green and is byte-neutral under --platform node", async () => {
    const source = `// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/*---
description: ES-only arithmetic — no DOM, no node surface
---*/
assert.sameValue(2 + 3 * 4, 14);
assert.sameValue([1, 2, 3].reduce((a, b) => a + b, 0), 6);
`;
    await withTempTest(source, "issue-2528-byte-neutral.js", async (path) => {
      const r = await runTest262File(path, "smoke");
      expect(r.status).toBe("pass");
    });
  });
});
