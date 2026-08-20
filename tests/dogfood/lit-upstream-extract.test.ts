import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error — .mjs dogfood extractor has no declaration file
import { extractLitUpstreamTests } from "./lit-upstream-extract.mjs";

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe("Lit upstream extraction infrastructure", () => {
  it("admits browser references when the host declares the browser surface", () => {
    const root = mkdtempSync(join(tmpdir(), "js2wasm-lit-extract-"));
    temporaryRoots.push(root);
    writeFileSync(
      join(root, "fixture.ts"),
      `suite('browser', () => {
        test('uses the supplied browser host', () => {
          const element = document.createElement('span');
          customElements.define('x-lit-fixture', class extends HTMLElement {});
          window.document.body.appendChild(element);
        });
      });
      `,
    );

    const unsupported = extractLitUpstreamTests({
      root,
      testFiles: ["fixture.ts"],
      admitAll: false,
    });
    expect(unsupported.tests).toHaveLength(0);
    expect(unsupported.rejectionCounts["needs-dom"]).toBe(1);

    const supported = extractLitUpstreamTests({
      root,
      testFiles: ["fixture.ts"],
      admitAll: false,
      supportedInfrastructure: new Set(["needs-dom", "needs-custom-elements", "needs-window"]),
    });
    expect(supported.rejected).toHaveLength(0);
    expect(supported.tests).toHaveLength(1);
  });
});
