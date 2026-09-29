// Production build: bundle src/server/server.ts into a single ESM artifact.
// node_modules imports stay external (better-sqlite3 is a native module), so
// `node dist/index.mjs` + static serving from process.cwd() work as in dev.
import { rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/server/server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: "dist/index.mjs",
  sourcemap: true,
  logLevel: "info",
});

console.log("built dist/index.mjs");