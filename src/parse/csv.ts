/**
 * Minimal RFC4180 CSV reader. Node has none built in, and a naive split(',')
 * would corrupt any display name containing a comma — "Sands, Kate" is exactly
 * the sort of value in this data.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else field += c;
      continue;
    }

    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift();
  if (!header) return [];

  return rows
    .filter((r) => r.some((v) => v !== ''))
    .map((r) => {
      const o: Record<string, string> = {};
      header.forEach((h, i) => { o[h] = r[i] ?? ''; });
      return o;
    });
}
