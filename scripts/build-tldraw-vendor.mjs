/**
 * Builds the self-contained ESM bundle for the whiteboard renderer.
 *
 * tldraw ships as bare-import ESM ("react", "@tldraw/*"), which browsers cannot
 * resolve directly, so we bundle it (plus react + react-dom) into one file under
 * public/vendor/tldraw/. The bundle is checked in; run `npm run build:vendor`
 * again after upgrading tldraw/react.
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(rootDir, "public", "vendor", "tldraw");
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "node_modules", "tldraw", "package.json"), "utf8"));

fs.mkdirSync(outDir, { recursive: true });
for (const file of fs.readdirSync(outDir)) {
  if (/^tldraw-.*\.mjs$/.test(file)) fs.rmSync(path.join(outDir, file));
}

const entry = [
  'export * from "tldraw";',
  'export { createRoot } from "react-dom/client";',
  'export { createElement, Fragment } from "react";',
  "",
].join("\n");

await build({
  stdin: { contents: entry, resolveDir: rootDir, sourcefile: "tldraw-vendor-entry.js", loader: "js" },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: path.join(outDir, `tldraw-${pkg.version}.mjs`),
});

await build({
  entryPoints: [path.join(rootDir, "node_modules", "tldraw", "tldraw.css")],
  outfile: path.join(outDir, "tldraw.css"),
  bundle: true,
  minify: true,
});

console.log(`tldraw vendor bundle ready: tldraw-${pkg.version}.mjs`);
