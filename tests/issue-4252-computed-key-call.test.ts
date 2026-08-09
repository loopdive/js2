// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4252 — `obj[runtimeKey]()` on a plain-object receiver must INVOKE the callee.
 *
 * Before the fix both element-access call drop sites in
 * `src/codegen/expressions/call-tail-dispatch.ts` compiled the receiver, the key
 * and every argument purely for side effects and pushed `ref.null.extern`. The
 * call evaluated to `undefined` and the callee was never entered — silently, with
 * no compile error and no trap. That turned the throwing traps in test262's
 * `allowProxyTraps` helper into non-throwing ones and reported
 * `harness/proxytrapshelper-{default,overrides}.js` as vacuous passes.
 *
 * The element READ was always correct; only the invocation was dropped, which is
 * why `var g = o[k]; g()` worked while `o[k]()` did not.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { runTest262File } from "./test262-runner.js";

const HARNESS = join(__dirname, "..", "test262", "test", "harness");

describe("#4252 — computed-key method call on a plain object", () => {
  const run = async (body: string): Promise<string> => {
    const { compile } = await import("../src/index.js");
    const src = `// @ts-nocheck\n${body}`;
    const r = await compile(src, { target: "standalone" });
    if (!r.success) return `CE: ${r.errors.map((e) => e.message).join("; ")}`;
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const main = (instance.exports as Record<string, unknown>).main as () => unknown;
    return String(main());
  };

  it("invokes through a runtime string key", async () => {
    expect(
      await run(`export function main() {
        const o = { f: () => 7 };
        const k: string = "f";
        return o[k]();
      }`),
    ).toBe("7");
  });

  it("invokes through a key the compiler cannot const-fold", async () => {
    expect(
      await run(`export function main() {
        const o = { f: () => 7 };
        let k = "g"; k = "f";
        return o[k]();
      }`),
    ).toBe("7");
  });

  it("passes arguments through the computed call", async () => {
    expect(
      await run(`export function main() {
        const o = { f: (a: number) => a * 3 };
        const k: string = "f";
        return o[k](5);
      }`),
    ).toBe("15");
  });

  it("invokes on a nested receiver", async () => {
    expect(
      await run(`export function main() {
        const holder = { inner: { g: () => 11 } };
        const k: string = "g";
        return holder.inner[k]();
      }`),
    ).toBe("11");
  });

  it("keeps the array-receiver lowering working", async () => {
    expect(
      await run(`export function main() {
        const fs = [() => 1, () => 2];
        let i = 1;
        return fs[i]();
      }`),
    ).toBe("2");
  });

  // The two harness self-tests this issue was opened against. Neither
  // constructs a Proxy — they exercise `allowProxyTraps`' object literal via
  // `traps[trap]()`, which is exactly the shape above.
  for (const file of ["proxytrapshelper-default.js", "proxytrapshelper-overrides.js"]) {
    it(`test262 harness self-test ${file} passes on the standalone lane`, async () => {
      const r = await runTest262File(join(HARNESS, file), "issue-4252", 60_000, "standalone");
      expect(
        `${r.status}: ${(r as { reason?: string; error?: string }).reason ?? (r as { error?: string }).error ?? ""}`,
      ).toBe("pass: ");
    }, 90_000);
  }
});
