/**
 * Shared helpers for the e2e suite.
 *
 * Setup goes through the API (creating objects, seeding renderer blocks) and
 * the real DOM is driven through Playwright. The API is the source of truth:
 * a DOM that renders beautifully while the database never gets the edit is a
 * failing test, not a passing one.
 */

import { expect, type Page, type APIRequestContext } from "@playwright/test";

export const API = "/api/v1";

/** POST/GET helper that throws on a non-2xx response and returns body.data. */
export async function api<T = unknown>(
  request: APIRequestContext,
  path: string,
  options: { method?: "GET" | "POST" | "PATCH" | "DELETE"; data?: unknown } = {},
): Promise<T> {
  const res = await request.fetch(`${API}${path}`, {
    method: options.method ?? "GET",
    data: options.data ? JSON.stringify(options.data) : undefined,
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok()) throw new Error(`${options.method ?? "GET"} ${path} -> ${res.status()}: ${await res.text()}`);
  const body = await res.json();
  return body.data as T;
}

/** First space id — the app sends X-Space-Id on every request. */
export async function firstSpaceId(request: APIRequestContext): Promise<string> {
  const spaces = await api<{ id: string }[]>(request, "/spaces");
  if (!spaces.length) throw new Error("no spaces exist; the server did not seed");
  return spaces[0].id;
}

/** The "Page" structure id of the given space (created when a space is created). */
export async function pageStructureId(request: APIRequestContext, spaceId: string): Promise<string> {
  const structures = await api<{ id: string; slug: string }[]>(request, "/structures");
  const page = structures.find((s) => s.slug === "page") ?? structures[0];
  if (!page) throw new Error("no structures in space");
  void spaceId;
  return page.id;
}

export interface BlockInput {
  type: string;
  content: Record<string, unknown>;
  position?: number;
  parentId?: string | null;
}

/** Create an object whose blocks are set up in one API call. */
export async function createObject(
  request: APIRequestContext,
  spaceId: string,
  structureId: string,
  input: { title: string; blocks?: BlockInput[] },
): Promise<{ id: string }> {
  return api<{ id: string }>(request, "/objects", {
    method: "POST",
    data: { spaceId, structureId, title: input.title, blocks: input.blocks ?? [] },
  });
}

/** Create one block under an object. */
export async function createBlock(
  request: APIRequestContext,
  objectId: string,
  input: BlockInput,
): Promise<string> {
  return api<{ id: string }>(request, `/objects/${objectId}/blocks`, {
    method: "POST",
    data: input,
  }).then((b) => b.id);
}

/**
 * Read a block back from the API, not from the DOM. A test that only reads the
 * DOM proves the UI rendered; a test that reads the API proves the edit stuck.
 */
export async function readBlock(
  request: APIRequestContext,
  objectId: string,
  blockId: string,
): Promise<{ type: string; content: Record<string, unknown> }> {
  const blocks = await api<Array<{ id: string; type: string; content: Record<string, unknown> }>>(
    request,
    `/objects/${objectId}/blocks`,
  );
  const hit = blocks.find((b) => b.id === blockId);
  if (!hit) throw new Error(`block ${blockId} not found on object ${objectId}`);
  return { type: hit.type, content: hit.content };
}

/**
 * The app renders blocks inside `[data-block-id]` wrappers. Renderer blocks
 * (code / math / mermaid) mount asynchronously, so wait for the host element
 * rather than assuming it exists right after navigation.
 */
export function blockLocator(page: Page, blockId: string) {
  return page.locator(`[data-block-id="${blockId}"]`);
}

/** Open an object by id through the app's own navigation (not a URL hack). */
export async function openObject(page: Page, objectId: string): Promise<void> {
  await page.evaluate((id) => window.Alpine.$data(document.querySelector("[x-data]")!).openObject(id), objectId);
  await expectEditorReady(page);
}

/** The editor pane is shown and its block list rendered. */
export async function expectEditorReady(page: Page): Promise<void> {
  // the list view and the editor view are both `.content`; only the editor one
  // holds a block list
  await page.waitForSelector(".block-list [data-block-id]");
  await expect(page.locator(".page-title")).toBeVisible();
}

/** Create a brand-new empty paragraph: the only state the slash menu accepts. */
export async function appendEmptyParagraph(page: Page, request: APIRequestContext, objectId: string): Promise<string> {
  const id = await createBlock(request, objectId, { type: "paragraph", content: { text: "" } });
  // the live editor holds its own copy of the block list; reload it
  await page.evaluate((oid) => window.Alpine.$data(document.querySelector("[x-data]")!).openObject(oid), objectId);
  await expectEditorReady(page);
  return id;
}
