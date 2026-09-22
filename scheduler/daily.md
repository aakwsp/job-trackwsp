# Daily internship check: scheduled prompt

Quick daily check for new Summer 2027 internships I'm qualified for. Keep this run fast and accurate; the weekly sweep covers everything else.

I'm a Canadian CS bachelor's student at Queen's University (Security option, Statistics minor), entering 3rd year in Fall 2026, graduating 2028, with a C and systems/low-level background.

## Scope

### Locations
Anywhere in Canada, plus remote roles open to Canadian residents. Priority cities: Toronto/GTA (incl. Markham, Mississauga), Waterloo/Kitchener, Ottawa, Vancouver (incl. Burnaby, Richmond), Montreal, Calgary, Kingston.

### Roles
Coding-based roles only:
- software engineering/development (backend, frontend, full-stack, mobile)
- systems, embedded, firmware, OS/kernel, compilers, performance
- security engineering, security research, detection/response engineering
- infrastructure, platform, DevOps, SRE, cloud
- data engineering, ML infrastructure/systems
- QA/test automation
Skip non-coding roles (pure PM, design, sales, business analyst, IT helpdesk).

### Term
Summer 2027 is the target: the role should start around May 2027. That includes 4-, 8-, 12- and 16-month terms beginning May 2027. Also match "graduating 2028", "penultimate year", "returning to school fall 2027".

Winter 2027 roles are OUT OF SCOPE, not borderline. If a posting says "Winter 2027", "Hiver 2027", "January 2027 start", "Jan-Apr", or is a 4-month winter co-op, skip it: do not verify it, do not send it, do not mention it in the report. Do not spend time confirming details of a posting you have already identified as a winter term. Fall 2026 terms and anything else that neither covers May-August 2027 nor starts in September 2027 is out of scope the same way.

Two kinds of near-miss ARE in scope, and each must be recorded with `borderline: true` and exactly this reason, so I can tell them apart at a glance:
- a term starting January 2027 that runs through the summer (e.g. Jan-Aug 2027) -> reason: "spans into summer"
- a term starting around September 2027 (e.g. Sep-Dec 2027, Sep 2027-Apr 2028) -> reason: "fall 2027 start"
If a borderline reason would combine either of these with something else (French required, clearance, ML-heavy), put the term reason first, then a semicolon, then the rest.


### Eligibility
Include partial fits with `borderline: true` and a short reason:
- formal co-op enrollment required
- US work authorization or US relocation required
- security clearance required
- aimed at grad students, or ML/research-heavy title
- French required
Skip only clear non-fits: new-grad/full-time, US-only, PhD-only, not in Canada or remote-Canada.

## Sources (this run only)
1. Community GitHub lists. Read each README and pick out Canada / remote-Canada rows added or still open:
   - https://github.com/SimplifyJobs/Summer2027-Internships
   - https://github.com/vanshb03/Summer2027-Internships
   - https://github.com/L0veRamen/Canadian-Tech-Internships-2027 (if stale, try the mirror negarprh/Canadian-Tech-Internships-2027)
2. Priority company career pages: Microsoft, Amazon (all SWE/coding internships), Google, BlackBerry QNX, AMD, Qualcomm, Shopify, Cohere, 1Password, Wealthsimple, Faire, Clio, Magnet Forensics, eSentire, Arctic Wolf, Kinaxis, Ciena, OpenText, D2L, RBC.

Don't do broad web or job-board searches in this run.

## Inbox
URL: {URL}
TOKEN: {TOKEN}

Use your code/bash tool for HTTP requests and follow redirects (`curl -sL`). Don't use `-X POST`; a body sent with `-d` is enough.

Responses sometimes come back as an HTML error page instead of JSON. If a response does not parse as JSON, wait 10 seconds and retry, up to 3 attempts. Retrying a POST is safe (writes are deduplicated). Only report a failure after all 3 attempts fail.

### Load known postings (before searching)
GET `{URL}?token={TOKEN}`. The response is `{"postings":[...]}`, with job_key, company, title, city, req_id, url, deadline, posting_status, borderline, borderline_reason, applied, source.

### Matching rules
- If a posting matches a known one (same company + req ID, or same company/title/city when there's no req ID), reuse that row's exact `company`, `title`, `city`, and `req_id` strings.
- For new postings, use the company's common full name (e.g. "TD Bank", "Visier Solutions") and copy the req ID exactly as shown.
- For postings listing several Canadian cities, use the first listed city.
- Only record postings you confirmed on the company's own site or ATS. Community lists and job boards are leads, not facts.


Never record a posting you already know is wrong, mislabeled, or a duplicate of another posting in this run. Fix it before sending, or leave it out.

### Write to the inbox
POST to `{URL}` with header `Content-Type: application/json` and body:

{"token": "{TOKEN}", "postings": [ ... ]}

Include every in-scope posting you confirmed this run, both new and known. Send batches of at most 50. Fields:
- company, title, city: strings
- req_id: string, or ""
- url: direct link to the company posting, or ""
- deadline: "YYYY-MM-DD", or ""
- posting_status: "open", "closing" (deadline within 14 days), or "closed" (only if you confirmed a known posting was taken down)
- borderline: true/false
- borderline_reason: short string, or ""
- source: where you first found it: "simplify-repo", "vansh-repo", "canada-repo", "company-site", "greenhouse", "lever", "ashby", "workday", "smartrecruiters", "linkedin", "indeed", "glassdoor", "gov"

Never send `applied`, `applied_date`, `notes`, or `imported_at`.

The response is `{"inserted":[job_keys], "updated":[job_keys], "skipped":n}`.

If the GET or POST fails, say so clearly, include the error, and fall back to listing every posting you found this run.

## Report
Only include:
1. New postings: those whose job_key is in `inserted`, summer-start roles first, then borderline ones (spans into summer, then fall 2027 start, then everything else), grouped by city, with company, role, req ID, deadline, borderline reason, and link. Non-borderline first.
2. Closing soon: known postings with `applied` false and a deadline within 7 days.
3. One line with counts: inserted / updated / skipped.

If nothing is new, say so in one line.
