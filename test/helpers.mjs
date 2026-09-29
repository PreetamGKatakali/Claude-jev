import http from "node:http";

/**
 * One request, one socket, closed on response.
 *
 * `fetch` keeps its connection pool alive, which keeps the event loop busy after the last
 * assertion and leaves the test runner hanging with every test already passed. Going
 * through `node:http` with `agent: false` avoids that and lets a test read the exact bytes
 * and headers that crossed the wire.
 */
export function request(port, path, { method = "GET", headers = {}, body } = {}) {
  const payload = body === undefined ? null : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        agent: false,
        headers: {
          ...headers,
          ...(payload ? { "content-length": String(payload.length) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json: () => JSON.parse(text),
          });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Collects a whole request body. */
export const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });

export const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
