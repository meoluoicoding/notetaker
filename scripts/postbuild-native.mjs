// Copies the cdylib produced by `cargo build` into a loadable .node module.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = path.join(root, "search-native", "target", "release");
const candidates = [
  "search_native.dll", // windows-msvc
  "libsearch_native.so", // linux-gnu
  "libsearch_native.dylib", // darwin
];
const src = candidates.map((f) => path.join(release, f)).find((p) => existsSync(p));
if (!src) {
  console.error("native build artifact not found in", release);
  process.exit(1);
}
const out = path.join(root, "search-native", "search-native.node");
mkdirSync(path.dirname(out), { recursive: true });
cpSync(src, out);
console.log("native module:", path.relative(root, out));