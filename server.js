#!/usr/bin/env node
/**
 * Minimal Node server to host index.html on http://localhost:8000
 *
 * Run:
 *   node server.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 8000;
const INDEX_PATH = path.join(__dirname, "index.html");
const DAPPS_PATH = path.join(__dirname, "dapps.json");

function send(res, statusCode, headers, body) {
  res.writeHead(statusCode, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, { "content-type": "text/plain" }, "Method Not Allowed");
  }

  const pathname = (() => {
    try {
      return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
        .pathname;
    } catch (_) {
      return req.url || "/";
    }
  })();

  if (pathname === "/dapps.json") {
    return fs.readFile(DAPPS_PATH, (err, buf) => {
      if (err) {
        return send(
          res,
          500,
          { "content-type": "text/plain" },
          `Failed to read dapps.json: ${err.message}\n`
        );
      }

      if (req.method === "HEAD") {
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-length": buf.length,
          "cache-control": "no-store",
        });
        return res.end();
      }

      return send(
        res,
        200,
        {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
        buf
      );
    });
  }

  fs.readFile(INDEX_PATH, (err, buf) => {
    if (err) {
      return send(
        res,
        500,
        { "content-type": "text/plain" },
        `Failed to read index.html: ${err.message}\n`
      );
    }

    if (req.method === "HEAD") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": buf.length,
        "cache-control": "no-store",
      });
      return res.end();
    }

    return send(
      res,
      200,
      {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
      buf
    );
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Serving ${INDEX_PATH}`);
  console.log(`Listening on http://localhost:${PORT}`);
});

