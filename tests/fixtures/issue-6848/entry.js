// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Untyped JS on purpose (#6848): `form` comes from `Object.create(null)`, so it
// is typed `any`, which makes every callback below that captures it NOT
// "lane safe" for the native reference-element HOF lowering (#4728). That
// decline must reach a host call, not the graceful drop.

function makeForm() {
  const form = Object.create(null);
  form["obj.key1"] = "v1";
  form["obj.key2"] = "v2";
  form.x = "y";
  return form;
}

// hono `convertFormDataToBodyData({ dot: true })`, reduced.
export function forEachRewritesKeys() {
  const form = makeForm();
  Object.entries(form).forEach(([key, value]) => {
    if (key.includes(".")) {
      const parts = key.split(".");
      if (form[parts[0]] === undefined) form[parts[0]] = Object.create(null);
      form[parts[0]][parts[1]] = value;
      delete form[key];
    }
  });
  return JSON.stringify(form);
}

export function filterReadsCapture() {
  const form = makeForm();
  const kept = Object.entries(form).filter(([key]) => form[key] === "y");
  return kept.length + ":" + kept[0][0];
}

export function someAndEvery() {
  const form = makeForm();
  const some = Object.entries(form).some(([key]) => form[key] === "v2");
  const every = Object.entries(form).every(([key]) => form[key] === "v2");
  return String(some) + "," + String(every);
}

export function reduceFoldsCapture() {
  const form = makeForm();
  return Object.entries(form).reduce((acc, [key]) => acc + form[key].length, 0);
}
