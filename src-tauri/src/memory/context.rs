use rusqlite::Connection;

use super::models::MemoryContext;
use super::repository;

pub fn build_memory_context(
    conn: &Connection,
    conversation_id: &str,
    user_message: &str,
) -> Result<MemoryContext, rusqlite::Error> {
    let mut parts: Vec<String> = Vec::new();

    // 1. Get recent conversation summaries (up to 5, excluding current)
    let summaries = repository::get_recent_summaries(conn, 5)?;
    let relevant_summaries: Vec<_> = summaries
        .into_iter()
        .filter(|s| s.conversation_id != conversation_id)
        .collect();

    if !relevant_summaries.is_empty() {
        parts.push("## Conversation Summaries".to_string());
        for s in &relevant_summaries {
            parts.push(format!("- {}", s.summary));
        }
    }

    // 2. FTS5 search for related historical messages (top 3, excluding current conversation)
    let search_results = search_relevant_messages(conn, conversation_id, user_message)?;
    if !search_results.is_empty() {
        parts.push(String::new());
        parts.push("## Related History".to_string());
        for r in &search_results {
            parts.push(format!(
                "- [{}] {}: {}",
                r.conversation_title, r.role, r.snippet
            ));
        }
    }

    if parts.is_empty() {
        return Ok(MemoryContext {
            system_prompt: String::new(),
            has_context: false,
        });
    }

    let prompt = format!(
        "<memory_context>\nUser's prior conversation context for more personalized responses.\n\n{}\n</memory_context>",
        parts.join("\n")
    );

    Ok(MemoryContext {
        system_prompt: prompt,
        has_context: true,
    })
}

fn search_relevant_messages(
    conn: &Connection,
    exclude_conversation_id: &str,
    query: &str,
) -> Result<Vec<SearchHit>, rusqlite::Error> {
    // Extract keywords: take first ~200 chars, split into words, filter short ones
    let truncated: String = query.chars().take(200).collect();
    let keywords: Vec<&str> = truncated
        .split_whitespace()
        .filter(|w| w.len() > 2)
        .take(10)
        .collect();

    if keywords.is_empty() {
        return Ok(Vec::new());
    }

    // Build FTS5 query: join keywords with OR
    let fts_query = keywords.join(" OR ");

    let mut stmt = conn.prepare(
        "SELECT m.conversation_id, c.title, m.role,
                snippet(messages_fts, 0, '', '', '...', 32) as snippet
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         JOIN conversations c ON c.id = m.conversation_id
         WHERE messages_fts MATCH ?1 AND m.conversation_id != ?2
         ORDER BY rank
         LIMIT 3",
    )?;

    let rows = stmt.query_map(
        rusqlite::params![fts_query, exclude_conversation_id],
        |row| {
            Ok(SearchHit {
                conversation_title: row.get(1)?,
                role: row.get(2)?,
                snippet: row.get(3)?,
            })
        },
    )?;

    rows.collect()
}

struct SearchHit {
    conversation_title: String,
    role: String,
    snippet: String,
}
