import { permissions } from "../src/lib/permissions.mjs";
if (!permissions.includes("admin.manage")) throw new Error("admin.manage permission missing");
console.log("Type contract smoke checks passed.");
