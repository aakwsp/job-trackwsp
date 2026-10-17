//! Cities and hubs (JT-38). `jobs.city` stays the raw text from the sheet
//! (it's part of `job_key`); `parse` turns it into the places it names,
//! and `hub_of` groups nearby places into one JOBS section.
//!
//! Parsing, in order:
//! 1. lowercase and fold accents ("Montréal" → "montreal");
//! 2. split into pieces on " or ", " and ", "/", "&", ";";
//! 3. per piece: "remote" anywhere makes it Remote (its own place), and
//!    what's left is still read ("Toronto (Remote)" → toronto + remote);
//!    work-mode words ("hybrid", "on-site") are dropped;
//! 4. commas: province / state / country parts are stripped ("Toronto,
//!    ON", "Toronto, Ontario, Canada" → toronto), then every remaining
//!    comma separates two places ("Waterdown, Toronto");
//! 5. a piece that's nothing but a region ("Canada") stays as itself:
//!    nothing a posting says is ever dropped.

use sqlx::{SqliteConnection, SqlitePool};

/// Bump whenever `parse` (or anything it uses) changes what it returns:
/// on open, a different stored version rebuilds every job's cities.
pub const CITIES_PARSER_VERSION: &str = "1";
/// `settings` key holding the version the stored `job_cities` came from.
pub const VERSION_KEY: &str = "cities_parser_version";

/// The default hubs: (section name, member cities). A city in no hub is
/// its own section. JT-33 makes these editable; until then they're here.
pub const HUBS: &[(&str, &[&str])] = &[
    (
        "gta",
        &["toronto", "north york", "scarborough", "etobicoke", "markham", "vaughan", "richmond hill", "mississauga", "brampton", "oakville"],
    ),
    ("kw", &["waterloo", "kitchener", "cambridge"]),
    ("montreal", &["montreal", "mount-royal", "laval", "brossard", "longueuil"]),
    ("hamilton", &["hamilton", "burlington", "waterdown"]),
    ("ottawa", &["ottawa", "kanata", "gatineau"]),
    ("vancouver", &["vancouver", "burnaby", "surrey", "richmond"]),
    ("edmonton", &["edmonton", "acheson"]),
    ("halifax", &["halifax", "cole harbour"]),
];

/// The place every remote posting becomes.
pub const REMOTE: &str = "remote";

/// Provinces, territories, US states and countries, as names and codes.
/// Whole comma parts only: "quebec city" is a city, "quebec" a province.
const REGIONS: &[&str] = &[
    // Canada
    "on", "ont", "ontario", "qc", "que", "quebec", "bc", "british columbia", "ab", "alberta", "mb", "manitoba", "sk",
    "saskatchewan", "ns", "nova scotia", "nb", "new brunswick", "nl", "newfoundland and labrador", "pe", "pei",
    "prince edward island", "yt", "yukon", "nt", "northwest territories", "nu", "nunavut",
    // countries
    "canada", "ca", "can", "usa", "us", "u.s.", "u.s.a.", "united states", "united states of america", "uk", "united kingdom",
    // US states commonly on postings (codes and names)
    "ny", "new york state", "wa", "washington", "california", "ma", "massachusetts", "tx", "texas", "il", "illinois",
    "nj", "new jersey", "pa", "pennsylvania", "ga", "georgia", "co", "colorado", "or", "oregon", "nc", "north carolina",
    "va", "virginia", "fl", "florida", "mi", "michigan", "mn", "minnesota", "az", "arizona", "ut", "utah",
];

/// Work-mode words that say nothing about the place.
const MODES: &[&str] = &["hybrid", "on-site", "onsite", "on site", "in-office", "in office", "in person", "in-person", "flexible"];

/// Spellings of one place that should read the same.
const ALIASES: &[(&str, &str)] = &[
    ("mont-royal", "mount-royal"),
    ("mont royal", "mount-royal"),
    ("mount royal", "mount-royal"),
    ("ville de quebec", "quebec city"),
    ("quebec, qc", "quebec city"),
];

/// The places a raw `jobs.city` names, in order, without duplicates.
/// Empty only for an empty string.
pub fn parse(raw: &str) -> Vec<String> {
    let text = fold(raw.trim()).to_lowercase();
    let mut out: Vec<String> = Vec::new();
    let mut push = |c: String| {
        if !c.is_empty() && !out.contains(&c) {
            out.push(c);
        }
    };
    for piece in split_pieces(&text) {
        let (remote, rest) = take_remote(&piece);
        if remote {
            push(REMOTE.into());
        }
        let rest = drop_modes(&rest);
        for city in comma_cities(&rest, remote) {
            push(city);
        }
    }
    out
}

/// The hub a parsed city belongs to, or the city itself.
pub fn hub_of(city: &str) -> &str {
    HUBS.iter().find(|(_, members)| members.contains(&city)).map(|(hub, _)| *hub).unwrap_or(city)
}

/// The hubs of a posting's parsed cities, in order, without duplicates:
/// the sections it appears under. Computed at read time from `HUBS`, never
/// stored, so editing the hubs (JT-33) needs no rebuild.
pub fn hubs_of(cities: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in cities {
        let h = hub_of(c).to_string();
        if !out.contains(&h) {
            out.push(h);
        }
    }
    out
}

// ── storage ──────────────────────────────────────────────────────────────

/// Replaces one job's `job_cities` rows with the parse of its raw city.
/// For the sync (insert, or the city text changed) and manual jobs.
pub async fn rebuild_job(conn: &mut SqliteConnection, job_id: i64, raw: Option<&str>) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM job_cities WHERE job_id = ?").bind(job_id).execute(&mut *conn).await?;
    for (i, city) in parse(raw.unwrap_or("")).iter().enumerate() {
        sqlx::query("INSERT INTO job_cities (job_id, city, position) VALUES (?, ?, ?)")
            .bind(job_id)
            .bind(city)
            .bind(i as i64)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// On open: rebuilds every job's cities in one transaction, but only when
/// the stored parser version is missing or different, or a job with a
/// city has no rows (e.g. the first open after the migration). Returns
/// how many jobs were rebuilt (0 when nothing needed doing).
pub async fn ensure(pool: &SqlitePool) -> sqlx::Result<u64> {
    let stored: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = ?").bind(VERSION_KEY).fetch_optional(pool).await?;
    let missing: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM jobs j
         WHERE trim(COALESCE(j.city, '')) <> ''
           AND NOT EXISTS (SELECT 1 FROM job_cities c WHERE c.job_id = j.id)",
    )
    .fetch_one(pool)
    .await?;
    if stored.as_deref() == Some(CITIES_PARSER_VERSION) && missing == 0 {
        return Ok(0);
    }
    let mut tx = pool.begin().await?;
    let jobs: Vec<(i64, Option<String>)> = sqlx::query_as("SELECT id, city FROM jobs").fetch_all(&mut *tx).await?;
    sqlx::query("DELETE FROM job_cities").execute(&mut *tx).await?;
    for (id, city) in &jobs {
        rebuild_job(&mut tx, *id, city.as_deref()).await?;
    }
    sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .bind(VERSION_KEY)
        .bind(CITIES_PARSER_VERSION)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    log::info!("job cities rebuilt for {} jobs (parser {CITIES_PARSER_VERSION})", jobs.len());
    Ok(jobs.len() as u64)
}

fn split_pieces(text: &str) -> Vec<String> {
    let mut pieces = vec![text.to_string()];
    for sep in [" or ", " and ", "/", "&", ";", " | "] {
        pieces = pieces.iter().flat_map(|p| p.split(sep).map(str::to_string).collect::<Vec<_>>()).collect();
    }
    pieces.into_iter().map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect()
}

/// "remote" as a word anywhere in the piece: removed, with brackets and
/// dashes around it ("Canada (Remote)", "Remote - Canada").
fn take_remote(piece: &str) -> (bool, String) {
    let words: Vec<&str> = piece.split(|c: char| c.is_whitespace() || "()[]-–—:".contains(c)).filter(|w| !w.is_empty()).collect();
    if !words.iter().any(|w| w.trim_matches(',') == "remote") {
        return (false, piece.to_string());
    }
    let rest = words.into_iter().filter(|w| w.trim_matches(',') != "remote").collect::<Vec<_>>().join(" ");
    (true, rest.trim_matches(|c: char| c == ',' || c.is_whitespace()).to_string())
}

fn drop_modes(piece: &str) -> String {
    let mut s = format!(" {} ", piece.replace(['(', ')'], " "));
    for m in MODES {
        s = s.replace(&format!(" {m} "), " ").replace(&format!(" {m},"), " ,");
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ").trim_matches(|c: char| c == ',' || c == '-' || c.is_whitespace()).to_string()
}

/// Cities in one piece, by its commas (step 4 in the module comment).
/// `remote`: the piece already said remote, so a lone region left over
/// ("Canada (Remote)") adds nothing.
fn comma_cities(piece: &str, remote: bool) -> Vec<String> {
    if piece.is_empty() {
        return Vec::new();
    }
    if let Some((_, to)) = ALIASES.iter().find(|(from, _)| *from == piece) {
        return vec![to.to_string()];
    }
    let parts: Vec<String> = piece.split(',').map(|p| alias(p.trim().trim_end_matches('.'))).filter(|p| !p.is_empty()).collect();
    let places: Vec<String> = parts.iter().filter(|p| !REGIONS.contains(&p.as_str())).cloned().collect();
    match places.len() {
        // Only a region ("Canada"): keep it, unless remote already covers it.
        0 if remote => Vec::new(),
        0 => vec![parts.join(", ")],
        _ => places,
    }
}

fn alias(p: &str) -> String {
    ALIASES.iter().find(|(from, _)| *from == p).map(|(_, to)| to.to_string()).unwrap_or_else(|| p.to_string())
}

/// Latin accents to plain letters, enough for Canadian and US place names.
fn fold(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'à' | 'á' | 'â' | 'ä' | 'ã' | 'å' | 'À' | 'Á' | 'Â' | 'Ä' | 'Ã' | 'Å' => 'a',
            'ç' | 'Ç' => 'c',
            'è' | 'é' | 'ê' | 'ë' | 'È' | 'É' | 'Ê' | 'Ë' => 'e',
            'ì' | 'í' | 'î' | 'ï' | 'Ì' | 'Í' | 'Î' | 'Ï' => 'i',
            'ñ' | 'Ñ' => 'n',
            'ò' | 'ó' | 'ô' | 'ö' | 'õ' | 'Ò' | 'Ó' | 'Ô' | 'Ö' | 'Õ' => 'o',
            'ù' | 'ú' | 'û' | 'ü' | 'Ù' | 'Ú' | 'Û' | 'Ü' => 'u',
            'ý' | 'ÿ' | 'Ý' => 'y',
            '’' => '\'',
            other => other,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Vec<String> {
        parse(s)
    }

    fn hubs(raw: &str) -> Vec<String> {
        hubs_of(&parse(raw))
    }

    #[test]
    fn splits_and_normalizes() {
        assert_eq!(p("Waterloo or Toronto"), ["waterloo", "toronto"]);
        assert_eq!(p("Toronto / Remote"), ["toronto", "remote"]);
        assert_eq!(p("Montréal & Laval"), ["montreal", "laval"]);
        assert_eq!(p("Ottawa; Kanata"), ["ottawa", "kanata"]);
        assert_eq!(p("Kitchener and Waterloo"), ["kitchener", "waterloo"]);
        assert_eq!(p("Québec City"), ["quebec city"]);
        assert_eq!(p("Mont-Royal"), ["mount-royal"]);
        assert_eq!(p("Toronto or toronto"), ["toronto"]);
    }

    #[test]
    fn regions_are_stripped_then_every_comma_splits() {
        assert_eq!(p("Toronto, ON"), ["toronto"]);
        assert_eq!(p("Toronto, Ontario, Canada"), ["toronto"]);
        assert_eq!(p("Markham, Ontario, Canada"), ["markham"]);
        assert_eq!(p("Vancouver, BC, Canada"), ["vancouver"]);
        assert_eq!(p("Montréal, QC"), ["montreal"]);
        assert_eq!(p("Seattle, WA"), ["seattle"]);
        assert_eq!(p("Toronto, Waterloo"), ["toronto", "waterloo"]);
        assert_eq!(p("Waterdown, Toronto"), ["waterdown", "toronto"]);
        assert_eq!(p("Waterloo, ON / Toronto, ON"), ["waterloo", "toronto"]);
    }

    #[test]
    fn remote_and_work_modes() {
        assert_eq!(p("Remote"), ["remote"]);
        assert_eq!(p("Canada (Remote)"), ["remote"]);
        assert_eq!(p("Remote - Canada"), ["remote"]);
        assert_eq!(p("Toronto (Hybrid)"), ["toronto"]);
        assert_eq!(p("Hybrid - Ottawa"), ["ottawa"]);
        assert_eq!(p("Hybrid - Toronto, ON"), ["toronto"]);
        assert_eq!(p("Toronto (Remote)"), ["remote", "toronto"]);
        assert_eq!(p("On-site, Markham"), ["markham"]);
    }

    #[test]
    fn nothing_is_dropped() {
        assert_eq!(p("Canada"), ["canada"]);
        assert_eq!(p("Atlantis Bay"), ["atlantis bay"]); // unknown: its own city
        assert_eq!(p("Cole Harbour"), ["cole harbour"]);
        assert!(p("").is_empty());
        assert!(p("   ").is_empty());
    }

    #[test]
    fn hubs_group_nearby_cities() {
        assert_eq!(hubs("Markham"), ["gta"]);
        assert_eq!(hubs("Waterloo or Toronto"), ["kw", "gta"]);
        assert_eq!(hubs("Toronto / Mississauga"), ["gta"]);
        assert_eq!(hubs("Calgary"), ["calgary"]);
        assert_eq!(hubs("Remote"), ["remote"]);
        assert_eq!(hubs("Canada"), ["canada"]);
        assert_eq!(hubs("Waterdown, Toronto"), ["hamilton", "gta"]);
        assert_eq!(hubs("Brossard"), ["montreal"]);
        assert_eq!(hubs("Richmond"), ["vancouver"]);
        assert_eq!(hubs("Acheson"), ["edmonton"]);
        assert_eq!(hubs("Cole Harbour"), ["halifax"]);
        assert_eq!(hubs("Atlantis Bay"), ["atlantis bay"]);
    }

    #[test]
    fn ensure_rebuilds_only_when_the_version_changes_or_rows_are_missing() {
        use tauri::async_runtime::block_on;
        let dir = std::env::temp_dir().join(format!("jt-cities-{}-{:?}", std::process::id(), std::time::SystemTime::now()));
        // connect runs migrations, then ensure (nothing to rebuild yet).
        let pool = block_on(crate::db::connect(&dir)).unwrap();
        let rows = || -> Vec<(i64, String)> {
            block_on(sqlx::query_as("SELECT job_id, city FROM job_cities ORDER BY job_id, position").fetch_all(&pool)).unwrap()
        };
        block_on(
            sqlx::query("INSERT INTO jobs (job_key, company, title, triple, city) VALUES ('a', 'A', 't', 'a', 'Waterloo or Toronto'), ('b', 'B', 't', 'b', NULL)")
                .execute(&pool),
        )
        .unwrap();
        // A job with a city but no rows: rebuilt.
        assert_eq!(block_on(ensure(&pool)).unwrap(), 2);
        assert_eq!(rows(), [(1, "waterloo".into()), (1, "toronto".into())]);
        // Same version, nothing missing (the city-less job needs none): no-op.
        assert_eq!(block_on(ensure(&pool)).unwrap(), 0);
        // A different stored version: rebuilt again.
        block_on(sqlx::query("UPDATE settings SET value = 'old' WHERE key = ?").bind(VERSION_KEY).execute(&pool)).unwrap();
        assert_eq!(block_on(ensure(&pool)).unwrap(), 2);
        assert_eq!(rows().len(), 2);
        let v: String = block_on(sqlx::query_scalar("SELECT value FROM settings WHERE key = ?").bind(VERSION_KEY).fetch_one(&pool)).unwrap();
        assert_eq!(v, CITIES_PARSER_VERSION);

        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
