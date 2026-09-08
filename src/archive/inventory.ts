import { eachJsonEntry } from './reader.js';
import { matchSource } from '../parse/registry.js';

export interface InventoryRow {
  path: string;
  size: number;
  count: number;
  sourceId: string | null;
  sampleKeys: string[];
}

export async function inventory(zipPath: string): Promise<InventoryRow[]> {
  const rows: InventoryRow[] = [];

  await eachJsonEntry(zipPath, async (src) => {
    let count = 0;
    let sampleKeys: string[] = [];
    try {
      for await (const item of src.items()) {
        if (count === 0 && item && typeof item === 'object') {
          sampleKeys = Object.keys(item as Record<string, unknown>);
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
      sourceId: matchSource(src.path)?.id ?? null,
      sampleKeys,
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
