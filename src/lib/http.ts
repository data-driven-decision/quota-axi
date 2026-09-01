import { getProxyForUrl } from "proxy-from-env";
import type { Dispatcher } from "undici";

type ProviderRequestInit = RequestInit & { dispatcher?: Dispatcher };

const PROXY_DISPATCHERS = Symbol.for("quota-axi.proxy-dispatchers");
const sharedGlobals = globalThis as unknown as Record<symbol, unknown>;
const proxyDispatchers =
  (sharedGlobals[PROXY_DISPATCHERS] as
    | Map<string, Promise<Dispatcher>>
    | undefined) ?? new Map<string, Promise<Dispatcher>>();
sharedGlobals[PROXY_DISPATCHERS] = proxyDispatchers;

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function configuredProxyDispatcher(
  input: string | URL | Request,
): Promise<Dispatcher> | undefined {
  const proxyUrl = getProxyForUrl(requestUrl(input));
  if (!proxyUrl) return undefined;
  const existing = proxyDispatchers.get(proxyUrl);
  if (existing) return existing;
  const dispatcher = import("undici").then(
    ({ ProxyAgent }) => new ProxyAgent(proxyUrl),
  );
  proxyDispatchers.set(proxyUrl, dispatcher);
  return dispatcher;
}

/** Fetch through the host's standard proxy environment when one is configured. */
export async function providerFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const dispatcher = await configuredProxyDispatcher(input);
  return fetch(
    input,
    dispatcher ? ({ ...init, dispatcher } as ProviderRequestInit) : init,
  );
}
