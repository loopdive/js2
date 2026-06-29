async function drain(stream) {
  for await (const chunk of stream) {
    process(chunk);
  }
}
