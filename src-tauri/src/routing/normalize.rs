//! Turning the messy names in emails and postings into comparable keys.
//!
//! - `company_key`: "Manulife/John Hancock", "Manulife Financial" and
//!   "Manulife" all become "manulife"; "RBC" and "Royal Bank of Canada"
//!   both become "rbc".
//! - `domain_company`: `lyft.com` → "lyft", `careers.gs.com` → "goldman
//!   sachs", but ATS and mail-provider domains (greenhouse, icims, workday,
//!   oracle/taleo, gmail...) give nothing: they say who sent it, not who
//!   it's about.
//! - `role_similarity`: token overlap between two job titles, ignoring
//!   words every internship title shares ("intern", "2027", "summer"...).

use std::collections::HashSet;

use crate::mail::filter;
use crate::sync::matching::norm;

/// Legal-form words dropped from company names.
const SUFFIXES: &[&str] = &[
    "inc", "incorporated", "ltd", "limited", "llc", "llp", "lp", "corp", "corporation", "co", "company", "plc",
    "gmbh", "ag", "sa", "the",
];

/// Alternative names (after `norm` and suffix stripping) → one canonical
/// key. Only names that actually differ; a company with one name needs no
/// entry. Domain labels that aren't the company's name go here too.
const ALIASES: &[(&str, &str)] = &[
    ("royal bank of canada", "rbc"),
    ("rbc royal bank", "rbc"),
    ("rbc capital markets", "rbc"),
    ("td bank", "td"),
    ("td bank group", "td"),
    ("toronto dominion bank", "td"),
    ("td securities", "td"),
    ("bank of montreal", "bmo"),
    ("bmo financial group", "bmo"),
    ("canadian imperial bank of commerce", "cibc"),
    ("bank of nova scotia", "scotiabank"),
    ("manulife financial", "manulife"),
    ("manulife john hancock", "manulife"),
    ("john hancock", "manulife"),
    ("jhancock", "manulife"),
    ("goldman sachs group", "goldman sachs"),
    ("gs", "goldman sachs"),
    ("goldmansachs", "goldman sachs"),
    ("amazon web services", "amazon"),
    ("aws", "amazon"),
    ("amazon jobs", "amazon"),
    ("alphabet", "google"),
    ("meta platforms", "meta"),
    ("facebook", "meta"),
    ("advanced micro devices", "amd"),
    ("kpmg canada", "kpmg"),
];

/// Domains that send mail on behalf of many companies: no company evidence.
const NOT_COMPANY_DOMAINS: &[&str] = &[
    "oracle.com",
    "taleo.net",
    "workday.com",
    "myworkday.com",
    "myworkdayjobs.com",
    "successfactors.com",
    "jobvite.com",
    "dayforce.com",
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "yahoo.com",
];

/// Lowercase, punctuation to spaces, legal suffixes dropped, aliases
/// applied. "" for nothing usable.
pub fn company_key(name: &str) -> String {
    let n = norm(name);
    let words: Vec<&str> = n.split(' ').filter(|w| !w.is_empty() && !SUFFIXES.contains(w)).collect();
    let joined = words.join(" ");
    alias(&joined)
}

fn alias(key: &str) -> String {
    ALIASES
        .iter()
        .find(|(from, _)| *from == key)
        .map(|(_, to)| to.to_string())
        .unwrap_or_else(|| key.to_string())
}

/// Whether a sender domain is an ATS, job board or mail provider, i.e.
/// says nothing about the company.
pub fn is_not_company_domain(domain: &str) -> bool {
    let reg = filter::registrable(domain);
    filter::is_job_board(&reg)
        || NOT_COMPANY_DOMAINS.contains(&reg.as_str())
        || filter::ALLOW_DOMAINS.iter().any(|d| reg == *d)
        || filter::ALLOW_DOMAIN_CONTAINS.iter().any(|d| domain.contains(d))
}

/// The company a sender domain names: the registrable domain's first label,
/// through the alias map. `mail.amazon.jobs` → "amazon", `careers.gs.com`
/// → "goldman sachs". None for ATS / provider domains.
pub fn domain_company(domain: &str) -> Option<String> {
    let domain = domain.trim().to_ascii_lowercase();
    if domain.is_empty() || is_not_company_domain(&domain) {
        return None;
    }
    let reg = filter::registrable(&domain);
    let label = reg.split('.').next()?.to_string();
    (!label.is_empty()).then(|| alias(&label))
}

/// Words that appear in nearly every internship title, so they say nothing
/// about which role it is. Seasons and term lengths are *not* here: they
/// tell "Summer Intern (8 Months)" from "Winter Co-op (8 Months)" or the
/// 12-month version of the same role.
const ROLE_STOPWORDS: &[&str] = &[
    "the", "and", "of", "a", "an", "for", "to", "in", "at", "on", "with", "intern", "interns", "internship",
    "internships", "co", "op", "coop", "2025", "2026", "2027", "2028", "toronto", "canada", "remote", "hybrid",
    "student", "program", "opportunities", "opportunity", "fy27", "fy26",
];

fn role_tokens(role: &str, company: &str) -> HashSet<String> {
    // The company's own name, in both its written and its key form
    // ("royal bank of canada" and "rbc"): titles often repeat it.
    let key = company_key(company);
    let company_words: HashSet<String> = norm(company).split(' ').chain(key.split(' ')).map(str::to_string).collect();
    norm(role)
        .split(' ')
        .filter(|w| !w.is_empty() && !ROLE_STOPWORDS.contains(w) && !company_words.contains(*w))
        .map(str::to_string)
        .collect()
}

/// 0..1 overlap between two titles (Dice coefficient on their meaningful
/// tokens; the company's own name is ignored, so "Developer, RBC Amplify"
/// and "Data Engineer, RBC Amplify" aren't made similar by "rbc").
pub fn role_similarity(a: &str, b: &str, company: &str) -> f64 {
    let (ta, tb) = (role_tokens(a, company), role_tokens(b, company));
    if ta.is_empty() || tb.is_empty() {
        return 0.0;
    }
    let shared = ta.intersection(&tb).count() as f64;
    2.0 * shared / (ta.len() + tb.len()) as f64
}

/// A req id worth matching on: alphanumerics only, at least 5 characters
/// with a digit, and not just a year ("2027" came back as a req id once).
/// Short ids match other postings by accident too easily.
pub fn req_key(req: &str) -> Option<String> {
    let k: String = req.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
    let is_year = k.len() == 4 && (k.starts_with("19") || k.starts_with("20")) && k.chars().all(|c| c.is_ascii_digit());
    (k.len() >= 5 && !is_year && k.chars().any(|c| c.is_ascii_digit())).then_some(k)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn company_keys() {
        assert_eq!(company_key("Royal Bank of Canada"), "rbc");
        assert_eq!(company_key("RBC"), "rbc");
        assert_eq!(company_key("Manulife/John Hancock"), "manulife");
        assert_eq!(company_key("Manulife Financial"), "manulife");
        assert_eq!(company_key("Lyft, Inc."), "lyft");
        assert_eq!(company_key("The Goldman Sachs Group, Inc."), "goldman sachs");
        assert_eq!(company_key("TD"), "td");
        assert_eq!(company_key(""), "");
    }

    #[test]
    fn domains() {
        assert_eq!(domain_company("lyft.com").as_deref(), Some("lyft"));
        assert_eq!(domain_company("mail.amazon.jobs").as_deref(), Some("amazon"));
        assert_eq!(domain_company("careers.gs.com").as_deref(), Some("goldman sachs"));
        assert_eq!(domain_company("email.careers.microsoft.com").as_deref(), Some("microsoft"));
        for ats in ["us.greenhouse-mail.io", "talent.icims.com", "myworkday.com", "acme.myworkday.com", "oracle.com", "gmail.com"] {
            assert_eq!(domain_company(ats), None, "{ats} isn't company evidence");
        }
    }

    #[test]
    fn roles() {
        let rbc = "Royal Bank of Canada";
        let dev = role_similarity("Developer, RBC Amplify 2027, Toronto", "Developer, RBC Amplify", rbc);
        let data = role_similarity("Developer, RBC Amplify 2027, Toronto", "Data Engineer, RBC Amplify", rbc);
        assert_eq!(dev, 1.0);
        assert!(data < 0.5, "{data}");
        assert_eq!(role_similarity("", "Developer", rbc), 0.0);
    }

    #[test]
    fn req_ids() {
        assert_eq!(req_key("R-0000187113").as_deref(), Some("r0000187113"));
        assert_eq!(req_key("R_1509435").as_deref(), Some("r1509435"));
        assert_eq!(req_key("2027"), None);
        assert_eq!(req_key("abc"), None);
        assert_eq!(req_key("JR-12"), None); // too short to trust
    }
}
