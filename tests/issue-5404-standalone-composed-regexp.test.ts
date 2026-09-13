// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5404 / #5383 S8 — a RegExp whose pattern is COMPOSED at module init must
// compile through the standalone native engine, not be poisoned.
//
// The standalone backend already const-folded two spellings
// (`"a" + b.source + "c"` and a `const`-bound literal), so the composition
// idiom was *half* supported. The two spellings a library actually uses did
// not fold: a template literal with substitutions, and `[...].join("")`.
// Measured on the shipped `@js-temporal/polyfill` bundle (157 kB, the source
// `buildTemporalProvider` links): **13** `new RegExp` sites, 11 template
// literals + 2 joins, every substitution a `.source` read of a `const`-bound
// literal regex or of an earlier composed one. All 13 raised
// `TypeError: Unsupported dynamic regular expression pattern`, which is 101 of
// the 310 failures across the three linked Temporal families #5383 S7
// measured.
//
// Node is the oracle for every match expectation here — nothing is written
// from memory. The 13 fragment/parser spellings below are the polyfill's own,
// transcribed verbatim (its `regex.js`, as bundled).
//
// The safety half of the change is the LAST test: the widened fold is only
// taken when the composed pattern provably compiles.
// `reportStandaloneRegExpUnsupported` is a STICKY compile error (#3724/#3725),
// so a widened fold landing on a construct the engine cannot lower would turn
// today's catchable TypeError into a hard build failure for the whole bundle —
// strictly worse than the refusal it replaces.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** The polyfill's own fragment bindings, verbatim. Shared by every case. */
const PRELUDE = [
  String.raw`const me = /[A-Za-z._][A-Za-z._0-9+-]*/;`,
  "const fe = new RegExp(`(?:${/(?:[+-](?:[01][0-9]|2[0-3])(?::?[0-5][0-9])?)/.source}|(?:${me.source})(?:\\\\/(?:${me.source}))*)`);",
  String.raw`const ye = /(?:[+-]\d{6}|\d{4})/;`,
  String.raw`const pe = /(?:0[1-9]|1[0-2])/;`,
  String.raw`const ge = /(?:0[1-9]|[12]\d|3[01])/;`,
  "const we = new RegExp(`(${ye.source})(?:-(${pe.source})-(${ge.source})|(${pe.source})(${ge.source}))`);",
  String.raw`const ve = /(\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?|(\d{2})(?:(\d{2})(?:[.,](\d{1,9}))?)?)?/;`,
  String.raw`const be = /((?:[+-])(?:[01][0-9]|2[0-3])(?::?(?:[0-5][0-9])(?::?(?:[0-5][0-9])(?:[.,](?:\d{1,9}))?)?)?)/;`,
  "const De = new RegExp(`([zZ])|${be.source}?`);",
  String.raw`const Te = /\[(!)?([a-z_][a-z0-9_-]*)=([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\]/g;`,
  String.raw`const Oe = /(\d+)(?:[.,](\d{1,9}))?/;`,
  "const $e = new RegExp(`(?:${Oe.source}H)?(?:${Oe.source}M)?(?:${Oe.source}S)?`);",
].join("\n");

/** The 13 `new RegExp` sites, as `[label, constructor source, subject]`. */
const SITES: ReadonlyArray<readonly [string, string, string]> = [
  ["offset-or-iana", "fe", "-05:00"],
  ["date", "we", "1976-11-18"],
  ["z-or-offset", "De", "Z"],
  [
    "datetime",
    'new RegExp([`^${we.source}`,`(?:(?:[tT]|\\\\s+)${ve.source}(?:${De.source})?)?`,`(?:\\\\[!?(${fe.source})\\\\])?`,`((?:${Te.source})*)$`].join(""))',
    "1976-11-18T15:23:30.123",
  ],
  [
    "time",
    'new RegExp([`^[tT]?${ve.source}`,`(?:${De.source})?`,`(?:\\\\[!?${fe.source}\\\\])?`,`((?:${Te.source})*)$`].join(""))',
    "15:23:30",
  ],
  [
    "yearmonth",
    "new RegExp(`^(${ye.source})-?(${pe.source})(?:\\\\[!?${fe.source}\\\\])?((?:${Te.source})*)$`)",
    "1976-11",
  ],
  [
    "monthday",
    "new RegExp(`^(?:--)?(${pe.source})-?(${ge.source})(?:\\\\[!?${fe.source}\\\\])?((?:${Te.source})*)$`)",
    "--11-18",
  ],
  ["timeduration", "$e", "1H2M3S"],
  [
    "duration",
    'new RegExp(`^([+-])?P${/(?:(\\d+)Y)?(?:(\\d+)M)?(?:(\\d+)W)?(?:(\\d+)D)?/.source}(?:T(?!$)${$e.source})?$`,"i")',
    "P1Y2M3DT4H5M6S",
  ],
  ["tzid", 'new RegExp(`^${fe.source}$`,"i")', "Europe/Berlin"],
  ["offset-anchored", "new RegExp(`^${/([+-])([01][0-9]|2[0-3])(?::?([0-5][0-9])?)?/.source}$`)", "-05:00"],
  ["offset-with-seconds", "new RegExp(`^${be.source}$`)", "-05:00:30"],
  [
    "offset-full",
    "new RegExp(`^${/([+-])([01][0-9]|2[0-3])(?::?([0-5][0-9])(?::?([0-5][0-9])(?:[.,](\\d{1,9}))?)?)?/.source}$`)",
    "-05:00:30.5",
  ],
];

/** What Node does with the same prelude + constructor — computed, never recalled. */
function oracle(prelude: string, ctor: string, subject: string): string {
  const fn = new Function(
    `${prelude}\nconst r = ${ctor};\n` +
      `return JSON.stringify(Array.from(r.exec(${JSON.stringify(subject)}) ?? [])` +
      `.map((x) => (x === undefined ? null : x)));`,
  ) as () => string;
  return fn();
}

type Verdict = "AGREES_WITH_NODE" | "NO_MATCH" | "DIFFERENT_CAPTURES" | "REFUSED" | "UNEXPECTED";

/**
 * Compile+run standalone and compare the FULL capture list against Node. The
 * comparison happens inside the module (a Wasm string ref does not survive the
 * boundary); only a small integer comes back.
 */
async function execAgainstNode(prelude: string, ctor: string, subject: string): Promise<Verdict> {
  const expected = oracle(prelude, ctor, subject);
  const src = `${prelude}
const r = ${ctor};
export function test(): number {
  try {
    const m: any = r.exec(${JSON.stringify(subject)});
    if (m === null) return 2;
    let out = "[";
    for (let i = 0; i < m.length; i++) {
      if (i) out = out + ",";
      const v: any = m[i];
      out = out + (v === undefined ? "null" : JSON.stringify(v));
    }
    out = out + "]";
    return out === ${JSON.stringify(expected)} ? 1 : 3;
  } catch (e: any) {
    return e.message === "Unsupported dynamic regular expression pattern" ? 7 : 8;
  }
}`;
  const result = await compile(src, { target: "standalone" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const code = (instance.exports as { test: () => number }).test();
  if (code === 1) return "AGREES_WITH_NODE";
  if (code === 2) return "NO_MATCH";
  if (code === 3) return "DIFFERENT_CAPTURES";
  if (code === 7) return "REFUSED";
  return "UNEXPECTED";
}

describe("#5404 — a composed RegExp pattern compiles under --target standalone", () => {
  it("folds the two composition spellings the `+` fold never covered", async () => {
    // The reduction from the issue, in all three spellings. `+` already worked
    // before this change — it is the control that proves the harness is sound.
    const concat = String.raw`const a = /\d{4}/;`;
    await expect(execAgainstNode(concat, 'new RegExp("^" + a.source + "-(\\\\d{2})$")', "1976-11")).resolves.toBe(
      "AGREES_WITH_NODE",
    );
    await expect(execAgainstNode(concat, "new RegExp(`^${a.source}-(\\\\d{2})$`)", "1976-11")).resolves.toBe(
      "AGREES_WITH_NODE",
    );
    await expect(
      execAgainstNode(concat, 'new RegExp(["^", a.source, "-(\\\\d{2})$"].join(""))', "1976-11"),
    ).resolves.toBe("AGREES_WITH_NODE");
  });

  it("folds through a nested composed RegExp's own `.source`", async () => {
    // `fe`/`we`/`De`/`$e` in the polyfill are themselves `new RegExp(<template>)`,
    // and later sites splice THEIR `.source`. The fold has to recurse through a
    // composed binding, not just a literal one.
    const prelude = [String.raw`const a = /\d{4}/;`, "const b = new RegExp(`(${a.source})`);"].join("\n");
    await expect(execAgainstNode(prelude, "new RegExp(`^${b.source}-(\\\\d{2})$`)", "1976-11")).resolves.toBe(
      "AGREES_WITH_NODE",
    );
  });

  it.each(SITES)("polyfill site %s agrees with Node", async (_label, ctor, subject) => {
    await expect(execAgainstNode(PRELUDE, ctor, subject)).resolves.toBe("AGREES_WITH_NODE");
  });

  it("a widened fold onto an UNCOMPILABLE pattern keeps the catchable refusal", async () => {
    // The safety gate. `{1,100000}` exceeds the engine's expansion cap, so the
    // composed pattern cannot be lowered at compile time. Without the trial
    // compile this reports a STICKY codegen error and the whole module fails to
    // build; with it, the site keeps its pre-#5404 dynamic lowering and the
    // program still COMPILES, throwing the ordinary catchable TypeError on
    // first use.
    const src = [
      String.raw`const frag = /a/;`,
      "const r = new RegExp(`${frag.source}{1,100000}`);",
      "export function test(): number {",
      '  try { return r.test("aaa") ? 1 : 2; }',
      '  catch (e: any) { return e.message === "Unsupported dynamic regular expression pattern" ? 7 : 8; }',
      "}",
    ].join("\n");
    const result = await compile(src, { target: "standalone" });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { test: () => number }).test()).toBe(7);
  });

  it("a genuinely runtime pattern is still refused, not silently folded", async () => {
    // The fold must not widen into "anything that looks like a string". A value
    // that only exists at run time keeps the #4439 poisoned-carrier contract.
    const src = [
      'function mk(): any { return "^(\\\\d{4})$"; }',
      "export function test(): number {",
      '  try { return new RegExp(mk() + "x{1,100000}").test("1976") ? 1 : 2; }',
      '  catch (e: any) { return e.message === "Unsupported dynamic regular expression pattern" ? 7 : 8; }',
      "}",
    ].join("\n");
    const result = await compile(src, { target: "standalone" });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { test: () => number }).test()).toBe(7);
  });

  it("the `gc` (JS-host) lane is untouched by the fold", async () => {
    // #5404 is standalone-only by construction: the fold lives in
    // `regexp-standalone.ts` and the host lane never consults it. Byte
    // identity is asserted in the PR's A/B; here the behavioural half.
    const src = [
      String.raw`const a = /\d{4}/;`,
      "const r = new RegExp(`^${a.source}-(\\\\d{2})$`);",
      'export function test(): number { const m: any = r.exec("1976-11"); return m === null ? 0 : (m[1] === "11" ? 1 : 2); }',
    ].join("\n");
    const result = await compile(src, { target: "gc" } as never);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });
});
