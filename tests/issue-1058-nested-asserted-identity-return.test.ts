// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

describe("#1058 nested asserted identity returns", () => {
  it("keeps a structurally projected base value across an erased derived assertion", async () => {
    const result = await compile(`
      interface Base {
        value: number;
      }

      interface Member extends Base {
        _memberBrand: any;
      }

      interface Extra {
        extra: number;
      }

      interface Identifier extends Member, Extra {
        id: number;
      }

      export function test(): number {
        function memberOrHigher(): Member {
          return rest(makeIdentifier());
        }

        function makeIdentifier(): Identifier {
          return {
            value: 7,
            _memberBrand: undefined,
            extra: 9,
            id: 11,
          };
        }

        function rest(expression: Base): Member {
          return expression as Member;
        }

        return memberOrHigher().value;
      }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    expect((instance.exports.test as () => number)()).toBe(7);
  });
});
