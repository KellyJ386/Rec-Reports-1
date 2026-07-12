import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const root = process.argv[2] ?? "src/public";
const port = Number(process.env.PORT ?? 3000);
const contentTypes = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

// Serves nested directories (e.g. src/public/admin/js/api.js) directly via
// path.join, and resolves a directory request (e.g. /admin or /admin/) to
// its index.html so client-side-routed sub-apps under src/public work the
// same way "/" does.
function resolveFilePath(requestedPath) {
  let filePath = join(root, requestedPath === "/" ? "index.html" : requestedPath);
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, "index.html");
  }
  return filePath;
}

createServer((request, response) => {
  const requestedPath = normalize(new URL(request.url ?? "/", `http://localhost:${port}`).pathname);
  if (requestedPath.includes("..")) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  const filePath = resolveFilePath(requestedPath);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  response.writeHead(200, { "content-type": contentTypes[extname(filePath)] ?? "text/plain" });
  createReadStream(filePath).pipe(response);
}).listen(port, () => console.log(`Rec Reports available at http://localhost:${port}`));
