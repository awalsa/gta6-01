// Puerto Fuego — local play server.
//
// A development convenience, nothing more: it serves the static files in
// game/ on http://localhost:8080 so the game can be played in a browser
// without a build step. Run it with `node serve.ts` (add `--port 9000` to
// pick a different port). It binds to loopback only, never lists a
// directory, and never answers a path that escapes game/.

import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME_DIR = resolve(fileURLToPath(new URL('./game', import.meta.url)));

// --port N on the command line, otherwise 8080. Anything out of range or
// not a number falls back to the default instead of crashing the server.
function pickPort(): number {
  const flagAt = process.argv.indexOf('--port');
  const wanted = flagAt === -1 ? NaN : Number(process.argv[flagAt + 1]);
  return Number.isInteger(wanted) && wanted > 0 && wanted < 65536 ? wanted : 8080;
}

// The MIME types a browser game needs. Unknown extensions get a generic
// binary type rather than being guessed at.
const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

// Turn a request path into an absolute file inside game/, or null when the
// path is malformed or tries to climb out of the game folder. A trailing
// slash (or the bare root) means the folder's index page.
function resolveGameFile(rawPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.endsWith('/')) decoded += 'index.html';
  const candidate = resolve(join(GAME_DIR, decoded));
  if (candidate !== GAME_DIR && !candidate.startsWith(GAME_DIR + sep)) return null;
  return candidate;
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  const file = resolveGameFile(pathname);
  if (file === null) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request\n');
    return;
  }
  let body: Buffer;
  try {
    if (!statSync(file).isFile()) throw new Error('not a file');
    body = readFileSync(file);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
});

const port = pickPort();
server.listen(port, '127.0.0.1', () => {
  console.log(`Puerto Fuego is live at http://localhost:${port} (serving game/)`);
});
