"use strict";

const http = require("http");
const { BookingStore, HttpError } = require("./store");

const MAX_BODY_BYTES = 16 * 1024;

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function createServer(store = new BookingStore()) {
  const routes = [
    ["POST", /^\/experiences$/, (req, m, url) => readJson(req).then((b) => [201, store.createExperience(b)])],
    ["GET", /^\/experiences$/, (req, m, url) => [200, store.listExperiences(url.searchParams.get("operatorId"))]],
    ["POST", /^\/experiences\/([^/]+)\/slots$/, (req, m) => readJson(req).then((b) => [201, store.createSlot(m[1], b)])],
    ["GET", /^\/experiences\/([^/]+)\/slots$/, (req, m) => [200, store.listSlots(m[1])]],
    ["POST", /^\/slots\/([^/]+)\/bookings$/, (req, m) => readJson(req).then((b) => [201, store.book(m[1], b)])],
    ["GET", /^\/slots\/([^/]+)\/bookings$/, (req, m) => [200, store.listBookings(m[1])]],
    ["POST", /^\/bookings\/([^/]+)\/cancel$/, (req, m) => [200, store.cancel(m[1])]],
  ];

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      let matched = false;
      for (const [method, pattern, handler] of routes) {
        const m = url.pathname.match(pattern);
        if (!m) continue;
        matched = true;
        if (req.method !== method) continue;
        const [status, body] = await handler(req, m, url);
        return send(res, status, body);
      }
      send(res, matched ? 405 : 404, { error: matched ? "method not allowed" : "not found" });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: "internal error" });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => console.log(`OkGhumo booking API prototype on http://localhost:${port}`));
}

module.exports = { createServer };
