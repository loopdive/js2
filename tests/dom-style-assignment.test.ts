import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

function createMockElement() {
  const el: Record<string, any> = {
    style: {},
    textContent: "",
    children: [],
    append(child: any) {
      el.children.push(child);
      return child;
    },
    appendChild(child: any) {
      el.children.push(child);
      return child;
    },
  };
  return el;
}

describe("DOM style assignment", () => {
  it("preserves nested host style property sets", async () => {
    const body = createMockElement();
    const doc = {
      createElement: () => createMockElement(),
      body,
    };

    const result = await compile(
      `
        const box = document.createElement("div");
        box.style.width = "300px";
        box.style.height = "300px";
        box.style.backgroundColor = "red";
        box.textContent = "schnucki";
        document.body.append(box);

        export function test(): number {
          return 1;
        }
      `,
      { fileName: "test.ts" },
    );

    expect(result.success).toBe(true);

    const instance = await instantiateWithRuntime(result, { document: doc });

    expect((instance.exports as { test: () => number }).test()).toBe(1);

    expect(body.children).toHaveLength(1);
    const box = body.children[0];
    expect(box.textContent).toBe("schnucki");
    expect(box.style.width).toBe("300px");
    expect(box.style.height).toBe("300px");
    expect(box.style.backgroundColor).toBe("red");
  });
});
