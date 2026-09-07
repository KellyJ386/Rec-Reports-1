import { cp, mkdir, rm } from "node:fs/promises";

// Optional destination directory (test/build-user-app.test.mjs builds into a
// temp dir so it can run alongside test/build-admin.test.mjs -- which builds
// into the default "dist" -- without both tests racing to rm/mkdir/cp the
// same directory at once). `npm run build` passes no argument and keeps
// building into "dist", unchanged.
const destination = process.argv[2] || "dist";

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp("src/public", destination, { recursive: true });
console.log(`Built static Rec Reports app into ${destination}/.`);
