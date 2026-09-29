//! Notetaker's native search layer (napi-rs -> Tantivy).
//!
//! SQLite stays the source of truth: this crate is only a secondary index that
//! answers "which object ids match this query". Match classification, space /
//! structure / tag filtering, ranking and snippets stay in the TS services, so
//! the API surface and schema are unchanged. The index lives on disk under
//! `data/tantivy` and can be rebuilt from the DB at any time.
//!
//! The query is an AND of terms; each term must match any of title / body /
//! tags via a regex-prefix query (the FTS5-style behaviour the app already has)
//! OR a fuzzy term (edits <= 1, transpositions allowed) so typos still hit.
//! Title and tags are boosted over body text, mirroring the service ranking.

use napi_derive::napi;
use std::path::Path;
use std::sync::RwLock;
use tantivy::collector::TopDocs;
use tantivy::query::{AllQuery, BooleanQuery, BoostQuery, FuzzyTermQuery, Occur, Query, RegexQuery};
use tantivy::schema::{Field, IndexRecordOption, Schema, TextFieldIndexing, TextOptions, Value};
use tantivy::{DocAddress, Index, IndexWriter, TantivyDocument, Term};

const OBJECT_ID: &str = "object_id";
const TITLE: &str = "title";
const BODY: &str = "body";
const TAGS: &str = "tags";

struct Runtime {
  index: Index,
  object_id: Field,
  title: Field,
  body: Field,
  tags: Field,
}

static RUNTIME: RwLock<Option<Runtime>> = RwLock::new(None);

fn lock() -> Result<std::sync::RwLockReadGuard<'static, Option<Runtime>>, napi::Error> {
  use std::sync::PoisonError;
  RUNTIME
    .read()
    .map_err(|_: PoisonError<_>| napi::Error::from_reason("napi search lock poisoned"))
}

fn lock_mut() -> Result<std::sync::RwLockWriteGuard<'static, Option<Runtime>>, napi::Error> {
  use std::sync::PoisonError;
  RUNTIME
    .write()
    .map_err(|_: PoisonError<_>| napi::Error::from_reason("napi search lock poisoned"))
}

fn schema() -> Schema {
  let mut b = Schema::builder();
  // object_id is not searched; it exists for delete-by-id, so it uses the "raw"
  // tokenizer (exact string, never split on "-") with indexing enabled.
  b.add_text_field(
    OBJECT_ID,
    TextOptions::default()
      .set_indexing_options(
        TextFieldIndexing::default()
          .set_tokenizer("raw")
          .set_index_option(IndexRecordOption::WithFreqs),
      )
      .set_stored(),
  );
  b.add_text_field(
    TITLE,
    TextOptions::default()
      .set_indexing_options(TextFieldIndexing::default())
      .set_stored(),
  );
  b.add_text_field(BODY, TextOptions::default()
    .set_indexing_options(TextFieldIndexing::default())
    .set_stored());
  b.add_text_field(TAGS, TextOptions::default()
    .set_indexing_options(TextFieldIndexing::default())
    .set_stored());
  b.build()
}

#[napi(object)]
pub struct NativeDoc {
  pub id: String,
  pub title: String,
  pub body: String,
  pub tags: String,
}

#[napi(object)]
pub struct NativeHit {
  pub id: String,
  pub score: f64,
}

/// Open (or create) the Tantivy index under `dir`. Resets the in-process runtime.
#[napi]
pub fn init_index(dir: String) -> Result<(), napi::Error> {
  let path = Path::new(&dir);
  std::fs::create_dir_all(path)
    .map_err(|e| napi::Error::from_reason(format!("cannot create index dir: {e}")))?;
  let s = schema();
  let index = match Index::open_in_dir(path) {
    Ok(index) => index,
    Err(_) => {
      Index::create_in_dir(path, s).map_err(|e| napi::Error::from_reason(e.to_string()))?
    }
  };
  let schema = index.schema();
  let object_id = schema
    .get_field(OBJECT_ID)
    .map_err(|e| napi::Error::from_reason(format!("schema error: {e}")))?;
  let title = schema
    .get_field(TITLE)
    .map_err(|e| napi::Error::from_reason(format!("schema error: {e}")))?;
  let body = schema
    .get_field(BODY)
    .map_err(|e| napi::Error::from_reason(format!("schema error: {e}")))?;
  let tags = schema
    .get_field(TAGS)
    .map_err(|e| napi::Error::from_reason(format!("schema error: {e}")))?;
  *lock_mut()? = Some(Runtime {
    index,
    object_id,
    title,
    body,
    tags,
  });
  Ok(())
}

/// Upsert documents (delete-by-id then add) and commit.
#[napi]
pub fn index_add(docs: Vec<NativeDoc>) -> Result<u32, napi::Error> {
  let guard = lock()?;
  let rt = guard
    .as_ref()
    .ok_or_else(|| napi::Error::from_reason("index not initialized"))?;
  let mut writer: IndexWriter<TantivyDocument> = rt
    .index
    .writer(60_000_000)
    .map_err(|e| napi::Error::from_reason(e.to_string()))?;
  let mut count = 0u32;
  for d in &docs {
    writer.delete_term(Term::from_field_text(rt.object_id, &d.id));
    let doc = tantivy::doc!(
      rt.object_id => d.id,
      rt.title => d.title,
      rt.body => d.body,
      rt.tags => d.tags
    );
    writer
      .add_document(doc)
      .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    count += 1;
  }
  writer
    .commit()
    .map_err(|e| napi::Error::from_reason(e.to_string()))?;
  Ok(count)
}

/// Delete documents by object id and commit.
#[napi]
pub fn index_delete(ids: Vec<String>) -> Result<u32, napi::Error> {
  let guard = lock()?;
  let rt = guard
    .as_ref()
    .ok_or_else(|| napi::Error::from_reason("index not initialized"))?;
  let mut writer: IndexWriter<TantivyDocument> = rt
    .index
    .writer(60_000_000)
    .map_err(|e| napi::Error::from_reason(e.to_string()))?;
  for id in &ids {
    writer.delete_term(Term::from_field_text(rt.object_id, id));
  }
  writer
    .commit()
    .map_err(|e| napi::Error::from_reason(e.to_string()))?;
  Ok(ids.len() as u32)
}

/// Ranked object ids for `query` (prefix + fuzzy per term, title/tags boosted).
#[napi]
pub fn index_search(query: String, limit: Option<u32>) -> Result<Vec<NativeHit>, napi::Error> {
  let guard = lock()?;
  let rt = guard
    .as_ref()
    .ok_or_else(|| napi::Error::from_reason("index not initialized"))?;
  let limit = usize::max(limit.unwrap_or(20) as usize, 1);
  let terms: Vec<String> = query
    .to_lowercase()
    .split(|c: char| !c.is_alphanumeric())
    .filter(|s| !s.is_empty())
    .map(String::from)
    .collect();
  if terms.is_empty() {
    return Ok(vec![]);
  }

  // AND of terms; each term matches title|body|tags through prefix OR fuzzy.
  let mut musts: Vec<(Occur, Box<dyn Query>)> = Vec::with_capacity(terms.len());
  for term in &terms {
    let group = BooleanQuery::new(vec![
      term_group(rt.title, term, 5.0),
      term_group(rt.body, term, 1.0),
      term_group(rt.tags, term, 2.5),
    ]);
    musts.push((Occur::Must, Box::new(group)));
  }
  let query_obj = BooleanQuery::new(musts);

  let reader = rt
    .index
    .reader()
    .map_err(|e| napi::Error::from_reason(e.to_string()))?;
  reader
    .reload()
    .map_err(|e| napi::Error::from_reason(e.to_string()))?;
  let searcher = reader.searcher();
  let top = searcher
    .search(&query_obj, &TopDocs::with_limit(limit))
    .map_err(|e| napi::Error::from_reason(e.to_string()))?;

  let mut hits: Vec<NativeHit> = Vec::with_capacity(top.len());
  for (score, address) in top {
    if let Some(id) = doc_id(&searcher, rt.object_id, address) {
      hits.push(NativeHit {
        id,
        score: score as f64,
      });
    }
  }
  Ok(hits)
}

/// Total indexed documents (smoke/debug).
#[napi]
pub fn index_count() -> Result<u32, napi::Error> {
  let guard = lock()?;
  let rt = guard
    .as_ref()
    .ok_or_else(|| napi::Error::from_reason("index not initialized"))?;
  let reader = rt
    .index
    .reader()
    .map_err(|e| napi::Error::from_reason(e.to_string()))?;
  reader
    .reload()
    .map_err(|e| napi::Error::from_reason(e.to_string()))?;
  let searcher = reader.searcher();
  let top = searcher
    .search(&AllQuery, &TopDocs::with_limit(1_000_000))
    .map_err(|e| napi::Error::from_reason(e.to_string()))?;
  Ok(top.len() as u32)
}

fn term_group(field: Field, term_str: &str, boost: f32) -> (Occur, Box<dyn Query>) {
  let term = Term::from_field_text(field, term_str);
  // Prefix matching is a regex over the tokenized term ("noteta.*"); tantivy
  // 0.24 has no PrefixTermQuery and its RegexQuery matches the whole term, so an
  // anchor ("^") would be treated literally. Combined with a ≤1-edit fuzzy term
  // => FTS5-like prefix behaviour plus typo tolerance.
  let mut clauses: Vec<(Occur, Box<dyn Query>)> = Vec::with_capacity(2);
  if let Ok(regex) = RegexQuery::from_pattern(&format!("{}.*", regex::escape(term_str)), field) {
    clauses.push((Occur::Should, Box::new(regex)));
  }
  clauses.push((Occur::Should, Box::new(FuzzyTermQuery::new(term, 1, true))));
  let inner = BooleanQuery::new(clauses);
  (Occur::Should, Box::new(BoostQuery::new(Box::new(inner), boost)))
}

fn doc_id(searcher: &tantivy::Searcher, field: Field, address: DocAddress) -> Option<String> {
  let doc: TantivyDocument = searcher.doc(address).ok()?;
  let value = doc.get_first(field)?;
  value.as_str().map(String::from)
}