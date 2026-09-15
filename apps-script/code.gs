// Job discovery inbox — upsert endpoint for the scheduled internship search.
// Scheduler owns SCHEDULER_COLS; applied/applied_date/notes are yours; imported_at is the tracker's.

const SHEET_NAME = 'postings';
const HEADERS = [
  'job_key', 'company', 'title', 'city', 'req_id', 'url',
  'deadline', 'posting_status', 'borderline', 'borderline_reason',
  'first_seen', 'last_seen',
  'applied', 'applied_date', 'notes',
  'imported_at',
];
const SCHEDULER_COLS = [
  'company', 'title', 'city', 'req_id', 'url',
  'deadline', 'posting_status', 'borderline', 'borderline_reason',
];

function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Deterministic key: company|req_id when available, else company|title|city.
function makeKey(p) {
  const c = norm(p.company);
  return norm(p.req_id)
    ? `${c}|${norm(p.req_id)}`
    : `${c}|${norm(p.title)}|${norm(p.city)}`;
}

function today() {
  return Utilities.formatDate(new Date(), 'America/Toronto', 'yyyy-MM-dd');
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function authed(token) {
  const expected = PropertiesService.getScriptProperties().getProperty('TOKEN');
  return Boolean(expected) && token === expected;
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

// GET ?token=...  -> all rows as objects (scheduler uses this to skip known jobs)
function doGet(e) {
  if (!authed(e.parameter.token)) return json({ error: 'unauthorized' });
  const rows = getSheet().getDataRange().getValues();
  const header = rows.shift();
  const postings = rows.map(r => Object.fromEntries(header.map((k, i) => [k, r[i]])));
  return json({ postings });
}

// POST { token, postings: [{ company, title, city, req_id, url, deadline,
//                            posting_status, borderline, borderline_reason }] }
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ error: 'invalid json' });
  }
  if (!authed(body.token)) return json({ error: 'unauthorized' });

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = getSheet();
    const data = sh.getDataRange().getValues();
    const header = data[0];
    const col = Object.fromEntries(header.map((k, i) => [k, i]));

    const index = new Map();
    data.slice(1).forEach((r, i) => index.set(r[col.job_key], i + 2));

    const inserted = [];
    const updated = [];
    const skipped = [];
    const d = today();

    for (const p of body.postings || []) {
      if (!p.company || !p.title) {
        skipped.push(p);
        continue;
      }
      const key = makeKey(p);
      const rowNum = index.get(key);

      if (rowNum) {
        const range = sh.getRange(rowNum, 1, 1, header.length);
        const row = range.getValues()[0];
        for (const k of SCHEDULER_COLS) {
          if (k in col && p[k] !== undefined && p[k] !== null && p[k] !== '') {
            row[col[k]] = p[k];
          }
        }
        row[col.last_seen] = d;
        range.setValues([row]);
        updated.push(key);
      } else {
        const row = new Array(header.length).fill('');
        for (const k of SCHEDULER_COLS) {
          if (k in col) row[col[k]] = p[k] ?? '';
        }
        row[col.job_key] = key;
        row[col.first_seen] = d;
        row[col.last_seen] = d;
        row[col.applied] = p.applied === true;
        sh.appendRow(row);
        index.set(key, sh.getLastRow());
        inserted.push(key);
      }
    }

    return json({ inserted, updated, skipped: skipped.length });
  } finally {
    lock.releaseLock();
  }
}
