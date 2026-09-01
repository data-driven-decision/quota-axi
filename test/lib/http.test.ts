import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerFetch } from "../../src/lib/http.js";

const originalHttpProxy = process.env.HTTP_PROXY;
const originalHttpProxyLower = process.env.http_proxy;
const originalHttpsProxy = process.env.HTTPS_PROXY;
const originalHttpsProxyLower = process.env.https_proxy;
const originalNoProxy = process.env.NO_PROXY;
const originalNoProxyLower = process.env.no_proxy;
const servers: Server[] = [];

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function listen(body: string): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => response.end(body));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function listenProxy(): Promise<{
  server: Server;
  url: string;
  connections: () => number;
}> {
  let connections = 0;
  const server = createServer();
  server.on("connect", (request, client, head) => {
    connections++;
    const [host, rawPort] = (request.url ?? "").split(":");
    const upstream = connect(Number(rawPort), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    connections: () => connections,
  };
}

async function listenRejectingProxy(): Promise<{
  server: Server;
  url: string;
  connections: () => number;
}> {
  let connections = 0;
  const server = createServer();
  server.on("connect", (_request, client) => {
    connections++;
    client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    connections: () => connections,
  };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function clearProxyEnvironment(): void {
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
  restoreEnvironment("HTTP_PROXY", originalHttpProxy);
  restoreEnvironment("http_proxy", originalHttpProxyLower);
  restoreEnvironment("HTTPS_PROXY", originalHttpsProxy);
  restoreEnvironment("https_proxy", originalHttpsProxyLower);
  restoreEnvironment("NO_PROXY", originalNoProxy);
  restoreEnvironment("no_proxy", originalNoProxyLower);
  vi.resetModules();
});

describe("providerFetch", () => {
  it.each(["HTTP_PROXY", "http_proxy"])(
    "routes HTTP requests through %s",
    async (variable) => {
      clearProxyEnvironment();
      const target = await listen("direct");
      const proxy = await listenProxy();
      process.env[variable] = proxy.url;
      const { providerFetch: fetchWithCurrentEnvironment } =
        await import("../../src/lib/http.js");

      const response = await fetchWithCurrentEnvironment(target.url);

      expect(await response.text()).toBe("direct");
      expect(proxy.connections()).toBe(1);
    },
  );

  it.each(["HTTPS_PROXY", "https_proxy"])(
    "routes HTTPS requests through %s",
    async (variable) => {
      clearProxyEnvironment();
      const proxy = await listenRejectingProxy();
      process.env[variable] = proxy.url;
      const { providerFetch: fetchWithCurrentEnvironment } =
        await import("../../src/lib/http.js");

      await expect(
        fetchWithCurrentEnvironment("https://quota-axi.invalid"),
      ).rejects.toThrow();
      expect(proxy.connections()).toBe(1);
    },
  );

  it.each(["NO_PROXY", "no_proxy"])(
    "bypasses the configured proxy for %s matches",
    async (variable) => {
      clearProxyEnvironment();
      const target = await listen("direct");
      const proxy = await listenProxy();
      process.env.HTTP_PROXY = proxy.url;
      process.env[variable] = "127.0.0.1";
      const { providerFetch: fetchWithCurrentEnvironment } =
        await import("../../src/lib/http.js");

      const response = await fetchWithCurrentEnvironment(target.url);

      expect(await response.text()).toBe("direct");
      expect(proxy.connections()).toBe(0);
    },
  );

  it("uses direct fetch when no proxy is configured", async () => {
    clearProxyEnvironment();
    const target = await listen("direct");

    const response = await providerFetch(target.url);

    expect(await response.text()).toBe("direct");
  });
});
