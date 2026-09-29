import express from "express";
import path from "node:path";
import { apiRouter } from "../api/routes";
import { errorHandler } from "../api/error-handler";

/** Editor libraries are served from node_modules so the app works without a CDN. */
const VENDOR_MOUNTS: Array<[string, string]> = [
  ["/vendor/alpinejs", path.join("alpinejs", "dist")],
  ["/vendor/codemirror", "codemirror"],
  ["/vendor/katex", path.join("katex", "dist")],
  ["/vendor/mermaid", path.join("mermaid", "dist")],
  ["/vendor/d2", path.join("@terrastruct", "d2", "dist", "browser")],
];

export function createApp(): express.Express {
  const app = express();

  app.use(express.json({ limit: "2mb" }));

  app.use("/api/v1", apiRouter);

  const publicDir = path.resolve(process.cwd(), "public");
  const vendorDir = path.resolve(process.cwd(), "node_modules");

  for (const [route, sub] of VENDOR_MOUNTS) {
    app.use(route, express.static(path.join(vendorDir, sub), { index: false }));
  }

  // App shell and its own assets are edited constantly in this MVP: never cache them.
  app.use((req, res, next) => {
    if (req.path === "/" || req.path.startsWith("/assets")) res.set("Cache-Control", "no-store");
    next();
  });

  app.use(express.static(publicDir));
  app.get("/", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  app.use(errorHandler);

  return app;
}
