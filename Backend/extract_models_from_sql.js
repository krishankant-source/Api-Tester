/**
 * extract_models_from_sql.cjs
 * ─────────────────────────────────────────────────────────────
 * One-time (re-runnable) importer for an `html_documentation` SQLite dump.
 *
 * Each INSERT row is:  VALUES(id,'apiId','operations',replace('<html>','\n',char(10)),'addedAt','updatedAt')
 * where <html> is SQLite-escaped: single quotes doubled ('') and real
 * newlines written as the two-char sequence \n (because of the replace()).
 *
 * We turn every row into Backend/Models/<apiId>__<operations>.html, which the
 * existing modelsLoader.js parses automatically under the "Models" source.
 *
 * Usage:  node extract_models_from_sql.cjs <path-to.sql>
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sqlPath = process.argv[2];
if (!sqlPath) {
    console.error('Usage: node extract_models_from_sql.js <path-to.sql>');
    process.exit(1);
}

const MODELS_DIR = path.join(__dirname, 'Models');
fs.mkdirSync(MODELS_DIR, { recursive: true });

const sql = fs.readFileSync(sqlPath, 'utf8');
const lines = sql.split('\n');

/** Read a SQLite single-quoted string starting at `start` (the char after the opening quote).
 *  Returns { value, end } where end is the index of the closing quote. '' = literal quote. */
function readSqlString(s, start) {
    let out = '';
    let i = start;
    while (i < s.length) {
        const c = s[i];
        if (c === "'") {
            if (s[i + 1] === "'") { out += "'"; i += 2; continue; }
            return { value: out, end: i };
        }
        out += c;
        i++;
    }
    return { value: out, end: i };
}

function sanitize(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

let written = 0;
const skipped = [];

for (const line of lines) {
    if (!line.startsWith('INSERT INTO')) continue;

    // id, apiId, operations are simple (no embedded quotes), then the html_doc arg.
    const head = line.match(/VALUES\((\d+),'([^']*)','([^']*)',/);
    if (!head) { skipped.push(line.slice(0, 80)); continue; }

    const [, , apiId, operations] = head;
    let cursor = head.index + head[0].length;

    // html_doc is either replace('<html>','\n',char(10)) or a plain '<html>'.
    let html;
    if (line.startsWith("replace('", cursor)) {
        const { value, end } = readSqlString(line, cursor + "replace('".length);
        html = value.replace(/\\n/g, '\n');           // undo the SQLite replace()
        cursor = end;
    } else if (line[cursor] === "'") {
        const { value } = readSqlString(line, cursor + 1);
        html = value;
    } else {
        skipped.push(`${apiId}__${operations} (unrecognized html_doc form)`);
        continue;
    }

    const file = path.join(MODELS_DIR, `${sanitize(apiId)}__${sanitize(operations)}.html`);
    fs.writeFileSync(file, html, 'utf8');
    written++;
}

console.log(`Wrote ${written} HTML file(s) to ${MODELS_DIR}`);
if (skipped.length) {
    console.log(`Skipped ${skipped.length} row(s):`);
    for (const s of skipped) console.log(`  - ${s}`);
}
