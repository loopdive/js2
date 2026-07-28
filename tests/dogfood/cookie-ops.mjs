// Shared op list for the cookie dogfood harness (#3751).
//
// Unlike clsx (#3748), cookie's four exports (parseCookie, stringifyCookie,
// stringifySetCookie, parseSetCookie) are all fixed-arity with real declared
// parameters — no driver-epilogue shim is needed. Each op just names the
// export and the literal arguments to call it with; the harness calls
// `compiledExports[op.fn](...op.args)` and `nativeModule[op.fn](...op.args)`
// directly and diffs the (JSON-normalized) results, so there is no separate
// "oracle op" to accidentally write differently from the "compiled op" — the
// SAME args array drives both sides.
export const COOKIE_OPS = [
  { name: "parseCookie_basic", fn: "parseCookie", args: ["foo=bar; baz=qux"] },
  { name: "parseCookie_empty", fn: "parseCookie", args: [""] },
  { name: "parseCookie_single", fn: "parseCookie", args: ["a=1"] },
  { name: "parseCookie_whitespace", fn: "parseCookie", args: ["  foo=bar ;  baz = qux  "] },
  { name: "parseCookie_percent_encoded", fn: "parseCookie", args: ["foo=hello%20world"] },
  { name: "parseCookie_duplicate_keys", fn: "parseCookie", args: ["a=1; a=2"] },
  { name: "parseCookie_no_value", fn: "parseCookie", args: ["foo"] },
  { name: "stringifyCookie_basic", fn: "stringifyCookie", args: [{ foo: "bar", baz: "qux" }] },
  { name: "stringifyCookie_single", fn: "stringifyCookie", args: [{ a: "1" }] },
  { name: "stringifyCookie_invalid_name", fn: "stringifyCookie", args: [{ "foo bar": "baz" }] },
  { name: "stringifySetCookie_basic", fn: "stringifySetCookie", args: [{ name: "foo", value: "bar" }] },
  {
    name: "stringifySetCookie_httponly_secure",
    fn: "stringifySetCookie",
    args: [{ name: "foo", value: "bar", httpOnly: true, secure: true }],
  },
  {
    name: "stringifySetCookie_path_domain",
    fn: "stringifySetCookie",
    args: [{ name: "foo", value: "bar", path: "/", domain: "example.com" }],
  },
  { name: "stringifySetCookie_maxage", fn: "stringifySetCookie", args: [{ name: "foo", value: "bar", maxAge: 3600 }] },
  {
    name: "stringifySetCookie_samesite_lax",
    fn: "stringifySetCookie",
    args: [{ name: "foo", value: "bar", sameSite: "lax" }],
  },
  {
    name: "stringifySetCookie_priority_high",
    fn: "stringifySetCookie",
    args: [{ name: "foo", value: "bar", priority: "high" }],
  },
  { name: "stringifySetCookie_invalid_name", fn: "stringifySetCookie", args: [{ name: "foo bar", value: "baz" }] },
  { name: "parseSetCookie_no_attrs", fn: "parseSetCookie", args: ["foo=bar"] },
  // Known-red per #3750: parseSetCookie silently drops attributes assigned
  // dynamically onto the cookie object inside the attribute-parsing loop.
  { name: "parseSetCookie_httponly", fn: "parseSetCookie", args: ["foo=bar; HttpOnly"] },
  { name: "parseSetCookie_path", fn: "parseSetCookie", args: ["foo=bar; Path=/"] },
  {
    name: "parseSetCookie_multiple_attrs",
    fn: "parseSetCookie",
    args: ["foo=bar; HttpOnly; Secure; Path=/; Domain=example.com"],
  },
];
