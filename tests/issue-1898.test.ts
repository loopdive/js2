import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

// #1898 — Standalone regression: __object_create's `struct.new $Object` shipped
// 5 operands while $Object has 6 fields (after #1837 added `nextSeq`), so EVERY
// standalone program that triggers the open-object runtime emitted an invalid
// module ("not enough arguments on the stack for struct.new (need 6, got 5)").
// `ensureObjectRuntime` emits `__object_create` unconditionally, so even a
// program that never calls `Object.create` was broken — this regressed the
// whole standalone test262 lane (-1,805 pass, +5,582 compile_error) right after
// #1196 (native prototype-chain ops) merged.
//
// These guards instantiate the binary with empty imports: a stale operand count
// fails at WebAssembly.compile, so a green run proves all `struct.new $Object`
// sites supply the full 6 fields.
describe("#1898 — standalone $Object struct.new arity (nextSeq) regression guard", () => {
  it("a bare open-object program compiles to a valid standalone module", async () => {
    // Computed-key write forces the open $Object runtime (defeats closed-struct
    // inference). This is the minimal repro that broke on #1196's main.
    const source = `
      export function run(): number {
        const o: any = {};
        o["y"] = 2;
        return o["y"] as number;
      }
    `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(2);
  });

  it("Object.create builds a valid $Object (6-field struct.new) standalone", async () => {
    // __object_create is the site that lost the nextSeq operand in #1196.
    const source = `
      export function run(): number {
        const proto: any = {};
        proto["a"] = 3;
        const o: any = Object.create(proto);
        // inherited read through the proto chain → 3
        return o["a"] as number;
      }
    `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(3);
  });

  it("default (gc) target object program is unaffected", async () => {
    // The open-object runtime is standalone-gated; the gc path never emits
    // __object_create. Guard that the default lane stays green either way.
    const source = `
      export function run(): number {
        const o: any = {};
        o["k"] = 5;
        return o["k"] as number;
      }
    `;
    const r = await compile(source); // default gc target
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  });
});
