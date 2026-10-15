//! The cheap filter that runs on every stored message before anything
//! reaches the LLM (JT-14). Each message ends up `pending` (on to the LLM in
//! JT-15) or `ignored`, with a reason either way.
//!
//! Order:
//! 1. The block list. Mail that must never reach the LLM, whatever else
//!    is true of it (the user's current part-time job). Nothing overrides it.
//! 2. The allow list's ATS senders. Win over everything below.
//! 3. Ignored single addresses (`IGNORE_ADDRESSES`). These name one
//!    sender exactly, so they beat the next rule, which only guesses.
//! 4. The allow list's applied-company domains. Wins over 5.
//! 5. The rest of the ignore list (sent mail, domains, List-Unsubscribe).
//!
//! Anything else goes to the LLM, which can still call it "not job
//! related" (JT-15).
//!
//! Blocked and ignored mail is stored with its body, snippet and other
//! content cleared (see `mail::store`), keeping only who, when, the subject
//! and the reason.
//!
//! The lists are constants here for now; JT-33 makes them editable.

/// Blocked domains (and their subdomains): mail from the user's current
/// part-time job. Checked before the allow list, which can't override it.
pub const BLOCK_DOMAINS: &[&str] = &["ams.queensu.ca"];

/// Blocked single senders. Just Dayforce's `notify@`: Dayforce is also an
/// ATS some employers use for applications, so the domain stays open.
pub const BLOCK_ADDRESSES: &[&str] = &["notify@dayforce.com"];

/// ATS and assessment senders. Matched against the sender's domain and
/// all its parent domains, so `us.greenhouse-mail.io` matches
/// `greenhouse-mail.io`.
pub const ALLOW_DOMAINS: &[&str] = &[
    "greenhouse.io",
    "greenhouse-mail.io",
    "lever.co",
    "ashbyhq.com",
    "smartrecruiters.com",
    "icims.com",
    "hackerrank.com",
    "hackerrankforwork.com",
    "codesignal.com",
];

/// Domains matched by containing this text anywhere: Workday mails from
/// per-tenant hosts like `myworkday.com`, `acme.myworkdayjobs.com`, ...
pub const ALLOW_DOMAIN_CONTAINS: &[&str] = &["myworkday"];

/// Account and security mail (Google, Microsoft). Checked before the
/// applied-company rule: with a Google application, `google.com` is an
/// "applied company" domain, and these would otherwise slip through it.
pub const IGNORE_ADDRESSES: &[&str] = &[
    "no-reply@accounts.google.com",
    "noreply@accounts.google.com",
    "mail-noreply@google.com",
    "forwarding-noreply@google.com",
    "noreply-accounts@google.com",
    "workspace-noreply@google.com",
    "google-gemini-noreply@google.com",
    "account-security-noreply@accountprotection.microsoft.com",
];

/// Whole domains to ignore (and their subdomains): Google account mail
/// and newsletter platforms.
pub const IGNORE_DOMAINS: &[&str] = &[
    "accounts.google.com",
    "substack.com",
    "beehiiv.com",
    "mcsv.net",
    "mailchimpapp.net",
    "citationcanada.com",
    // Workday one-time sign-in codes. Not caught by the "myworkday" allow
    // rule, which only matches application mail hosts.
    "otp.workday.com",
];

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// On to the LLM. The reason says why it was let through.
    Pending(String),
    Ignored(String),
    /// Like ignored, but final: never restored, never sent to the LLM.
    Blocked(String),
}

impl Verdict {
    /// The `emails.status` value.
    pub fn status(&self) -> &'static str {
        match self {
            Verdict::Pending(_) => "pending",
            Verdict::Ignored(_) => "ignored",
            Verdict::Blocked(_) => "blocked",
        }
    }

    pub fn reason(&self) -> &str {
        match self {
            Verdict::Pending(r) | Verdict::Ignored(r) | Verdict::Blocked(r) => r,
        }
    }
}

/// What the filter looks at for one message.
pub struct Input<'a> {
    /// The raw `From` header, e.g. `Acme <jobs@acme.com>`.
    pub from: Option<&'a str>,
    pub list_unsubscribe: bool,
    pub label_ids: &'a [String],
}

/// `company_domains`: registrable domains of companies the user has an
/// application with (see `mail::company_domains`). Those match the
/// sender's domain exactly, not its subdomains: recruiters write from
/// `@google.com`, while `@accounts.google.com` is security mail that the
/// ignore list should still catch.
pub fn classify(input: &Input, company_domains: &[String]) -> Verdict {
    let address = input.from.map(sender_address).unwrap_or_default();
    let domain = address.rsplit_once('@').map(|(_, d)| d.to_string()).unwrap_or_default();

    // Blocked before anything: the allow list must not be able to let it
    // through.
    if let Some(d) = BLOCK_DOMAINS.iter().find(|d| is_domain_or_sub(&domain, d)) {
        return Verdict::Blocked(format!("blocked domain: {d}"));
    }
    if BLOCK_ADDRESSES.contains(&address.as_str()) {
        return Verdict::Blocked(format!("blocked sender: {address}"));
    }

    // Then allow: it wins over everything below.
    if let Some(d) = ALLOW_DOMAINS.iter().find(|d| is_domain_or_sub(&domain, d)) {
        return Verdict::Pending(format!("ats: {d}"));
    }
    if let Some(d) = ALLOW_DOMAIN_CONTAINS.iter().find(|d| domain.contains(*d)) {
        return Verdict::Pending(format!("ats: {d}"));
    }
    // Exact senders before the applied-company guess (see IGNORE_ADDRESSES).
    if IGNORE_ADDRESSES.contains(&address.as_str()) {
        return Verdict::Ignored(format!("account mail: {address}"));
    }
    if company_domains.contains(&domain) {
        return Verdict::Pending(format!("applied company: {domain}"));
    }

    if input.label_ids.iter().any(|l| l == "SENT") {
        return Verdict::Ignored("sent by you".into());
    }
    if let Some(d) = IGNORE_DOMAINS.iter().find(|d| is_domain_or_sub(&domain, d)) {
        return Verdict::Ignored(format!("ignored domain: {d}"));
    }
    if input.list_unsubscribe {
        return Verdict::Ignored("newsletter: list-unsubscribe header".into());
    }

    Verdict::Pending("no rule matched".into())
}

/// `jobs@acme.com` out of `"Acme Jobs" <JOBS@Acme.com>` (lowercased), or
/// the bare address as given.
pub fn sender_address(from: &str) -> String {
    let inner = match (from.rfind('<'), from.rfind('>')) {
        (Some(a), Some(b)) if a < b => &from[a + 1..b],
        _ => from,
    };
    inner.trim().to_ascii_lowercase()
}

/// Job boards and ATS hosts: a posting URL on one of these says nothing
/// about the company's own mail domain.
pub const JOB_BOARDS: &[&str] = &[
    "linkedin.com",
    "indeed.com",
    "glassdoor.com",
    "simplify.jobs",
    "github.com",
    "workable.com",
    "myworkdayjobs.com",
    "ashbyhq.com",
    "lever.co",
    "greenhouse.io",
    "smartrecruiters.com",
    "icims.com",
    "jobvite.com",
    "taleo.net",
    "successfactors.com",
];

pub fn is_job_board(registrable: &str) -> bool {
    JOB_BOARDS.contains(&registrable) || ALLOW_DOMAINS.contains(&registrable)
}

fn is_domain_or_sub(domain: &str, base: &str) -> bool {
    domain == base || domain.ends_with(&format!(".{base}"))
}

/// The registrable part of a host, approximately: the last two labels,
/// or three when the second-to-last is a short country second level
/// (`co.uk`, `com.au`). `careers.acme.co.uk` → `acme.co.uk`.
pub fn registrable(host: &str) -> String {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    let n = labels.len();
    let keep = if n >= 3 && matches!(labels[n - 2], "co" | "com" | "org" | "net" | "ac" | "gov") && labels[n - 1].len() == 2 {
        3
    } else {
        2
    };
    labels[n.saturating_sub(keep)..].join(".")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(from: &str, unsub: bool, labels: &[&str], companies: &[&str]) -> Verdict {
        let labels: Vec<String> = labels.iter().map(|s| s.to_string()).collect();
        let companies: Vec<String> = companies.iter().map(|s| s.to_string()).collect();
        classify(
            &Input {
                from: Some(from),
                list_unsubscribe: unsub,
                label_ids: &labels,
            },
            &companies,
        )
    }

    fn pending(v: Verdict) -> bool {
        matches!(v, Verdict::Pending(_))
    }

    #[test]
    fn ats_senders_are_allowed_even_with_list_unsubscribe() {
        assert_eq!(
            run("Acme <no-reply@us.greenhouse-mail.io>", true, &["INBOX"], &[]),
            Verdict::Pending("ats: greenhouse-mail.io".into())
        );
        assert!(pending(run("hire@lever.co", true, &[], &[])));
        assert_eq!(
            run("Acme Careers <acme@myworkday.com>", true, &[], &[]),
            Verdict::Pending("ats: myworkday".into())
        );
        assert!(pending(run("x@acme.myworkdayjobs.com", false, &[], &[])));
        assert!(pending(run("support@hackerrankforwork.com", true, &[], &[])));
        // Only real subdomains: "notgreenhouse.io" is not greenhouse.io.
        assert!(!pending(run("a@notgreenhouse.io", true, &[], &[])));
    }

    #[test]
    fn applied_company_domains_match_exactly() {
        assert_eq!(
            run("Recruiting <recruiting@robinhood.com>", true, &[], &["robinhood.com"]),
            Verdict::Pending("applied company: robinhood.com".into())
        );
        // Google application, Google security mail: still ignored.
        assert_eq!(
            run("Google <no-reply@accounts.google.com>", false, &[], &["google.com"]),
            Verdict::Ignored("account mail: no-reply@accounts.google.com".into())
        );
    }

    #[test]
    fn ignore_rules() {
        assert_eq!(
            run("Digest <digest@news.example.com>", true, &["CATEGORY_PROMOTIONS"], &[]),
            Verdict::Ignored("newsletter: list-unsubscribe header".into())
        );
        assert_eq!(
            run("someone@writer.substack.com", false, &[], &[]),
            Verdict::Ignored("ignored domain: substack.com".into())
        );
        assert_eq!(run("me@example.com", false, &["SENT"], &[]), Verdict::Ignored("sent by you".into()));
        // A plain message from an unknown sender goes on to the LLM.
        assert_eq!(
            run("Jane <jane@startup.example.com>", false, &["INBOX"], &[]),
            Verdict::Pending("no rule matched".into())
        );
    }

    #[test]
    fn blocked_beats_everything_including_allow() {
        // The part-time job's domain and its subdomains.
        assert_eq!(
            run("Shift Lead <lead@ams.queensu.ca>", false, &["INBOX"], &[]),
            Verdict::Blocked("blocked domain: ams.queensu.ca".into())
        );
        assert_eq!(
            run("x@hr.ams.queensu.ca", false, &[], &[]),
            Verdict::Blocked("blocked domain: ams.queensu.ca".into())
        );
        // Even if it looked like an applied company's domain.
        assert!(matches!(
            run("x@ams.queensu.ca", false, &[], &["ams.queensu.ca"]),
            Verdict::Blocked(_)
        ));
        // Only Dayforce's notify@ is blocked; other Dayforce senders (an
        // employer's application mail) go through the normal rules.
        assert_eq!(
            run("Dayforce <notify@dayforce.com>", false, &[], &[]),
            Verdict::Blocked("blocked sender: notify@dayforce.com".into())
        );
        assert!(pending(run("careers@dayforce.com", false, &[], &[])));
        // queensu.ca outside the AMS is not blocked.
        assert!(pending(run("registrar@queensu.ca", false, &[], &[])));
    }

    #[test]
    fn new_ignores() {
        assert_eq!(
            run("Microsoft <account-security-noreply@accountprotection.microsoft.com>", false, &[], &[]),
            Verdict::Ignored("account mail: account-security-noreply@accountprotection.microsoft.com".into())
        );
        assert_eq!(
            run("info@citationcanada.com", false, &[], &[]),
            Verdict::Ignored("ignored domain: citationcanada.com".into())
        );
    }

    #[test]
    fn google_and_workday_account_mail() {
        let google = &["google.com"];
        // With a Google application: the named account senders are still
        // ignored, but a recruiter at google.com is let through.
        for addr in [
            "noreply-accounts@google.com",
            "workspace-noreply@google.com",
            "google-gemini-noreply@google.com",
            "mail-noreply@google.com",
        ] {
            assert_eq!(
                run(&format!("Google <{addr}>"), false, &["INBOX"], google),
                Verdict::Ignored(format!("account mail: {addr}"))
            );
        }
        assert_eq!(
            run("Recruiter <recruiter@google.com>", false, &["INBOX"], google),
            Verdict::Pending("applied company: google.com".into())
        );
        // Workday sign-in codes ignored; Workday application mail allowed.
        assert_eq!(
            run("Workday <noreply@otp.workday.com>", false, &[], &[]),
            Verdict::Ignored("ignored domain: otp.workday.com".into())
        );
        assert!(pending(run("acme@myworkday.com", false, &[], &[])));
    }

    #[test]
    fn allow_beats_sent_and_ignore() {
        // Even an ATS address in an ignored-looking context stays pending.
        assert!(pending(run("x@greenhouse.io", true, &["SENT"], &[])));
    }

    #[test]
    fn address_and_domain_parsing() {
        assert_eq!(sender_address("\"Acme, Jobs\" <JOBS@Acme.com>"), "jobs@acme.com");
        assert_eq!(sender_address(" bare@x.io "), "bare@x.io");
        assert_eq!(registrable("careers.robinhood.com"), "robinhood.com");
        assert_eq!(registrable("jobs.acme.co.uk"), "acme.co.uk");
        assert_eq!(registrable("acme.com"), "acme.com");
    }
}
