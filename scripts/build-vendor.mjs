import { build } from "esbuild";
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

// The Vercel Blob browser client only ships as CommonJS/ESM; bundle it as a
// global so the plain-HTML frontend can call `VercelBlob.upload(...)`.
await build({
  stdin: {
    contents: 'export * from "@vercel/blob/client";',
    resolveDir: root,
    sourcefile: "blob-entry.js",
  },
  bundle: true,
  format: "iife",
  globalName: "VercelBlob",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  outfile: path.join(outDir, "blob.js"),
  logLevel: "warning",
});

console.log("Built public/vendor/ably.js and public/vendor/blob.js");
