//! The cheap filter that runs on every stored message before anything
//! reaches the LLM (JT-14). Each message ends up `pending` (on to the LLM in
//! JT-15) or `ignored`, with a reason either way.
//!
//! Order:
//! 1. The block list. Mail that must never reach the LLM, whatever else
//!    is true of it (the user's current part-time job). Nothing overrides it.
//! 2. The allow list's ATS senders. Win over everything below.
//! 3. Known job-alert senders (`ALERTS`: sender + subject start).
//! 4. Account and security mail (`IGNORE_ADDRESSES`, `ACCOUNT_DOMAINS`).
//!    These name senders exactly, so they beat the guesses in 6.
//! 5. Mail the user sent.
//! 6. Application mail: the sender is an applied company's domain or a
//!    subdomain of it, or the subject names one of the user's req ids or
//!    says "application", "applying", "interview" or "assessment". Never
//!    ignored by 7.
//! 7. Newsletter domains (`IGNORE_DOMAINS`).
//!
//! Anything else goes to the LLM, which decides job_alert / not_job vs a
//! real update (JT-15). A List-Unsubscribe header no longer ignores on
//! its own: AMD and Robinhood send application mail with one (JT-18).
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

/// Job-alert mail: (sender address, subject start, lowercased). Ignored
/// without an LLM call; anything else from the same sender still goes
/// through the normal rules.
pub const ALERTS: &[(&str, &str)] = &[
    ("careers-noreply@google.com", "new job(s) match your search"),
    ("donotreply@email.careers.microsoft.com", "new jobs at microsoft"),
    ("noreply@mail.amazon.jobs", "recommended amazon jobs"),
];

/// Also an alert when the subject matches this after a count, e.g.
/// "2 new job(s) at Microsoft for: ...".
pub const ALERTS_AFTER_COUNT: &[(&str, &str)] = &[("donotreply@email.careers.microsoft.com", "new job(s) at microsoft")];

/// Subject words that make mail application mail (rule 6).
pub const APPLICATION_WORDS: &[&str] = &["application", "applying", "interview", "assessment"];

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

/// Account and security domains (and their subdomains), checked with
/// `IGNORE_ADDRESSES`: `accounts.google.com` is a subdomain of an applied
/// company's domain, and would otherwise pass rule 6.
pub const ACCOUNT_DOMAINS: &[&str] = &[
    "accounts.google.com",
    "accountprotection.microsoft.com",
    // Workday one-time sign-in codes. Not caught by the "myworkday" allow
    // rule, which only matches application mail hosts.
    "otp.workday.com",
];

/// Newsletter platforms (and their subdomains).
pub const IGNORE_DOMAINS: &[&str] = &[
    "substack.com",
    "beehiiv.com",
    "mcsv.net",
    "mailchimpapp.net",
    "citationcanada.com",
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
    pub subject: Option<&'a str>,
    pub label_ids: &'a [String],
}

/// What the filter knows about the user's applications (see
/// `mail::applied`).
#[derive(Debug, Default)]
pub struct Applied {
    /// Registrable domains of companies the user has an application
    /// with. The sender's domain or any subdomain of it matches
    /// (`talent.robinhood.com`); account mail on a subdomain is caught
    /// earlier by `ACCOUNT_DOMAINS`.
    pub domains: Vec<String>,
    /// Req ids of the user's applications, lowercased.
    pub req_ids: Vec<String>,
}

pub fn classify(input: &Input, applied: &Applied) -> Verdict {
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
    let subject = input.subject.unwrap_or_default().trim().to_lowercase();
    if is_alert(&address, &subject) {
        return Verdict::Ignored(format!("job alert: {address}"));
    }
    // Exact senders before the applied-company guess (see IGNORE_ADDRESSES).
    if IGNORE_ADDRESSES.contains(&address.as_str()) {
        return Verdict::Ignored(format!("account mail: {address}"));
    }
    if let Some(d) = ACCOUNT_DOMAINS.iter().find(|d| is_domain_or_sub(&domain, d)) {
        return Verdict::Ignored(format!("account mail: {d}"));
    }
    if input.label_ids.iter().any(|l| l == "SENT") {
        return Verdict::Ignored("sent by me".into());
    }

    if let Some(d) = applied.domains.iter().find(|d| is_domain_or_sub(&domain, d)) {
        return Verdict::Pending(format!("applied company: {d}"));
    }
    if let Some(r) = applied.req_ids.iter().find(|r| contains_token(&subject, r)) {
        return Verdict::Pending(format!("subject names req id {r}"));
    }
    if let Some(w) = APPLICATION_WORDS.iter().find(|w| subject.contains(*w)) {
        return Verdict::Pending(format!("subject says \"{w}\""));
    }

    if let Some(d) = IGNORE_DOMAINS.iter().find(|d| is_domain_or_sub(&domain, d)) {
        return Verdict::Ignored(format!("ignored domain: {d}"));
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

fn is_alert(address: &str, subject: &str) -> bool {
    if ALERTS.iter().any(|(a, s)| *a == address && subject.starts_with(s)) {
        return true;
    }
    // "2 new job(s) at microsoft for: ..." → the part after the count.
    let after_count = subject.trim_start_matches(|c: char| c.is_ascii_digit()).trim_start();
    after_count.len() < subject.len()
        && ALERTS_AFTER_COUNT.iter().any(|(a, s)| *a == address && after_count.starts_with(s))
}

/// `needle` in `hay` with no letter or digit right before or after it, so
/// req id `90429` matches "2026-90429 - ..." but not "1904291".
fn contains_token(hay: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    hay.match_indices(needle).any(|(i, _)| {
        let before = hay[..i].chars().next_back();
        let after = hay[i + needle.len()..].chars().next();
        !before.is_some_and(|c| c.is_alphanumeric()) && !after.is_some_and(|c| c.is_alphanumeric())
    })
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

    fn run_s(from: &str, subject: &str, labels: &[&str], companies: &[&str], reqs: &[&str]) -> Verdict {
        let labels: Vec<String> = labels.iter().map(|s| s.to_string()).collect();
        let applied = Applied {
            domains: companies.iter().map(|s| s.to_string()).collect(),
            req_ids: reqs.iter().map(|s| s.to_string()).collect(),
        };
        classify(
            &Input {
                from: Some(from),
                subject: Some(subject),
                label_ids: &labels,
            },
            &applied,
        )
    }

    fn run(from: &str, labels: &[&str], companies: &[&str]) -> Verdict {
        run_s(from, "hello", labels, companies, &[])
    }

    fn pending(v: Verdict) -> bool {
        matches!(v, Verdict::Pending(_))
    }

    #[test]
    fn ats_senders_are_allowed() {
        assert_eq!(
            run("Acme <no-reply@us.greenhouse-mail.io>", &["INBOX"], &[]),
            Verdict::Pending("ats: greenhouse-mail.io".into())
        );
        assert!(pending(run("hire@lever.co", &[], &[])));
        assert_eq!(
            run("Acme Careers <acme@myworkday.com>", &[], &[]),
            Verdict::Pending("ats: myworkday".into())
        );
        assert!(pending(run("x@acme.myworkdayjobs.com", &[], &[])));
        assert!(pending(run("support@hackerrankforwork.com", &[], &[])));
        // Only real subdomains: "notgreenhouse.io" is not greenhouse.io.
        assert_eq!(run("a@notgreenhouse.io", &["SENT"], &[]), Verdict::Ignored("sent by me".into()));
    }

    #[test]
    fn applied_company_domains_and_subdomains() {
        assert_eq!(
            run("Recruiting <recruiting@robinhood.com>", &[], &["robinhood.com"]),
            Verdict::Pending("applied company: robinhood.com".into())
        );
        // Robinhood's rejections come from a subdomain.
        assert_eq!(
            run("Robinhood Recruiting <no-reply@talent.robinhood.com>", &[], &["robinhood.com"]),
            Verdict::Pending("applied company: robinhood.com".into())
        );
        // Google application, Google security mail: still ignored.
        assert_eq!(
            run("Google <no-reply@accounts.google.com>", &[], &["google.com"]),
            Verdict::Ignored("account mail: no-reply@accounts.google.com".into())
        );
        assert_eq!(
            run("Google <alerts@accounts.google.com>", &[], &["google.com"]),
            Verdict::Ignored("account mail: accounts.google.com".into())
        );
    }

    #[test]
    fn subject_names_the_application() {
        // The AMD case: an applied company's req id in the subject. AMD
        // mail carries List-Unsubscribe, which no longer matters.
        assert_eq!(
            run_s(
                "AMD Careers <AMD_Careers_noreply@amd-mail.example>",
                "AMD Application: 2026-90305 - Summer 2027 Long Term Graphics",
                &[],
                &[],
                &["90305"]
            ),
            Verdict::Pending("subject names req id 90305".into())
        );
        // A req id inside a longer number is not that req id.
        assert_eq!(
            run_s("x@substack.com", "order 1903051", &[], &[], &["90305"]),
            Verdict::Ignored("ignored domain: substack.com".into())
        );
        // Application words beat the newsletter domains.
        assert_eq!(
            run_s("hr@acme.substack.com", "About your application", &[], &[], &[]),
            Verdict::Pending("subject says \"application\"".into())
        );
        assert!(pending(run_s("x@mcsv.net", "Your interview on Monday", &[], &[], &[])));
        // But not account mail or sent mail.
        assert!(!pending(run_s("TD@otp.workday.com", "Verify your candidate account", &[], &[], &[])));
        assert!(!pending(run_s("me@example.com", "Re: interview", &["SENT"], &[], &[])));
    }

    #[test]
    fn known_alerts_are_ignored() {
        let google = &["google.com"];
        assert_eq!(
            run_s("careers-noreply@google.com", "New job(s) match your search on Google Careers", &[], google, &[]),
            Verdict::Ignored("job alert: careers-noreply@google.com".into())
        );
        let ms = "Microsoft Careers <donotreply@email.careers.microsoft.com>";
        assert!(!pending(run_s(ms, "New jobs at Microsoft that match your profile", &[], &["microsoft.com"], &[])));
        assert!(!pending(run_s(ms, "2 new job(s) at Microsoft for: Intern jobs in Canada", &[], &["microsoft.com"], &[])));
        assert!(!pending(run_s("noreply@mail.amazon.jobs", "Recommended Amazon jobs for Mohammad", &[], &[], &[])));
        // Same sender, other subject: through to the LLM.
        assert!(pending(run_s("careers-noreply@google.com", "Your application to Google", &[], google, &[])));
        assert!(pending(run_s(ms, "Welcome to Microsoft Careers!", &[], &["microsoft.com"], &[])));
    }

    #[test]
    fn ignore_rules() {
        assert_eq!(
            run("someone@writer.substack.com", &[], &[]),
            Verdict::Ignored("ignored domain: substack.com".into())
        );
        assert_eq!(run("me@example.com", &["SENT"], &[]), Verdict::Ignored("sent by me".into()));
        // A plain message from an unknown sender goes on to the LLM,
        // newsletter header or not.
        assert_eq!(
            run("Jane <jane@startup.example.com>", &["INBOX"], &[]),
            Verdict::Pending("no rule matched".into())
        );
    }

    #[test]
    fn blocked_beats_everything_including_allow() {
        // The part-time job's domain and its subdomains.
        assert_eq!(
            run("Shift Lead <lead@ams.queensu.ca>", &["INBOX"], &[]),
            Verdict::Blocked("blocked domain: ams.queensu.ca".into())
        );
        assert_eq!(
            run("x@hr.ams.queensu.ca", &[], &[]),
            Verdict::Blocked("blocked domain: ams.queensu.ca".into())
        );
        // Even if it looked like an applied company's domain, or named a
        // req id or an interview.
        assert!(matches!(run("x@ams.queensu.ca", &[], &["ams.queensu.ca"]), Verdict::Blocked(_)));
        assert!(matches!(
            run_s("x@ams.queensu.ca", "Interview for 90305", &[], &["queensu.ca"], &["90305"]),
            Verdict::Blocked(_)
        ));
        // Only Dayforce's notify@ is blocked; other Dayforce senders (an
        // employer's application mail) go through the normal rules.
        assert_eq!(
            run("Dayforce <notify@dayforce.com>", &[], &[]),
            Verdict::Blocked("blocked sender: notify@dayforce.com".into())
        );
        assert!(matches!(
            run_s("Dayforce <notify@dayforce.com>", "Your application", &[], &["dayforce.com"], &[]),
            Verdict::Blocked(_)
        ));
        assert!(pending(run("careers@dayforce.com", &[], &[])));
        // queensu.ca outside the AMS is not blocked.
        assert!(pending(run("registrar@queensu.ca", &[], &[])));
    }

    #[test]
    fn new_ignores() {
        assert_eq!(
            run("Microsoft <account-security-noreply@accountprotection.microsoft.com>", &[], &["microsoft.com"]),
            Verdict::Ignored("account mail: account-security-noreply@accountprotection.microsoft.com".into())
        );
        assert_eq!(
            run("info@citationcanada.com", &[], &[]),
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
                run(&format!("Google <{addr}>"), &["INBOX"], google),
                Verdict::Ignored(format!("account mail: {addr}"))
            );
        }
        assert_eq!(
            run("Recruiter <recruiter@google.com>", &["INBOX"], google),
            Verdict::Pending("applied company: google.com".into())
        );
        // Workday sign-in codes ignored; Workday application mail allowed.
        assert_eq!(
            run("Workday <noreply@otp.workday.com>", &[], &[]),
            Verdict::Ignored("account mail: otp.workday.com".into())
        );
        assert!(pending(run("acme@myworkday.com", &[], &[])));
    }

    #[test]
    fn allow_beats_sent_and_ignore() {
        // Even an ATS address in an ignored-looking context stays pending.
        assert!(pending(run("x@greenhouse.io", &["SENT"], &[])));
    }

    #[test]
    fn address_and_domain_parsing() {
        assert_eq!(sender_address("\"Acme, Jobs\" <JOBS@Acme.com>"), "jobs@acme.com");
        assert_eq!(sender_address(" bare@x.io "), "bare@x.io");
        assert_eq!(registrable("careers.robinhood.com"), "robinhood.com");
        assert_eq!(registrable("jobs.acme.co.uk"), "acme.co.uk");
        assert_eq!(registrable("acme.com"), "acme.com");
        assert!(contains_token("amd application: 2026-90429 - x", "90429"));
        assert!(!contains_token("ref 190429", "90429"));
    }
}
