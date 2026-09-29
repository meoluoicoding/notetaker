/**
 * Standalone verification for the whiteboard block (run: node scripts/verify-whiteboard.mjs)
 * Spins up an isolated server (own port + throwaway SQLite), drives Chromium
 * through the real UI: insert whiteboard block, draw, verify the snapshot is
 * PATCHed, reload, and check the drawing is restored.
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3499;
const BASE = `http://localhost:${PORT}`;
const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nt-wb-")), "verify.db");

const results = [];
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!ok) process.exitCode = 1;
};

// start the server with an isolated db
const server = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(server, ["run", "dev"], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), DB_PATH: tmpDb },
  stdio: ["ignore", "pipe", "pipe"],
  shell: process.platform === "win32",
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) return;
    } catch {}
    await wait(1000);
  }
  throw new Error("server did not start");
}

try {
  await waitForServer();

  // seed an object with a whiteboard block through the API
  const structures = (await (await fetch(`${BASE}/api/v1/structures`)).json()).data;
  const page = structures.find((s) => s.slug === "page") ?? structures[0];
  const created = await (
    await fetch(`${BASE}/api/v1/objects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ structureId: page.id, title: "WB verify", blocks: [{ type: "paragraph", content: { text: "" } }] }),
    })
  ).json();
  const objectId = created.data.id;
  const wbBlock = (
    await (
      await fetch(`${BASE}/api/v1/objects/${objectId}/blocks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "whiteboard", content: { snapshot: null } }),
      })
    ).json()
  ).data;

  const browser = await chromium.launch();
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page2 = await context.newPage();
  page2.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  await page2.goto(BASE);
  await page2.waitForTimeout(1000);
  await page2.evaluate((id) => Alpine.$data(document.querySelector("[x-data]")).openObject(id), objectId);
  await page2.waitForTimeout(6000); // tldraw bundle + editor mount

  const mounted = await page2.evaluate(() => !!document.querySelector(".b-whiteboard .tl-container"));
  check("whiteboard mounts the tldraw editor", mounted);

  // draw: focus canvas, activate draw tool with the D shortcut, drag a stroke
  const canvas = page2.locator(".tldraw-canvas").first();
  const box = await canvas.boundingBox();
  await page2.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page2.keyboard.press("d");
  await page2.waitForTimeout(300);
  await page2.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.45);
  await page2.mouse.down();
  for (let i = 0; i <= 20; i++) {
    await page2.mouse.move(box.x + box.width * 0.3 + i * (box.width * 0.02), box.y + box.height * 0.45 + Math.sin(i / 3) * 35);
    await page2.waitForTimeout(15);
  }
  await page2.mouse.up();
  await page2.waitForTimeout(700);

  const shapeCountInDom = await page2.evaluate(() => document.querySelectorAll(".b-whiteboard svg path").length);
  check("drawing creates a shape in the canvas", shapeCountInDom > 0, `${shapeCountInDom} path(s)`);

  await wait(1500); // debounce 800ms + PATCH roundtrip
  const saved = await (await fetch(`${BASE}/api/v1/objects/${objectId}/blocks`)).json();
  const wbAfter = saved.data.find((b) => b.id === wbBlock.id);
  const records = wbAfter?.content?.snapshot?.document?.store?.records ?? [];
  const drawShapes = records.filter((r) => r.typeName === "shape" && r.type === "draw");
  check("snapshot persisted through the blocks API", drawShapes.length > 0, `${drawShapes.length} draw shape(s)`);

  // reload and confirm the drawing is restored
  await page2.reload();
  await page2.waitForTimeout(1200);
  await page2.evaluate((id) => Alpine.$data(document.querySelector("[x-data]")).openObject(id), objectId);
  await page2.waitForTimeout(6000);
  const restored = await page2.evaluate(() => document.querySelectorAll(".b-whiteboard svg path").length);
  check("drawing is restored after reload", restored > 0, `${restored} path(s)`);

  await browser.close();
} finally {
  child.kill();
  fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
}
