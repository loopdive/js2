// Instrument control only; never a production corpus row or retirement credit.
if (process.argv[2] === "pending") {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
} else {
  // Exported () -> () function whose body is loop { br 0 }.
  const bytes = Uint8Array.from([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 7, 1, 3, 114, 117, 110, 0, 0, 10, 9, 1, 7, 0, 3, 64,
    12, 0, 11, 11,
  ]);
  const { instance } = await WebAssembly.instantiate(bytes);
  instance.exports.run();
}
