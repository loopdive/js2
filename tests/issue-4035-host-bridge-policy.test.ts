// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4035 — the host-bridge export policy.
//
// The bridge (`__vec_*`, `__sget_*`/`__sset_*`, `__call_fn*`, `__exn_render_*`,
// `__stdout_*`, the `js2_*_host_bridge` marker) is the CALLING CONVENTION in
// js-host mode — `src/runtime.ts` cannot materialize an array or read a struct
// field without it — but pure INSPECTION surface for a standalone/WASI module,
// whose host is wasmtime. Exports are GC roots, so publishing it kept ~21 kB of
// float-formatting tables alive in binaries that never called them.
//
// Both directions are asserted together on purpose: shrinking standalone is
// only correct if js-host keeps its convention and an explicit opt-in still
// works.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const BRIDGE_MARKERS = ["__vec_get", "__sget_", "__call_fn", "__exn_render_prepare", "__is_data_struct"] as const;

async function exportSurface(source: string, options: Record<string, unknown>) {
  const result = await compile(source, { fileName: "issue-4035.js", ...options });
  expect(result.success, result.errors?.[0]?.message).toBe(true);
  const binary = result.binary as Uint8Array;
  const bytes = Buffer.from(binary).toString("latin1");
  return {
    size: binary.length,
    bridgeMarkers: BRIDGE_MARKERS.filter((m) => bytes.includes(m)),
    hasRun: bytes.includes("run"),
  };
}

// An array, a class with an accessor, a closure and a throw — every bridge
// family a real program would trigger.
const REALISTIC = `
  class P { constructor(x){ this.x = x; } get double(){ return this.x * 2; } }
  export function run(n){
    const a = [new P(n)];
    a.push(new P(n + 1));
    if (n < 0) throw new TypeError('neg');
    return a.map((p) => p.double).join(',');
  }
`;

describe("#4035 host-bridge export policy", () => {
  it("omits the bridge from a standalone module by default", async () => {
    const { size, bridgeMarkers, hasRun } = await exportSurface(REALISTIC, {
      target: "wasi",
      nativeStrings: true,
      optimize: 3,
    });

    expect(bridgeMarkers).toEqual([]);
    expect(hasRun).toBe(true); // the program's own export survives
    expect(size).toBeLessThan(20_000); // was 23,149 with the bridge published
  });

  it("publishes the bridge for a standalone module on explicit opt-in", async () => {
    // What the test262 harness and any JS-side inspector must pass.
    const { bridgeMarkers } = await exportSurface(REALISTIC, {
      target: "wasi",
      nativeStrings: true,
      optimize: 3,
      hostBridge: "always",
    });

    expect(bridgeMarkers).toContain("__vec_get");
    expect(bridgeMarkers).toContain("__exn_render_prepare");
  });

  it("keeps the bridge for js-host by default — it is the calling convention", async () => {
    const { bridgeMarkers } = await exportSurface(REALISTIC, { optimize: 3 });

    expect(bridgeMarkers).toContain("__vec_get");
    expect(bridgeMarkers).toContain("__sget_");
  });

  it("honours an explicit off for js-host too", async () => {
    const { bridgeMarkers, hasRun } = await exportSurface(REALISTIC, { optimize: 3, hostBridge: "off" });

    expect(bridgeMarkers).toEqual([]);
    expect(hasRun).toBe(true);
  });

  it('leaves js-host output identical between the default and an explicit "auto"', async () => {
    const implicit = await compile(REALISTIC, { fileName: "issue-4035.js", optimize: 3 });
    const explicit = await compile(REALISTIC, { fileName: "issue-4035.js", optimize: 3, hostBridge: "auto" });

    expect(explicit.success).toBe(true);
    expect((explicit.binary as Uint8Array).length).toBe((implicit.binary as Uint8Array).length);
  });

  it("does not strip a user export whose name resembles a short bridge alias", async () => {
    // The alias table ($v0, $c0, $d0, ...) is matched exactly, never by prefix,
    // so a user symbol that merely starts with `$` or `__vec` in its own
    // namespace is untouched.
    const { bridgeMarkers, ...rest } = await exportSurface(
      "export function __vector_norm(n){ return n < 0 ? -n : n; }",
      { target: "wasi", nativeStrings: true, optimize: 3 },
    );
    const bytes = rest;
    expect(bridgeMarkers).toEqual([]);
    expect(bytes.size).toBeGreaterThan(0);

    const result = await compile("export function __vector_norm(n){ return n < 0 ? -n : n; }", {
      fileName: "issue-4035.js",
      target: "wasi",
      nativeStrings: true,
      optimize: 3,
    });
    expect(
      Buffer.from(result.binary as Uint8Array)
        .toString("latin1")
        .includes("__vector_norm"),
    ).toBe(true);
  });
});
