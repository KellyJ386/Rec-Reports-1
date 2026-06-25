import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const root = process.argv[2] ?? "src/public";
const port = Number(process.env.PORT ?? 3000);
const contentTypes = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

createServer((request, response) => {
  const requestedPath = normalize(new URL(request.url ?? "/", `http://localhost:${port}`).pathname);
  const filePath = join(root, requestedPath === "/" ? "index.html" : requestedPath);
  if (!existsSync(filePath)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  response.writeHead(200, { "content-type": contentTypes[extname(filePath)] ?? "text/plain" });
  createReadStream(filePath).pipe(response);
}).listen(port, () => console.log(`Rec Reports available at http://localhost:${port}`));
