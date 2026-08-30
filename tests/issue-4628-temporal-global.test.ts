// #4628 — `Temporal` as a real runtime object, wired through a compile-once
// linked provider.
//
// Three independent changes are covered here, and each has a measured
// before/after on this branch's base (`origin/main` + the #5211 stack):
//
//   1. src/temporal-provider.ts — compile `@js-temporal/polyfill` ONCE into a
//      linked provider and bind bare `Temporal` to its export. On base,
//      `typeof Temporal` in a compiled program is "undefined" (the 1,589-row
//      `Temporal is not defined` test262 bucket); here it is "object" and
//      `Object.getOwnPropertyNames(Temporal)` lists all nine classes.
//      HEAVY lane — runs the polyfill compile in a child process.
//
//   2. src/codegen/temporal-native.ts — the #661 syntactic lowering now stands
//      down when `Temporal` names a real compiled binding. Base: a user's own
//      `const Temporal = { PlainDate: { from } }` was silently hijacked by the
//      lowering (`RangeError: invalid Temporal.PlainDate string`). CHEAP lane.
//
//   3. src/codegen/array-methods.ts — `Temporal` out of
//      CLOSURE_UNSAFE_HOST_AMBIENTS. Base/after for an UNDECLARED `Temporal`
//      is identical (0/0) — that is the PR #2838 hazard case, still denied by
//      the generic ambient catch-all; only a DECLARED one changes (0 → 2).
//      CHEAP lane.
//
// (2) and (3) need no polyfill, so they run on every `npm test`.

import { join } from "node:path";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { runDogfoodScript } from "./dogfood/run-dogfood-script";

const HERE = dirname(fileURLToPath(import.meta.url));

async function run(source: string, fileName = "issue-4628.ts"): Promise<unknown> {
  const result = await compile(source, { fileName, skipSemanticDiagnostics: true, allowJs: true, emitWat: false });
  expect(result.success).toBe(true);
  const imports = result.importObject as WebAssembly.Imports & { __setInstance?: (i: WebAssembly.Instance) => void };
  const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
  imports.__setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return (instance.exports as { run?: () => unknown }).run?.();
}

describe("#4628 — a compiled `Temporal` binding wins over the #661 syntactic lowering", () => {
  // Base: THREW `RangeError: invalid Temporal.PlainDate string` — the native
  // lowering matched `Temporal.PlainDate.from(...)` on spelling alone and
  // parsed "x" as an ISO date, never reaching the user's own function.
  it("a user-declared Temporal.PlainDate.from is called, not the native lowering", async () => {
    expect(
      await run(`
        const Temporal = { PlainDate: { from: (s: string) => "user:" + s } };
        export function run(): string { return Temporal.PlainDate.from("x"); }
      `),
    ).toBe("user:x");
  });

  // Base: undefined — the lowering's hard-coded `Temporal.Now.plainDateISO`
  // arm answered a synthetic struct.
  it("a user-declared Temporal.Now.plainDateISO is called", async () => {
    expect(
      await run(`
        const Temporal = { Now: { plainDateISO: () => "user-now" } };
        export function run(): string { return Temporal.Now.plainDateISO(); }
      `),
    ).toBe("user-now");
  });

  // Base: 0 — `new Temporal.Duration(5)` lowered to the native duration struct
  // (whose first field is `years`), so the user class never constructed.
  it("`new` on a user-declared Temporal class constructs the user class", async () => {
    expect(
      await run(`
        class UserDuration { hours: number; constructor(h: number) { this.hours = h; } }
        const Temporal = { Duration: UserDuration };
        export function run(): number { return new Temporal.Duration(5).hours; }
      `),
    ).toBe(5);
  });

  // The gate is a RESOLUTION question, not a feature flag: every program that
  // does not declare `Temporal` keeps the #661 lowering byte-for-byte. This is
  // what protects the 594 Temporal rows that currently pass through it.
  it("an UNDECLARED Temporal still takes the native lowering", async () => {
    expect(
      await run(`
        export function run(): number { const d = Temporal.PlainDate.from("2020-03-04"); return d.month; }
      `),
    ).toBe(3);
  });

  // `declare` emits no value — it asserts a HOST global, which is exactly what
  // the #661 lowering serves. `tests/issue-661.test.ts` opens every fixture
  // with this line in an ordinary `.ts` file, so gating on `isDeclarationFile`
  // alone stood the lowering down for all five of them.
  it("an AMBIENT `declare const Temporal` still takes the native lowering", async () => {
    expect(
      await run(`
        declare const Temporal: any;
        export function run(): number { const d = Temporal.PlainDate.from("2020-03-04"); return d.month; }
      `),
    ).toBe(3);
  });
});

describe("#4628 — CLOSURE_UNSAFE_HOST_AMBIENTS drops `Temporal` only", () => {
  const hof = (capture: string, decl = "") => `
    ${decl}
    export function run(): number {
      const objs = [{ x: 1 }, { x: 2 }, { x: 3 }];
      return objs.filter((o: { x: number }) => ${capture} && o.x > 1).length;
    }
  `;

  // THE PR #2838 HAZARD CASE. Widening this gate flipped 212 Temporal tests
  // pass→fail because a lifted closure could not resolve a host ambient. An
  // undeclared `Temporal` is still a host ambient, and `valueDeclarationOf`
  // returns undefined for it, so the generic catch-all denies it exactly as
  // before: measured 0 on base AND after. The explicit deny-set entry was
  // redundant for this case and load-bearing only against a real binding.
  it("an UNDECLARED Temporal capture still takes the host-callback lane", async () => {
    expect(await run(hof(`typeof Temporal !== "undefined"`))).toBe(0);
  });

  it("Intl stays denied — the removal is name-scoped", async () => {
    expect(await run(hof(`typeof Intl !== "undefined"`))).toBe(0);
    expect(await run(hof(`Intl.tag === 1`, `const Intl = { tag: 1 };`))).toBe(0);
  });

  // Base 0, after 2: a compiled `Temporal` binding is an ordinary user-source
  // declaration and the closure lane resolves it. This is the case the
  // provider prelude creates.
  it("a DECLARED Temporal capture takes the closure lane and iterates", async () => {
    expect(await run(hof(`Temporal.tag === 1`, `const Temporal = { tag: 1 };`))).toBe(2);
  });

  // The shape a test262 harness file would have if it ever declared the global
  // it is handed. Still denied — the #4728 arm treats an outer `any`-typed
  // binding as a host-value capture in disguise, which is what an ambient
  // `declare` produces. Pinned because the deny-set removal is the ONLY thing
  // that used to stop it.
  it("an AMBIENT `declare const Temporal` capture stays off the closure lane", async () => {
    expect(await run(hof(`Temporal.tag === 1`, `declare const Temporal: any;`))).toBe(0);
  });

  it("a callback with no ambient capture is unaffected", async () => {
    expect(await run(hof(`true`))).toBe(2);
  });
});

describe("#4628 — the polyfill compiled as a linked provider (heavy)", () => {
  // Child process: the provider compile is tens of seconds of SYNCHRONOUS work
  // and would otherwise stall the vitest worker's RPC heartbeat into a false
  // timeout (same rationale as the clsx/acorn/temporal-polyfill adapters).
  it("publishes a real `Temporal` global with all nine classes", { timeout: 1_800_000 }, async () => {
    const out = await runDogfoodScript(join(HERE, "dogfood", "temporal-global-harness.mjs"), ["--json"], {
      env: {
        ...process.env,
        JS2WASM_TEMPORAL_CACHE: process.env.JS2WASM_TEMPORAL_CACHE ?? join(tmpdir(), "js2wasm-temporal-cache"),
      },
    });
    const report = JSON.parse(out);

    expect(report.issue).toBe(4628);
    expect(report.polyfillVersion).toBe("0.5.1");
    expect(report.provider.namespace).toMatch(/^js2wasm:npm:@js-temporal\/polyfill:/);
    expect(report.provider.binaryBytes).toBeGreaterThan(1_000_000);

    const s = report.supported;
    for (const [label, probe] of Object.entries(s) as [string, { status: string }][]) {
      expect(`${label}:${probe.status}`).toBe(`${label}:ok`);
    }

    // THE headline. On base this program answers "undefined".
    expect(s.typeofTemporal.value).toBe("object");
    // Issue acceptance criterion 1 — the class names are enumerable own keys.
    expect(s.ownPropertyNames.value).toBe(
      "Duration,Instant,Now,PlainDate,PlainDateTime,PlainMonthDay,PlainTime,PlainYearMonth,ZonedDateTime",
    );
    // Issue acceptance criterion 1 — a Temporal class survives being passed
    // as a value through a function boundary. `temporal-native.ts` resolves
    // kinds SYNTACTICALLY and structurally cannot do this.
    // (#5222) "function", not "object". A class read out of `Temporal` used to
    // be un-marshalled back to its raw closure struct at the consumer's entry
    // boundary, which is `typeof "object"`; keeping the provider-owned mirror
    // intact restores the answer JavaScript actually specifies.
    expect(s.classAsValue.value).toBe("function");
    expect(s.classHasStatics.value).toBe("compare,from,length,name,prototype");
    expect(s.constructAndReadFields.value).toBe("2020/3/4");
    expect(s.aliasable.value).toBe("function");

    // (#5222) `Temporal.Now` is a namespace object nested one level inside
    // `Temporal`, so its methods cross the provider seam twice. On base the
    // second crossing erased them — empty key list, `typeof` "undefined".
    expect(s.nowKeys.value).toBe(
      "@@toStringTag,instant,plainDateISO,plainDateTimeISO,plainTimeISO,timeZoneId,zonedDateTimeISO",
    );
    expect(s.nowInstantIsFunction.value).toBe("function");
    expect(s.nowPlainDateISOIsFunction.value).toBe("function");
    expect(s.nowInstantCallable.value).toBe("object");

    // The compile-once claim, as a measurement rather than a comment: a
    // second consumer must not re-pay the provider build. Prepending the
    // polyfill to each program instead costs ~32 s EVERY time.
    expect(report.secondConsumerMs).toBeLessThan(15_000);

    // Known gaps are REPORTED, not asserted away — see the harness for what
    // was measured about each. Asserting only their presence keeps the list
    // honest without pinning today's failure text.
    expect(Object.keys(report.knownGaps).sort()).toEqual([
      "instanceToString",
      "nowPlainDateISOCall",
      "nowTimeZoneIdCall",
      "staticFrom",
    ]);
  });
});
