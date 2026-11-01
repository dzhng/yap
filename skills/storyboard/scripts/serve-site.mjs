import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { launchedAs } from "./storyboard-io.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json",
  ".css": "text/css",
};

/**
 * Serve a site directory read-only on 127.0.0.1. Port 0 lets the OS pick a free port. Binding the
 * IPv4 loopback explicitly matters: `localhost` can resolve to ::1, where another server may hold
 * the same port number.
 */
export function serveSite(directory, port = 0) {
  const root = resolve(directory);
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const file = resolve(join(root, path.endsWith("/") ? `${path}index.html` : path));
    try {
      if (file !== root && !file.startsWith(root + sep)) throw new Error("outside the site");
      if (!(await stat(file)).isFile()) throw new Error("not a file");
      response.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404).end("not found\n");
    }
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () =>
      done({ server, url: `http://127.0.0.1:${server.address().port}/` }),
    );
  });
}

if (launchedAs(import.meta.url, "serve-site.mjs")) {
  const [directory, flag, value] = process.argv.slice(2);
  if (!directory || directory === "--help") {
    console.log(
      'Usage: node serve-site.mjs SITE_DIR [--port N]\nServe the storyboard read-only on 127.0.0.1 (a free port by default) until stopped; prints {"url"}.',
    );
  } else {
    const { url } = await serveSite(directory, flag === "--port" ? Number(value) : 0);
    console.log(JSON.stringify({ url }));
  }
}
