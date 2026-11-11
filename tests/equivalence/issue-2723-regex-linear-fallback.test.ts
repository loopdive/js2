// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2723 Slice A — standalone RegExp: a search whose backtracking attempt
 * exhausts the step budget finishes on the linear PikeVM instead of throwing
 * `RangeError: regular expression step limit exceeded`.
 *
 * Every case below is a catastrophic-backtracking (ReDoS) pattern that threw
 * that RangeError before this slice. Each program is compiled with
 * `--target standalone` (the native engine, no JS host) and its result must
 * equal native JS on the same source — index, captures (including the
 * quantifier capture reset), `lastIndex`, and every regex-consuming method.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs } from "./helpers.js";

/** Run `main(): string` host-free and read the native string back unit by unit. */
async function runStandalone(source: string): Promise<string> {
  const wrapped = `${source}
    const __r: string = main();
    export function len(): number { return __r.length; }
    export function at(i: number): number { return __r.charCodeAt(i); }`;
  const result = await compile(wrapped, { fileName: "test.ts", target: "standalone" });
  expect(result.success, result.success ? "" : result.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const { len, at } = instance.exports as { len(): number; at(i: number): number };
  return String.fromCharCode(...Array.from({ length: len() }, (_, i) => at(i)));
}

async function expectNativeEquivalent(source: string): Promise<void> {
  expect(await runStandalone(source)).toBe(evaluateAsJs(source).main!());
}

const A27 = "a".repeat(27);
const A20 = "a".repeat(20);

describe("#2723 standalone RegExp linear fallback ≡ native JS", () => {
  it("test(): an exponential no-match returns false instead of throwing", async () => {
    await expectNativeEquivalent(`
      export function main(): string {
        return String(/(a+)+b/.test("${A20}"));
      }`);
  });

  it("exec(): leftmost match index and greedy capture after the hand-off", async () => {
    await expectNativeEquivalent(`
      export function main(): string {
        const m = /(a+)+b/.exec("x${A20}c${"a".repeat(5)}b");
        return m === null ? "null" : m.index + ":" + m[0] + ":" + m[1];
      }`);
  });

  it("exec(): a group that did not take part in the last iteration reads undefined", async () => {
    await expectNativeEquivalent(`
      export function main(): string {
        const m = /(?:(a)|(aa))+c|(d)/.exec("${A27}d");
        return m === null ? "null" : m.index + ":" + m[1] + ":" + m[2] + ":" + m[3];
      }`);
  });

  it("sticky: only lastIndex is tried, and a failure resets lastIndex", async () => {
    await expectNativeEquivalent(`
      export function main(): string {
        const re = /(a|aa)+b/y;
        re.lastIndex = 1;
        const first = re.test("x${A27}");
        re.lastIndex = 1;
        const second = re.test("x${A27}b");
        return first + ":" + second + ":" + re.lastIndex;
      }`);
  });

  it("String.prototype.replace with /g resumes the scan after each linear match", async () => {
    await expectNativeEquivalent(`
      export function main(): string {
        return "${A27}!b-b".replace(/(a|aa)+c|b/g, "X");
      }`);
  });

  it("String.prototype.split", async () => {
    await expectNativeEquivalent(`
      export function main(): string {
        return "${A27}-x-y".split(/(?:a|aa)+c|-/).join("|");
      }`);
  });

  it("String.prototype.search", async () => {
    await expectNativeEquivalent(`
      export function main(): string {
        return String("${A27}z".search(/(a|aa)+y|z/));
      }`);
  });

  it("String.prototype.match with /g", async () => {
    await expectNativeEquivalent(`
      export function main(): string {
        const m = "${A27}qaq".match(/(a|aa)+c|q/g);
        return m === null ? "null" : m.join(",");
      }`);
  });

  it("u flag: code-point classes consume surrogate pairs in the linear VM", async () => {
    const emoji = "\\u{1F600}".repeat(19);
    await expectNativeEquivalent(`
      export function main(): string {
        const m = /(?:\\u{1F600}|.)+x|(.)y/u.exec("${emoji}y");
        return m === null ? "null" : m.index + ":" + m[1];
      }`);
  });

  it("multiline anchors and word boundaries in the linear VM", async () => {
    await expectNativeEquivalent(`
      export function main(): string {
        const m = /(?:a|aa)+\\b-|^q\\b/m.exec("${A27}\\nq");
        return m === null ? "null" : String(m.index);
      }`);
  });

  it("case-insensitive and dotAll programs", async () => {
    await expectNativeEquivalent(`
      export function main(): string {
        const m = /(?:A|aa)+B|(.)z/is.exec("${A27}\\nz");
        return m === null ? "null" : m.index + ":" + JSON.stringify(m[1]);
      }`);
  });

  it("a runtime-constructed pattern takes the same fallback", async () => {
    await expectNativeEquivalent(`
      export function main(): string {
        const src = "(a" + "+)+" + "b";
        return String(new RegExp(src).test("${A20}"));
      }`);
  });
});
