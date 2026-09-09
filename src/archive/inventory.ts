import { eachJsonEntry } from './reader.js';
import { classify } from '../parse/parseArchive.js';

export interface InventoryRow {
  path: string;
  size: number;
  count: number;
  sourceId: string | null;
  sampleKeys: string[];
  sample: unknown;
}

export async function inventory(zipPath: string): Promise<InventoryRow[]> {
  const rows: InventoryRow[] = [];

  await eachJsonEntry(zipPath, async (src) => {
    let count = 0;
    let sampleKeys: string[] = [];
    let sample: unknown = null;
    try {
      for await (const item of src.items()) {
        if (count === 0 && item && typeof item === 'object') {
          sampleKeys = Object.keys(item as Record<string, unknown>);
          sample = item;
        }
        count++;
      }
    } catch {
      sampleKeys = ['<unparseable>'];
    }
    rows.push({
      path: src.path,
      size: src.size,
      count,
      sourceId: classify(src.path),
      sampleKeys,
      sample,
    });
  });

  return rows.sort((a, b) => b.count - a.count);
}

export function formatInventory(rows: InventoryRow[]): string {
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1) + 'MB';
  const lines = rows.map(
    (r) =>
      `${(r.sourceId ?? 'UNMATCHED').padEnd(18)} ${String(r.count).padStart(8)}  ` +
      `${mb(r.size).padStart(8)}  ${r.path}\n` +
      `${' '.repeat(20)}keys: ${r.sampleKeys.join(', ') || '(none)'}`,
  );
  const matched = rows.filter((r) => r.sourceId).length;
  return [
    `${rows.length} JSON files, ${matched} matched, ${rows.length - matched} UNMATCHED`,
    '',
    ...lines,
  ].join('\n');
}

/**
 * For every file no parser claims, work out which family it belongs to and print
 * a ready-to-paste entry. Instagram's layout drifts, so this turns "the export
 * changed" from an investigation into an edit.
 */
export function proposeRegistry(rows: InventoryRow[]): string {
  const unmatched = rows.filter((r) => !r.sourceId && r.count > 0);
  if (unmatched.length === 0) return 'Every file with rows is claimed by a parser. Nothing to add.';

  const out: string[] = [`${unmatched.length} unmatched file(s) with rows:`, ''];

  for (const r of unmatched) {
    const file = r.path.split('/').pop() ?? r.path;
    const item = (r.sample ?? {}) as Record<string, unknown>;
    const esc = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out.push(`  ${file}  (${r.count} rows)`);

    if (r.sampleKeys.includes('string_list_data')) {
      // A non-empty title means the person is the title and value holds
      // something else (an emoji, for likes). Empty title means value is the person.
      const from = typeof item.title === 'string' && item.title.trim() ? 'title' : 'value';
      out.push(`    family: string_list_data — add to SOURCES in src/parse/registry.ts:`);
      out.push(`      { id: '${file.replace(/\.json$/, '')}', match: /${esc}$/i, usernameFrom: '${from}',`);
      out.push(`        target: { kind: 'interaction', interactionKind: 'TODO', direction: 'out' } },`);
    } else if (r.sampleKeys.includes('string_map_data')) {
      const keys = Object.keys((item.string_map_data ?? {}) as Record<string, unknown>);
      out.push(`    family: string_map_data — add to MAPS in src/parse/parseArchive.ts`);
      out.push(`      map keys: ${keys.join(', ') || '(none)'}`);
    } else if (r.sampleKeys.includes('messages') || r.sampleKeys.includes('participants')) {
      out.push(`    family: message thread — should already match isMessageFile(); check the path regex`);
    } else {
      out.push(`    family: unknown — keys: ${r.sampleKeys.join(', ') || '(none)'}`);
    }
    out.push('');
  }
  return out.join('\n');
}
