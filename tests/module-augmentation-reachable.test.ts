// A file that only augments an interface (`declare module "./x.js" { … }`) is
// seen by `tsc -p` (which includes every file) but NOT by an entry-rooted
// program such as a JS² self-compile, unless some module imports it. When
// nothing does, the self-compile front end reports the augmented members as
// missing (e.g. `Property 'irProgramCallableCutoverEnabled' does not exist on
// type 'CodegenContext'`) while `tsc` stays green.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

describe("relative module augmentations are imported somewhere", () => {
  const files = tsFiles("src");
  const sources = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
  const augmenters = files.filter((f) => /^declare module ["']\./m.test(sources.get(f)!));

  it("finds the augmentation files", () => {
    expect(augmenters.length).toBeGreaterThan(0);
  });

  for (const file of augmenters) {
    it(file, () => {
      const spec = `/${basename(file, ".ts")}.js"`;
      const importers = files.filter((f) => f !== file && sources.get(f)!.includes(spec));
      expect(importers, `${file} is not imported by any src module`).not.toEqual([]);
    });
  }
});
