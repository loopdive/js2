/**
 * Shared ?mode= / ?edition= URL state for the two conformance surfaces
 * (website/index.html and website/public/benchmarks/report.html).
 *
 * Both pages show the same two knobs — the JS-host/standalone lane and the ES
 * edition scope — so a link should be able to carry them:
 *
 *   /?mode=standalone&edition=ES2015
 *   /benchmarks/report.html?mode=standalone&edition=ES2020
 *
 * Loaded as a plain (non-module) script so page inline scripts can call it
 * synchronously; it attaches `window.t262ViewState`.
 *
 * The edition value is whatever scope string the <t262-edition-timeline>
 * itself uses ("overall", "overall+proposal", "ES2015", "ES3 / Core", …), so a
 * URL round-trips exactly. Callers MUST validate an incoming edition against
 * the timeline's own scope map before applying it — an unknown scope would
 * otherwise leave the slider showing a selection nothing else honours.
 */
(function attachT262ViewState(global) {
  const MODE_PARAM = "mode";
  const EDITION_PARAM = "edition";
  const VALID_MODES = new Set(["host", "standalone"]);

  const params = () => {
    try {
      return new URLSearchParams(global.location?.search || "");
    } catch {
      return new URLSearchParams("");
    }
  };

  /** Reads the URL knobs. Missing/invalid values come back as null, never a guess. */
  const read = () => {
    const search = params();
    const rawMode = (search.get(MODE_PARAM) || "").trim().toLowerCase();
    const rawEdition = (search.get(EDITION_PARAM) || "").trim();
    return {
      mode: VALID_MODES.has(rawMode) ? rawMode : null,
      edition: rawEdition || null,
    };
  };

  /**
   * Writes the knobs back with replaceState — the page's own toggles are not
   * navigation, so they must not stack history entries the Back button then
   * has to unwind one edition at a time.
   *
   * `mode: "standalone"` and `edition: "overall"` are the DEFAULTS on both
   * pages and are dropped from the URL rather than written out, so the common
   * case stays a clean link and a shared URL only ever names what differs. The
   * mode default follows the pages: standalone (pure Wasm) is the lane both
   * surfaces open on, so `?mode=host` is the explicit opt-in.
   */
  const write = ({ mode, edition } = {}) => {
    const search = params();
    if (mode === "host") search.set(MODE_PARAM, "host");
    else if (mode === "standalone") search.delete(MODE_PARAM);

    if (typeof edition === "string" && edition && edition !== "overall") search.set(EDITION_PARAM, edition);
    else if (edition === "overall" || edition === null) search.delete(EDITION_PARAM);

    const query = search.toString();
    const next = `${global.location.pathname}${query ? `?${query}` : ""}${global.location.hash || ""}`;
    try {
      global.history.replaceState(global.history.state, "", next);
    } catch {
      // Non-browser / sandboxed context (file:// in some engines) — the knobs
      // still work, they just don't survive a reload.
    }
  };

  /**
   * Builds a link to the OTHER conformance surface carrying this view — both
   * pages read the same two params, so following the link keeps the lane and
   * edition the reader is looking at. Defaults are dropped, same as write().
   */
  const linkTo = (href, { mode, edition } = {}) => {
    const search = new URLSearchParams();
    if (mode === "host") search.set(MODE_PARAM, "host");
    if (typeof edition === "string" && edition && edition !== "overall") search.set(EDITION_PARAM, edition);
    const query = search.toString();
    return query ? `${href}?${query}` : href;
  };

  global.t262ViewState = { read, write, linkTo };
})(typeof window !== "undefined" ? window : globalThis);
