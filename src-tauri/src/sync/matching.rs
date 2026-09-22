//! Identity and deduplication — must stay byte-for-byte identical to
//! `apps-script/code.gs`'s `norm`/`makeKey`/`makeTriple`/`normUrl` (see
//! CLAUDE.md, "Identity and deduplication").

/// Mirrors `code.gs`'s `norm(s)`:
/// ```js
/// String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/// ```
///
/// The JS character class `[^a-z0-9]` is plain ASCII — it has no `u` flag, so
/// it does not know about Unicode letters at all. That means an accented
/// letter like `é` does NOT match `[a-z0-9]` (even though `.toLowerCase()`
/// happily lowercases it) and gets treated as a separator, same as a space
/// or punctuation. `"Café Örg"` normalizes to `"caf rg"` in code.gs, not
/// `"café örg"`.
///
/// Rust's `char::is_alphanumeric()` is Unicode-aware and would keep `é`,
/// which would silently disagree with the sheet's matching — so this checks
/// `is_ascii_lowercase()` / `is_ascii_digit()` specifically, not
/// `is_alphanumeric()`.
pub fn norm(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    // Starts true so a separator run at the very start of the string is
    // dropped instead of emitting a leading space (mirrors `.trim()`).
    let mut in_sep_run = true;
    for c in s.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
            in_sep_run = false;
        } else if !in_sep_run {
            out.push(' ');
            in_sep_run = true;
        }
    }
    if out.ends_with(' ') {
        out.pop(); // trailing separator run — mirrors `.trim()` at the end
    }
    out
}

/// Mirrors `code.gs`'s `makeKey(p)`: `company|req_id` when there's a req id,
/// else `company|title|city`, each part normalized.
pub fn job_key(company: &str, title: &str, city: &str, req_id: &str) -> String {
    let company = norm(company);
    let req_id = norm(req_id);
    if !req_id.is_empty() {
        format!("{company}|{req_id}")
    } else {
        format!("{company}|{}|{}", norm(title), norm(city))
    }
}

/// Mirrors `code.gs`'s `makeTriple(company, title, city)`.
pub fn triple(company: &str, title: &str, city: &str) -> String {
    format!("{}|{}|{}", norm(company), norm(title), norm(city))
}

/// Mirrors `code.gs`'s `normUrl(u)`: lowercase, trimmed, query/fragment and
/// trailing slashes stripped. Empty input (or a URL that's nothing but a
/// scheme/host) normalizes to `""`, which callers must treat as "no URL to
/// match on" — same as code.gs's `byUrl` map skipping empty keys.
pub fn norm_url(u: &str) -> String {
    let s = u.trim().to_lowercase();
    if s.is_empty() {
        return String::new();
    }
    let head = s.split(['?', '#']).next().unwrap_or("");
    head.trim_end_matches('/').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn norm_lowercases_and_collapses_punctuation() {
        assert_eq!(norm("  Shopify   Inc. "), "shopify inc");
        assert_eq!(norm("R&D / Platform"), "r d platform");
        assert_eq!(norm(""), "");
        assert_eq!(norm("   "), "");
    }

    /// The load-bearing case: JS's `[^a-z0-9]` is ASCII-only, so accented
    /// letters are separators, not letters. If this used
    /// `char::is_alphanumeric()` instead, "café" would normalize to "café"
    /// (unchanged) here but "caf" + a dropped "é" in code.gs — two different
    /// job_keys for the same posting.
    #[test]
    fn norm_is_ascii_only() {
        assert_eq!(norm("Café Örg"), "caf rg");
        assert_eq!(norm("Zürich"), "z rich");
        assert_eq!(norm("Montréal"), "montr al");
        assert_eq!(norm("北京"), ""); // no ASCII a-z0-9 at all
    }

    #[test]
    fn job_key_prefers_req_id() {
        assert_eq!(
            job_key("Shopify", "SWE Intern", "Toronto", "REQ-42"),
            "shopify|req 42"
        );
        assert_eq!(
            job_key("Shopify", "SWE Intern", "Toronto", ""),
            "shopify|swe intern|toronto"
        );
    }

    #[test]
    fn triple_ignores_req_id() {
        assert_eq!(
            triple("Shopify", "SWE Intern", "Toronto"),
            "shopify|swe intern|toronto"
        );
    }

    #[test]
    fn norm_url_strips_query_fragment_and_trailing_slashes() {
        assert_eq!(
            norm_url("https://Example.com/jobs/123/?utm_source=x#apply"),
            "https://example.com/jobs/123"
        );
        assert_eq!(
            norm_url("https://example.com/jobs/123///"),
            "https://example.com/jobs/123"
        );
        assert_eq!(norm_url("  "), "");
        assert_eq!(norm_url(""), "");
    }
}
