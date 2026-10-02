/**
 * Tests never talk to real third-party services (AI provider, GitHub, Slack...): any
 * `fetch` to a host other than this machine fails loudly. Fakes listen on localhost.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const realFetch = globalThis.fetch;

export class ExternalHttpBlockedError extends Error {}

globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!LOCAL_HOSTS.has(url.hostname)) {
    return Promise.reject(
      new ExternalHttpBlockedError(`External HTTP is blocked in tests: ${url.host}`),
    );
  }
  return realFetch(input, init);
};
