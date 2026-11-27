// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { agreesWithNode, refusal, runnerOptions } from "./helpers/prepared-node-agreement.js";

it("reads inherited global methods as the same function objects as ordinary inherited methods", async () => {
  await agreesWithNode(
    "var o={};var out=typeof hasOwnProperty+','+(o.hasOwnProperty===hasOwnProperty)+','+(o.isPrototypeOf===isPrototypeOf)+','+(o.propertyIsEnumerable===propertyIsEnumerable);",
    true,
    runnerOptions(),
  );
}, 60000);

it("resolves a shadowing parameter first", async () => {
  await agreesWithNode("function f(hasOwnProperty){return typeof hasOwnProperty;}var out=f(1);", true, runnerOptions());
}, 60000);

it.each(["valueOf", "constructor", "toLocaleString"])(
  "keeps unsupported inherited %s distinct from an absent name",
  async (name) => {
    expect(await refusal("if(typeof " + name + "!=='function')throw 1;", runnerOptions())).toContain(
      'identifier "' + name + '" is not in scope',
    );
  },
);

it("leaves an inherited name unresolved when the program might replace its property", async () => {
  expect(
    await refusal("var o={};if(typeof hasOwnProperty==='function')o.hasOwnProperty=1;", runnerOptions()),
  ).toContain('identifier "hasOwnProperty" is not in scope');
});

it("still evaluates typeof of a genuinely missing name", async () => {
  await agreesWithNode("var out=typeof nameMissingFromThisRealm;", true, runnerOptions());
}, 60000);
