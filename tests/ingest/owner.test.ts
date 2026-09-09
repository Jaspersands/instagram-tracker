import { describe, it, expect } from 'vitest';
import { ownerFromPath } from '../../src/ingest/ingest.js';
import { openDb } from '../../src/db/open.js';
import { ingestAndDerive } from '../../src/ingest/pipeline.js';
import { people } from '../../src/report/queries.js';
import { makeDir } from '../helpers/makeZip.js';

describe('ownerFromPath', () => {
  it('reads the account owner out of the export folder name', () => {
    expect(ownerFromPath('/x/meta-2026-Sep-08/instagram-jasper_sands-2026-09-08-jBKMGcaq'))
      .toBe('jasper_sands');
    expect(ownerFromPath('/Downloads/instagram-someone.else-2026-01-02-abc.zip'))
      .toBe('someone.else');
  });

  it('finds it in any segment, since a transfer nests the export one deep', () => {
    expect(ownerFromPath('instagram-jasper_sands-2026-09-08-x/connections/followers_1.json'))
      .toBe('jasper_sands');
    // The wrapper folder alone carries no owner — it must come from inside.
    expect(ownerFromPath('/a/meta-2026-Sep-08-18-57-05')).toBeNull();
  });

  it('returns null when the name carries no owner', () => {
    expect(ownerFromPath('/x/export.zip')).toBeNull();
    expect(ownerFromPath('/x/meta-2026-09-08-abc.zip')).toBeNull();
  });
});

describe('the account owner is not a person you interact with', () => {
  it('excludes you from the People table', async () => {
    const db = openDb(':memory:');
    // Comments on your OWN posts name you as Media Owner.
    await ingestAndDerive(db, makeDir({
      'your_instagram_activity/comments/post_comments_1.json': {
        comments_media_comments: [
          { string_map_data: { Comment: { value: 'reply to my own post' },
                               'Media Owner': { value: 'jasper_sands' }, Time: { timestamp: 500 } } },
          { string_map_data: { Comment: { value: 'nice' },
                               'Media Owner': { value: 'bob' }, Time: { timestamp: 600 } } },
        ],
      },
    }));

    const names = people(db, 1_800_000_000).map((p) => p.username);
    expect(names).toContain('bob');
    expect(names).not.toContain('jasper_sands');
  });
});
