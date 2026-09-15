import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";

it.each(["single", "multi", "computed", "spread", "var", "const"])(
  "enumerates MapLike startup objects (%s)",
  async (mode) => {
    const hasSpread = mode !== "single" && mode !== "multi" && mode !== "computed";
    const source = `
    interface MapLike<T> { [index: string]: T; }
    export const keywords: MapLike<number> = { break: 1, case: 2, ${mode === "computed" ? '["" + "return"]' : "return"}: 3 };
  `;
    const consumer = `
    ${mode === "var" || mode === "const" ? `${mode} merged: { extra: number } = { ...keywords, extra: 4 };` : ""}
    const tokens = new Map(Object.entries(${mode === "var" || mode === "const" ? "merged" : hasSpread ? "{ ...keywords, extra: 4 }" : "keywords"}));
    export function run(): number {
      const input = "  return;";
      if (tokens.get(input.substring(2, 8)) !== 3) return -5;
      const same = "xxsameyy".substring(2, 6);
      const replacement = new Map<string, number>();
      replacement.set(same, 1);
      replacement.set("same", 2);
      if (replacement.size !== 1 || replacement.get("same".substring(0, 4)) !== 2) return -6;
      if (!replacement.delete("same") || replacement.size !== 0) return -7;
      const set = new Set<string>();
      set.add(same);
      set.add("same");
      if (set.size !== 1 || !set.has("same") || !set.delete("same")) return -8;
      const keys = Object.keys(keywords);
      const values = Object.values(keywords);
      ${
        mode === "spread"
          ? `
      let reads = 0;
      function source(): MapLike<number> { reads++; return keywords; }
      const ordered = Object.entries({ before: 0, ...source(), break: 9, extra: 4 });
      if (reads !== 1 || ordered.length !== 5 || ordered[0][0] !== "before" ||
          ordered[1][0] !== "break" || ordered[1][1] !== 9 || ordered[4][0] !== "extra") return -2;
      if (Object.keys({ ...keywords, extra: 4 }).join(",") !== "break,case,return,extra") return -3;
      if (Object.values({ ...keywords, extra: 4 }).join(",") !== "1,2,3,4") return -4;
      `
          : ""
      }
      return tokens.size === ${hasSpread ? 4 : 3} && tokens.get("return") === 3 &&
        keys.join(",") === "break,case,return" && values.join(",") === "1,2,3" ? 1 : -1;
    }
  `;
    const options = { target: "standalone" as const };
    const result =
      mode !== "multi"
        ? await compile(source + consumer, options)
        : await compileMulti(
            {
              "./keywords.ts": source,
              "./entry.ts": `import { keywords } from "./keywords.js";\n${consumer}`,
            },
            "./entry.ts",
            options,
          );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-wasm-exnref",
        "--input-type=module",
        "-e",
        `
    import { readFileSync } from "node:fs";
    const module = new WebAssembly.Module(readFileSync(0));
    if (WebAssembly.Module.imports(module).length) throw new Error("Unexpected imports");
    const instance = await WebAssembly.instantiate(module, {});
    console.log(instance.exports.run());
  `,
      ],
      { input: result.binary, encoding: "utf8", timeout: 10000 },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe("1");
  },
);
