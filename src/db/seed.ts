import { db, migrate } from "./client";
import { mulberry32 } from "./prng";
import { objectService } from "../services/object-service";
import { structureService } from "../services/structure-service";
import { spaceService } from "../services/space-service";
import { searchIndexService } from "../services/search-index-service";

const rand = mulberry32(42);
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const BOOK_TITLES = [
  "The Selfish Gene", "Sapiens", "Deep Work", "Thinking in Systems", "The Pragmatic Programmer",
  "Atomic Habits", "Zero to One", "The Design of Everyday Things", "Gödel, Escher, Bach", "Clean Architecture",
];
const PERSON_NAMES = [
  "Ada Lovelace", "Richard Feynman", "Marie Curie", "Alan Turing", "Grace Hopper",
  "Nikola Tesla", "Charles Darwin", "Katherine Johnson", "Edsger Dijkstra", "Barbara Liskov",
];
const TOPIC_NAMES = [
  "Rust Ownership", "Distributed Systems", "Machine Learning", "Product Design", "Behavioral Psychology",
  "Systems Thinking", "Type Theory", "Database Internals", "Networking", "Compilers",
  "UX Research", "Writing", "Economics", "History of Science", "Mathematics",
];
const PROJECT_NAMES = [
  "Notetaker MVP", "Personal Website", "Reading Tracker", "Learn Rust", "Home Automation",
];
const TAG_NAMES = [
  "rust", "programming", "systems", "design", "science", "productivity", "ai",
  "database", "reading", "writing", "math", "history",
];
const PARAGRAPH_TEXTS = [
  "Key insight: complexity should be pushed to the edges of the system.",
  "Note to self — revisit the chapter on recursion and graph traversal.",
  "The author argues that constraints improve creativity rather than limit it.",
  "Interesting parallel between memory management and knowledge management.",
  "Follow up: compare this approach with the one described in the other book.",
  "Idea: build a small prototype to validate the hypothesis before scaling.",
];

export async function seedDatabase(): Promise<{ structures: number; objects: number; links: number }> {
  await migrate();

  // Seed data lands in the oldest space (the one that owns pre-spaces data).
  const spaceId = await spaceService.defaultSpaceId();

  // Clear existing data (demo reset)
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("blocks").execute();
    await trx.deleteFrom("object_properties").execute();
    await trx.deleteFrom("object_tags").execute();
    await trx.deleteFrom("links").execute();
    await trx.deleteFrom("objects").execute();
    await trx.deleteFrom("property_definitions").execute();
    await trx.deleteFrom("tags").execute();
    await trx.deleteFrom("structures").execute();
    await trx.deleteFrom("search_index").execute();
  });

  // Structures
  const pageStruct = await structureService.createStructure({ spaceId, name: "Page", icon: "📄" });
  const bookStruct = await structureService.createStructure({
    spaceId,
    name: "Book", icon: "📚",
    properties: [
      { name: "author", type: "text" },
      { name: "year", type: "number" },
      { name: "rating", type: "number" },
    ],
  });
  const personStruct = await structureService.createStructure({ spaceId, name: "Person", icon: "🧑" });
  const topicStruct = await structureService.createStructure({ spaceId, name: "Topic", icon: "🏷️" });
  const projectStruct = await structureService.createStructure({
    spaceId,
    name: "Project", icon: "🚀",
    properties: [
      { name: "status", type: "select" },
      { name: "due", type: "date" },
    ],
  });

  const createdIds: { id: string; kind: "book" | "person" | "topic" | "project" | "page"; name: string }[] = [];

  // Books
  for (const title of BOOK_TITLES) {
    const obj = await objectService.createObject({
      spaceId,
      structureId: bookStruct.id,
      title,
      description: `Notes and highlights from "${title}".`,
      icon: "📚",
      properties: {
        author: pick(PERSON_NAMES),
        year: 1990 + Math.floor(rand() * 35),
        rating: 3 + Math.floor(rand() * 3),
      },
      tags: [pick(TAG_NAMES), pick(TAG_NAMES)].filter((v, i, a) => a.indexOf(v) === i),
      blocks: [
        { type: "heading", content: { level: 2, text: "Summary" } },
        { type: "paragraph", content: { text: pick(PARAGRAPH_TEXTS) } },
        { type: "heading", content: { level: 2, text: "Key Quotes" } },
        { type: "quote", content: { text: pick(PARAGRAPH_TEXTS) } },
        { type: "todo", content: { text: "Write a review", checked: rand() > 0.5 } },
      ],
    });
    createdIds.push({ id: obj.id, kind: "book", name: title });
  }

  // People
  for (const name of PERSON_NAMES) {
    const obj = await objectService.createObject({
      spaceId,
      structureId: personStruct.id,
      title: name,
      description: `Notes about ${name}.`,
      icon: "🧑",
      blocks: [
        { type: "paragraph", content: { text: `Research interests: ${pick(TOPIC_NAMES)}.` } },
      ],
    });
    createdIds.push({ id: obj.id, kind: "person", name });
  }

  // Topics
  for (const name of TOPIC_NAMES) {
    const obj = await objectService.createObject({
      spaceId,
      structureId: topicStruct.id,
      title: name,
      description: `Everything related to ${name}.`,
      icon: "🏷️",
      tags: [pick(TAG_NAMES)],
      blocks: [
        { type: "paragraph", content: { text: `Starting point for ${name}: ${pick(PARAGRAPH_TEXTS)}` } },
        { type: "todo", content: { text: `Collect more resources on ${name}`, checked: false } },
      ],
    });
    createdIds.push({ id: obj.id, kind: "topic", name });
  }

  // Projects
  for (const name of PROJECT_NAMES) {
    const obj = await objectService.createObject({
      spaceId,
      structureId: projectStruct.id,
      title: name,
      description: `Project: ${name}`,
      icon: "🚀",
      properties: {
        status: pick(["active", "paused", "done"]),
        due: `2026-${String(1 + Math.floor(rand() * 12)).padStart(2, "0")}-15`,
      },
      blocks: [
        { type: "heading", content: { level: 2, text: "Next steps" } },
        { type: "todo", content: { text: pick(PARAGRAPH_TEXTS), checked: false } },
        { type: "todo", content: { text: pick(PARAGRAPH_TEXTS), checked: rand() > 0.5 } },
      ],
    });
    createdIds.push({ id: obj.id, kind: "project", name });
  }

  // Pages
  for (const i of range(10)) {
    const title = `Weekly Note #${i + 1}`;
    const obj = await objectService.createObject({
      spaceId,
      structureId: pageStruct.id,
      title,
      icon: "📄",
      blocks: range(3).map(() => ({
        type: "paragraph" as const,
        content: { text: pick(PARAGRAPH_TEXTS) },
      })),
    });
    createdIds.push({ id: obj.id, kind: "page", name: title });
  }

  // Deterministic link graph: book→person (authored_by), book→topic (discusses), project→person, page→topic/book
  let linkCount = 0;
  const books = createdIds.filter((o) => o.kind === "book");
  const people = createdIds.filter((o) => o.kind === "person");
  const topics = createdIds.filter((o) => o.kind === "topic");
  const projects = createdIds.filter((o) => o.kind === "project");
  const pages = createdIds.filter((o) => o.kind === "page");

  for (const book of books) {
    await objectService.createLink(book.id, pick(people).id, "authored_by");
    linkCount++;
    await objectService.createLink(book.id, pick(topics).id, "discusses");
    linkCount++;
  }
  for (const project of projects) {
    await objectService.createLink(project.id, pick(people).id, "owner");
    linkCount++;
  }
  for (const page of pages) {
    const target = rand() > 0.5 ? pick(topics) : pick(books);
    await objectService.createLink(page.id, target.id, "references");
    linkCount++;
  }

  const counts = {
    structures: 5,
    objects: createdIds.length,
    links: linkCount,
  };
  await searchIndexService.reindexAll();
  console.log("seeded", counts);
  return counts;
}

// CLI entry: npm run seed
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  seedDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
