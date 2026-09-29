import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

/**
 * Optional native search layer: a napi-rs module (search-native <- Tantivy)
 * acting as a secondary index. SQLite/FTS5 stays the source of truth; this only
 * adds typo/prefix-tolerant object ids that join the existing candidate pool.
 *
 * When the .node module is missing (or NT_NATIVE_SEARCH=0) every call here is a
 * no-op so the FTS5 pipeline keeps working unchanged.
 */

export interface NativeDocInput {
  id: string;
  title: string;
  body: string;
  tags: string;
}

export interface NativeHit {
  id: string;
  score: number;
}

interface NativeModule {
  initIndex(dir: string): void;
  indexAdd(docs: NativeDocInput[]): number;
  indexDelete(ids: string[]): number;
  indexSearch(query: string, limit?: number): NativeHit[];
  indexCount(): number;
}

const CANDIDATES = [
  "search-native.node",
  "search-native.win32-x64-msvc.node",
  "search-native.linux-x64-gnu.node",
  "search-native.darwin-x64.node",
  "search-native.darwin-arm64.node",
];

/** Index directory relative to the repo root (not part of the app schema). */
export function nativeIndexDir(): string {
  return process.env.NT_TANTIVY_DIR || path.resolve("data", "tantivy");
}

function resolveNativeModule(): NativeModule | null {
  if (process.env.NT_NATIVE_SEARCH === "0") return null;
  const dir = path.resolve("search-native");
  const present = CANDIDATES.map((n) => path.join(dir, n)).filter((p) => fs.existsSync(p));
  if (present.length === 0) return null; // not built — keep FTS5, silently
  try {
    const require = createRequire(path.join(process.cwd(), "package.json"));
    return require(present[0]) as NativeModule;
  } catch (e) {
    console.warn("[native-search] failed to load .node:", (e as Error).message);
    return null;
  }
}

export class NativeSearchIndex {
  constructor(private mod: NativeModule) {}

  init(dir: string): void {
    this.mod.initIndex(dir);
  }

  add(docs: NativeDocInput[]): number {
    if (docs.length === 0) return 0;
    try {
      return this.mod.indexAdd(docs);
    } catch {
      return 0; // never break the FTS path
    }
  }

  remove(ids: string[]): number {
    if (ids.length === 0) return 0;
    try {
      return this.mod.indexDelete(ids);
    } catch {
      return 0;
    }
  }

  search(query: string, limit?: number): NativeHit[] {
    try {
      return this.mod.indexSearch(query, limit) ?? [];
    } catch {
      return [];
    }
  }

  count(): number {
    try {
      return this.mod.indexCount();
    } catch {
      return 0;
    }
  }
}

let cached: NativeSearchIndex | null | undefined;

/** Singleton; null when the native module is unavailable or disabled. */
export function getNativeSearch(): NativeSearchIndex | null {
  if (cached === undefined) {
    const mod = resolveNativeModule();
    cached = mod ? new NativeSearchIndex(mod) : null;
  }
  return cached;
}