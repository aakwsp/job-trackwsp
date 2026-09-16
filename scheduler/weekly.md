# Weekly internship sweep: scheduled prompt

Deep weekly sweep for Summer 2027 internships I'm qualified for. A separate daily task already covers the community GitHub lists and my priority companies, so spend this run on everything else. Prioritize accuracy over volume.

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
Summer 2027 (roughly May–Aug), including 4- and 8-month terms starting May 2027. Also match "graduating 2028", "penultimate year", "returning to school fall 2027".

### Eligibility
Include partial fits with `borderline: true` and a short reason:
- term outside summer (e.g. Jan–Aug, Sep start)
- formal co-op enrollment required
- US work authorization or US relocation required
- security clearance required
- aimed at grad students, or ML/research-heavy title
- French required
Skip only clear non-fits: new-grad/full-time, US-only, PhD-only, not in Canada or remote-Canada.

## Sources (this run)
Work through these in order:
1. Big tech with Canadian offices: Nvidia, Intel, Cisco, IBM, SAP, Salesforce, Autodesk, Uber, Lyft, Atlassian, Snowflake, Pinterest, Databricks, EA, Ubisoft.
2. Banks, insurers, trading: BMO, CIBC, Scotiabank, TD Bank, National Bank, Desjardins, Sun Life, Manulife, Intact, Goldman Sachs, and trading firms with Canadian offices (e.g. Citadel, IMC, Jane Street, Optiver).
3. Security, embedded, hardware: CSE (Communications Security Establishment), Fortinet, Field Effect, Nokia, Ericsson, Marvell, Synopsys, Cadence, Tenstorrent, and similar.
4. ATS searches with "intern 2027" plus Canada or a priority city: `site:boards.greenhouse.io`, `site:jobs.lever.co`, `site:jobs.ashbyhq.com`, `site:myworkdayjobs.com`, `site:jobs.smartrecruiters.com`.
5. Job boards: LinkedIn, Indeed Canada, Glassdoor.
6. Public sector: Government of Canada (FSWEP and department student postings), Bank of Canada, Ontario Public Service.
7. Re-check known postings that aren't applied yet: confirm they're still open, update deadlines, and mark confirmed takedowns as "closed".

If you run short on time, finish the current section, then note in the report which sections you skipped.

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
1. New postings: those whose job_key is in `inserted`, grouped by city, with company, role, req ID, deadline, borderline reason, source, and link. Non-borderline first.
2. Closing soon: known postings with `applied` false and a deadline within 7 days.
3. Closed: known postings you marked closed this run.
4. Coverage: which source sections you completed or skipped, and counts: inserted / updated / skipped.
