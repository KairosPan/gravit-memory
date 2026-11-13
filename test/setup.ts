// The suite runs with the network refused to every host but 127.0.0.1.
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "127.0.0.1") throw new Error(`network refused in tests: ${url.host}`);
  return realFetch(input, init);
}) as typeof fetch;
