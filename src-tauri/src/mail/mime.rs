//! Turning a Gmail API message (`format=full`) into the fields we store.
//!
//! Gmail returns the MIME tree as JSON: each part has a `mimeType`,
//! `headers`, and a `body.data` holding that part's bytes, base64url
//! encoded. The transfer encoding (quoted-printable etc.) is already undone
//! by Gmail; the charset is not. For the body we walk the tree, take the
//! first `text/plain` part that isn't an attachment, and only if there is
//! none, the first `text/html` part, stripped to text.

use base64::Engine;
use serde::Deserialize;

/// The slice of Gmail's `Message` resource we use.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub thread_id: Option<String>,
    #[serde(default)]
    pub label_ids: Vec<String>,
    #[serde(default)]
    pub snippet: String,
    /// Milliseconds since the epoch, as a string (Gmail's choice).
    pub internal_date: Option<String>,
    pub payload: Option<Part>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    #[serde(default)]
    pub mime_type: String,
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub headers: Vec<Header>,
    pub body: Option<Body>,
    #[serde(default)]
    pub parts: Vec<Part>,
}

#[derive(Debug, Deserialize)]
pub struct Header {
    pub name: String,
    pub value: String,
}

/// A part's bytes. Attachments have an `attachmentId` instead of `data`;
/// we never fetch those, so that field isn't read at all.
#[derive(Debug, Deserialize)]
pub struct Body {
    pub data: Option<String>,
}

/// What gets stored (plus the headers the filter needs).
#[derive(Debug, Default, PartialEq)]
pub struct Decoded {
    pub from: Option<String>,
    pub to: Option<String>,
    pub subject: Option<String>,
    pub list_unsubscribe: bool,
    pub body_text: String,
}

/// Longest body kept, in characters. Enough for any recruiting email; a
/// stray giant newsletter doesn't bloat the DB.
const MAX_BODY_CHARS: usize = 50_000;

pub fn decode(msg: &Message) -> Decoded {
    let Some(payload) = &msg.payload else { return Decoded::default() };
    let header = |name: &str| {
        payload
            .headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case(name))
            .map(|h| h.value.trim().to_string())
    };
    let body = find_part(payload, "text/plain")
        .map(part_text)
        .filter(|t| !t.trim().is_empty())
        .or_else(|| find_part(payload, "text/html").map(|p| html_to_text(&part_text(p))))
        .unwrap_or_default();
    Decoded {
        from: header("From"),
        to: header("To"),
        subject: header("Subject"),
        list_unsubscribe: header("List-Unsubscribe").is_some(),
        body_text: tidy(&body).chars().take(MAX_BODY_CHARS).collect(),
    }
}

/// Depth-first, in document order: in multipart/alternative the plain
/// version comes first, and nested multiparts (mixed → alternative) are
/// searched too. Attachments (a filename, or no inline data) are skipped.
fn find_part<'a>(part: &'a Part, mime: &str) -> Option<&'a Part> {
    let is_inline = part.filename.is_empty() && part.body.as_ref().is_some_and(|b| b.data.is_some());
    if part.mime_type.eq_ignore_ascii_case(mime) && is_inline {
        return Some(part);
    }
    part.parts.iter().find_map(|p| find_part(p, mime))
}

/// A part's text: base64url-decode the data, then interpret the bytes in
/// the part's charset.
fn part_text(part: &Part) -> String {
    let data = part.body.as_ref().and_then(|b| b.data.as_deref()).unwrap_or("");
    let bytes = decode_base64url(data);
    let charset = part
        .headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case("Content-Type"))
        .and_then(|h| param(&h.value, "charset"))
        .unwrap_or_default()
        .to_ascii_lowercase();
    match charset.as_str() {
        // Single-byte Western charsets: each byte is the code point of the
        // same number (exact for latin-1, close enough for windows-1252,
        // whose 0x80–0x9F extras are rare in mail text).
        "iso-8859-1" | "latin1" | "windows-1252" | "us-ascii" => bytes.iter().map(|&b| b as char).collect(),
        _ => String::from_utf8_lossy(&bytes).into_owned(),
    }
}

/// Gmail uses the URL-safe alphabet; padding may or may not be there.
pub fn decode_base64url(data: &str) -> Vec<u8> {
    let trimmed = data.trim().trim_end_matches('=');
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(trimmed)
        .unwrap_or_default()
}

/// `charset` from `text/plain; charset="UTF-8"`.
fn param<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    header.split(';').skip(1).find_map(|p| {
        let (k, v) = p.split_once('=')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim().trim_matches('"'))
    })
}

/// HTML to readable text, without an HTML parser: drop script/style/head,
/// turn block ends and <br> into newlines, drop the remaining tags, decode
/// entities. Good enough for the LLM and for display; not a renderer.
pub fn html_to_text(html: &str) -> String {
    let mut s = html.to_string();
    for tag in ["script", "style", "head", "title"] {
        s = remove_element(&s, tag);
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s.as_str();
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('>') else {
            rest = "";
            break;
        };
        let tag = rest[start + 1..start + end].trim().to_ascii_lowercase();
        let name = tag.trim_start_matches('/').split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("");
        if matches!(name, "br" | "p" | "div" | "tr" | "li" | "h1" | "h2" | "h3" | "h4" | "table" | "hr") {
            out.push('\n');
        } else if matches!(name, "td" | "th") {
            out.push(' ');
        }
        rest = &rest[start + end + 1..];
    }
    out.push_str(rest);
    decode_entities(&out)
}

/// Removes `<tag ...>...</tag>` blocks, case-insensitively.
fn remove_element(s: &str, tag: &str) -> String {
    let lower = s.to_ascii_lowercase();
    let (open, close) = (format!("<{tag}"), format!("</{tag}>"));
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while let Some(start) = lower[i..].find(&open).map(|p| p + i) {
        out.push_str(&s[i..start]);
        match lower[start..].find(&close) {
            Some(end) => i = start + end + close.len(),
            None => return out,
        }
    }
    out.push_str(&s[i..]);
    out
}

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        let Some(semi) = after.find(';').filter(|&n| n <= 10) else {
            out.push('&');
            rest = after;
            continue;
        };
        let name = &after[..semi];
        let decoded = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            "mdash" => Some('—'),
            "ndash" => Some('–'),
            "rsquo" => Some('’'),
            "lsquo" => Some('‘'),
            "hellip" => Some('…'),
            _ => name
                .strip_prefix("#x")
                .or_else(|| name.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| name.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                // A non-breaking space (&#160;) reads as a plain space.
                out.push(if c == '\u{a0}' { ' ' } else { c });
                rest = &after[semi + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Normalises whitespace: \r\n → \n, trailing spaces trimmed, runs of
/// spaces collapsed, at most one blank line in a row.
fn tidy(s: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in s.replace("\r\n", "\n").replace('\r', "\n").lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() && lines.last().map_or(true, |l| l.is_empty()) {
            continue;
        }
        lines.push(line);
    }
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Sample messages in Gmail's JSON shape. Written for these tests, with
    // placeholder people and addresses (example.com); no real mail.
    fn sample(name: &str) -> Message {
        let json = match name {
            "greenhouse" => include_str!("testdata/greenhouse_alternative.json"),
            "newsletter" => include_str!("testdata/newsletter_html_only.json"),
            "latin1" => include_str!("testdata/latin1_plain.json"),
            _ => unreachable!(),
        };
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn multipart_alternative_prefers_plain_text() {
        let d = decode(&sample("greenhouse"));
        assert_eq!(d.from.as_deref(), Some("Acme Recruiting <no-reply@us.greenhouse-mail.io>"));
        assert_eq!(d.to.as_deref(), Some("candidate@example.com"));
        assert_eq!(d.subject.as_deref(), Some("Thank you for applying to Acme"));
        assert!(!d.list_unsubscribe);
        // The plain part, not the HTML one (which says "HTML version").
        assert!(d.body_text.starts_with("Hi Sam,\n\nThanks for applying to the Software Engineering Intern role."));
        assert!(!d.body_text.contains("HTML version"));
        // The PDF attachment in the mixed part is not the body.
        assert!(!d.body_text.contains("%PDF"));
    }

    #[test]
    fn html_only_is_stripped_to_text() {
        let d = decode(&sample("newsletter"));
        assert!(d.list_unsubscribe);
        assert_eq!(
            d.body_text,
            // Block elements come out as paragraphs, one blank line apart.
            "This week in tech\n\nRoles & internships – fall edition\n\nRead more…\n\nUnsubscribe"
        );
    }

    #[test]
    fn latin1_charset_is_honoured() {
        let d = decode(&sample("latin1"));
        assert_eq!(d.body_text, "Bonjour, votre candidature a été reçue.");
    }

    #[test]
    fn base64url_with_and_without_padding() {
        // "hi?>" in standard base64 is "aGk/Pg=="; URL-safe swaps / for _.
        assert_eq!(decode_base64url("aGk_Pg=="), b"hi?>");
        assert_eq!(decode_base64url("aGk_Pg"), b"hi?>");
        assert_eq!(decode_base64url("not base64!!"), b"");
    }

    #[test]
    fn entities_and_whitespace() {
        assert_eq!(
            html_to_text("<p>A&nbsp;&amp;&#160;B</p><p>&#x2014;&lt;x&gt; &unknown; & done</p>"),
            "\nA & B\n\n—<x> &unknown; & done\n"
        );
        assert_eq!(tidy("  a   b \r\n\r\n\r\n c \n\n"), "a b\n\nc");
    }
}
