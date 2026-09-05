import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `npm-compat-refresh.yml` runs `node scripts/merge-npm-compat-partials.mjs`
// under PLAIN node — no tsx, no vitest resolver — and that script imports
// scripts/lib/es-edition.mjs. A `.js` specifier pointing into src/ resolves
// only under tsx/vitest (which map `.js` to the `.ts` source); plain node
// throws ERR_MODULE_NOT_FOUND. That is exactly how every refresh run failed
// from 2026-09-03 (#5279 landed `../../src/ts-api.js`) until the specifier was
// corrected to `.ts`, leaving the bot's artifact PR two days stale with green
// CI everywhere else. This pin loads the module the way the workflow does.
describe("scripts/lib/es-edition.mjs loads under plain node", () => {
  it("imports without tsx or vitest resolution", () => {
    const mod = fileURLToPath(new URL("../scripts/lib/es-edition.mjs", import.meta.url));
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(mod)}); console.log("ok");`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(out.trim()).toBe("ok");
  });
});
