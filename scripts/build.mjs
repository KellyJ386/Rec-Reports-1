import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("src/public", "dist", { recursive: true });
console.log("Built static Rec Reports app into dist/.");
