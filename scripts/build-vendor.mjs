import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "public", "vendor");

await mkdir(outDir, { recursive: true });

// Ably ships a ready-to-use browser UMD bundle that exposes `window.Ably`.
await copyFile(
  path.join(root, "node_modules", "ably", "build", "ably.min.js"),
  path.join(outDir, "ably.js"),
);

console.log("Built public/vendor/ably.js");
