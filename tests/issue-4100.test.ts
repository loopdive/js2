// #4100 — a RUNTIME-undefined Error message renders the name alone (§20.5.1.1 step 3).
//
// #4035 fixed only the STATIC literal (`new Error(undefined as any)`), because the
// obvious runtime test needs `ensureObjectRuntime` — measured at +3KB on every
// standalone Error-constructing module, which broke #4035's own binary-size test.
// This pins the runtime case, the controls that must NOT be suppressed, and the
// size property that justifies the inlined predicate over the helper call.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(body: string): Promise<number> {
  const r = await compile(`export function test(): number { ${body} }`, {
    fileName: "t.ts",
    target: "standalone",
    hostBridge: "always",
  } as never);
  expect(r.success, r.success ? undefined : r.errors?.[0]?.message).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports as Record<string, () => number>).test!();
}

// Compare the rendered message by TEXT, not by length — "Error" and any other
// 5-character string are not the same claim.
const renders = (expr: string, want: string) => runStandalone(`return ${expr} === ${JSON.stringify(want)} ? 1 : 0;`);

describe("#4100 — runtime-undefined Error message", () => {
  // THE FIX. Fails on the base commit (renders "Error: undefined").
  it("a message that is undefined only at RUNTIME renders the name alone", async () => {
    expect(await renders(`(() => { let m: any; return String(new Error(m)); })()`, "Error")).toBe(1);
  });

  it("the #4035 static-literal case still works", async () => {
    expect(await renders(`String(new Error(undefined as any))`, "Error")).toBe(1);
  });

  it("argument-less still works", async () => {
    expect(await renders(`String(new Error())`, "Error")).toBe(1);
  });

  // NEGATIVE CONTROLS — the predicate must not over-suppress. A test that only
  // checked the undefined cases would pass just as well if the message were
  // dropped unconditionally.
  it("does NOT suppress a real runtime string message", async () => {
    expect(await renders(`(() => { const m: any = "boom"; return String(new Error(m)); })()`, "Error: boom")).toBe(1);
  });

  it("does NOT suppress a numeric message (the #2969 ToString arm)", async () => {
    expect(await renders(`String(new Error(42 as any))`, "Error: 42")).toBe(1);
  });

  it("does NOT suppress an empty-string message", async () => {
    expect(await renders(`String(new Error(""))`, "Error")).toBe(1);
  });

  // KNOWN RESIDUAL, pre-existing (present on the base commit): §20.5.1.1 step 3
  // exempts only `undefined`, so `new Error(null)` should render "Error: null".
  // The original `ref.is_null` guard conflated null with undefined. Pinned as the
  // CURRENT behaviour so the gap is visible and a future fix has to flip it
  // deliberately rather than discover it.
  it("KNOWN RESIDUAL: new Error(null) renders 'Error', not the spec's 'Error: null'", async () => {
    expect(await renders(`String(new Error(null as any))`, "Error")).toBe(1);
  });

  // The size property is the whole justification for inlining the predicate
  // instead of calling `__extern_is_undefined` (which pulls the object runtime).
  it("costs nothing for a module that constructs no Error", async () => {
    const withoutError = await compile(`export function test(): number { return 1 + 1; }`, {
      fileName: "t.ts",
      target: "standalone",
    } as never);
    expect(withoutError.success).toBe(true);
    // 21,257 bytes measured on both the base commit and this one — the predicate
    // is gated on the module already having `$AnyValue`, so a module with no
    // Error construction is byte-identical.
    expect(withoutError.binary!.length).toBeLessThan(25_000);
  });
});
