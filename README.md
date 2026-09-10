# Instagram Tracker

A local, offline tracker for your own Instagram social graph and behaviour.
Nothing leaves your machine — there are no network calls anywhere in this codebase.

## How it works

Instagram has no API that returns a follower list, at any account tier. What it
does have is **Download Your Information**: a full JSON export of your own data.
This tool ingests those exports into SQLite, and **diffs consecutive snapshots to
find unfollowers** — which is the only way that information can be obtained
without automating a logged-in session and risking your account.

That means **your first export is only a baseline.** Unfollower detection starts
working at your second one.

## Getting your data

This is the only step that is genuinely yours — it lives behind your login, and
automating it would mean driving a logged-in session, which is what gets accounts
disabled.

In the Instagram app: **Settings → Accounts Center → Your information and
permissions → Download your information**.

- **All available information**
- Format: **JSON** (not HTML — HTML is unparseable here)
- Date range: **All time**

**Do this bit carefully, because it decides whether you ever touch this again:**
on the delivery screen, check whether your account offers a **cloud destination
with a repeating schedule** (Google Drive, Dropbox, Koofr). If it does, point it
at Google Drive and set the longest schedule offered. Instagram then pushes fresh
exports on its own, the agent ingests them, and the whole thing is genuinely
zero-touch forever.

If your account only offers a one-off download to device, that is ~20 seconds of
tapping whenever you want fresh data. The agent still does everything after that;
`npm run status` will tell you when your last export is getting stale.

## Usage

```bash
npm install
npm run install-agent
```

Then open **http://127.0.0.1:4317** — and keep using it. The agent runs the
dashboard *and* the folder watcher at login, and restarts itself if either dies,
so the site is always there.

Without it, `npm run daemon` does the same thing for as long as that terminal
lives. `npm run serve` is the dashboard alone.

That button is the whole workflow. It scans Downloads, Dropbox, Google Drive and
iCloud Drive, ingests any export or bookmarklet capture it finds, and refreshes
the page. Exports go in oldest-first so the snapshot diffs run in order, unrelated
zips are ignored, and pressing it again when nothing is new just says "up to
date" — it is safe to mash.

Set `IG_WATCH_DIRS` to scan somewhere else:

```bash
IG_WATCH_DIRS=~/Dropbox/Instagram npm run serve
```

### If you would rather not open the page

```bash
npm run auto      # same scan and ingest, from the terminal
```

### If you want it to happen without asking at all

```bash
npm run install-agent     # macOS LaunchAgent: watches at login, restarts if it dies
npm run agent-status
npm run uninstall-agent
```

Optional. The button covers the same ground on demand.

### The rest of the commands

Inspect an archive — prints every JSON file, its row count, whether a parser
claims it, and a ready-to-paste registry entry for anything unclaimed. With no
argument it finds your newest export itself:

```bash
npm run inventory
```

Ingest one archive (idempotent — re-ingesting the same file is a no-op):

```bash
npm run ingest -- ~/Downloads/instagram-export.zip
```

Watch folders in the foreground (no argument watches all the usual places):

```bash
npm run watch
```

Check where things stand — snapshot count, how stale your last export is, and
what is still unmeasured:

```bash
npm run status
```

Open the dashboard:

```bash
npm run serve
```

Then visit **http://127.0.0.1:4317**. It binds to loopback only — it serves your DM
history and full social graph and must never be reachable from the network.

Five sections, in the order the questions come up:

- **Today** — the answer first: counts, who left, who is closest, the follower
  trend. Every tile is a link into the section that explains it.
- **People** — one searchable directory of everyone. Click a row for that
  person's full timeline. A column that is empty for *everyone* is hidden and
  the reason printed, rather than repeating a misleading zero 7,000 times.
- **Connections** — who engages with you, and who is drifting: superfans,
  reciprocity, followers who never engage, quiet mutuals, and accounts you watch
  constantly without reacting.
- **You** — when you are active, how much you use Instagram, and what its own
  model thinks you like.
- **Data** — pull from Instagram, check folders, and an honest inventory of
  what is in the database and what is missing *and why*.

Or from the terminal:

```bash
npm run report              # unfollowers
npm run report -- lurkers   # accounts you watch constantly and never engage with
```

The database lives at `data/instagram.db`. Override with `IG_DB=/path/to.db`, and
the dashboard port with `PORT=`.

### Trying it before your export arrives

`data/demo.db` holds a synthetic two-snapshot dataset — 199 followers, 3
unfollowers, a username change, DM threads and captured likes — so you can click
around before your real export lands:

```bash
IG_DB=data/demo.db npm run serve
```

It is deliberately kept under a separate filename. Ingesting your real export into
it would diff your genuine followers against 199 invented ones and report about
two hundred unfollowers who never existed. Plain `npm run serve` uses
`data/instagram.db`, which starts empty and is the one you want.

**Keep the original archive filenames.** Instagram names them
`instagram-<user>-YYYY-MM-DD-<hash>.zip`, and that date is used to date the
snapshot — it is far more reliable than the file's modified time, which changes
whenever the file is copied or synced.

## What gets tracked

**Graph** — followers, following, mutuals, non-mutuals both directions,
unfollowers, new followers, pending requests, close friends, blocked, restricted.

**Your outbound activity** — every post you liked, comment you left (with text),
story like, saved post, and DM, each attributed to a person and scored with
recency decay so "most" and "least" are answerable.

**Your consumption** — `posts_viewed` and `videos_watched`, which enables the
**lurk gap**: accounts whose content you see constantly and never once engage
with. No off-the-shelf tracker shows you this.

**Your taste** — Instagram's own inferred interest model of you, followed
hashtags, search history, your posting cadence.

**Closeness** — one recency-decayed number per person (DM 5, comment 4, save 3,
story like 2.5, like 2, with a 90-day decay constant), shown relative to your
strongest tie so the column stays readable no matter how old your data is.

## Capturing who engages with you

The export contains everything *you* did, but nothing about who engaged with
*you* — that lives in other people's exports. A bookmarklet fills the gap.

Start the dashboard and open **http://127.0.0.1:4317/bookmarklet**, then drag the
button to your bookmarks bar. On one of your own posts, click the likes count,
**scroll the list to the bottom yourself**, and hit Save. Ingest it with:

```bash
npm run ingest -- ~/Downloads/ig-capture-post_likes-1757000000.json
```

or just let `npm run watch` pick it up.

**Why this is safe:** the bookmarklet makes **zero network requests** and **never
scrolls for you**. It reads text your browser already drew because you scrolled,
so Instagram cannot distinguish it from you looking at the page. That is
categorically different from a tool that logs in and enumerates lists in the
background, which is what gets accounts disabled. Tests in
`tests/server/bookmarklet.test.ts` enforce both properties so a future edit
cannot quietly break them.

This unlocks the **Inbound** tab: superfans, measured ghost followers (follow you
but appear in none of your captures), and reciprocity.

## Pulling what the export leaves out

Some things are simply absent from the export at every account tier: who liked
your posts, who commented on them, and which real account is behind each DM
thread. Those come from Instagram's private API, and the **Data** tab runs it for
you — tick what you want, choose how far back to go, paste your session id, press
Start pull. Progress streams while it runs and the results import themselves.

Likers and comments cost about one request per post, so the scope control
defaults to your **last 3 posts** once you have pulled them all once: the older
ones are not gaining engagement, and re-fetching forty of them to find two new
likes is a waste of your rate budget. Re-pulling a post you already have updates
it and adds anyone new; captures are keyed per post and likes deduplicated per
person, so repeat pulls never double-count.

`scrape.py` is the script behind the button and runs standalone too:

```bash
echo "$SESSIONID" | python3 scrape.py --jobs likers --out data/pulls --max-posts 3
```

**How the credential is handled.** The session id is a password. It goes to the
child process on **stdin**, never as a command-line argument — a command line is
readable by every process running as you via `ps`. It is never written to disk,
never logged, never stored in the browser, never put in a URL, and it is scrubbed
out of error text on both sides before anything is printed. The field is cleared
the moment the pull starts. `tests/scrape/run.test.ts` and
`tests/server/pull.test.ts` enforce each of those.

Pacing is 3–6 seconds between requests and only one pull runs at a time; two
passes at once double the request rate, which is what actually gets accounts
actioned. Nothing here is wired into the background agent — pressing the button
stays a deliberate act. See [docs/api-imports.md](docs/api-imports.md).

Requires `instagrapi` (`pip3 install instagrapi`). The dashboard checks for it and
tells you which of the two possible problems you have, since "no python" and "no
library" have different fixes.

### What the liker list is worth

A liker CSV carries one row per like, per post, with the liker's username,
display name and numeric Instagram id. Three columns each solve a different
problem the export could not:

- **username x post** gives real inbound engagement: superfans, engagement decay,
  and ghost followers measured rather than inferred.
- **display name** is what Instagram names DM thread folders after. Importing
  12,623 of them linked 264 previously-orphaned threads in one pass.
- **numeric id** is a stable identity. The export has none, so a username change
  looked like one person leaving and another arriving; where an id is known,
  identity is exact.

A post is marked complete only when the retrieved list reaches the like count
Instagram itself reported. Short lists (deactivated or blocked accounts) stay
partial, so their absences are never read as evidence that someone never engaged.

Like timestamps do not exist in this data, so events are dated to the post.

## What cannot be tracked, and why

- **Profile views.** Not available to personal accounts through any route.
- **Story viewers beyond 24 hours.** They must be captured inside the window.
- **Likes on posts you never capture.** Ghost detection is only as confident as
  the number of posts you have captured — it says so in the tab.
- **Exact unfollow timing.** Resolution is however often you export.
- **Username changes** read as churn, since the export has no stable user ID.
  Mitigated: a renamed follower keeps their original follow timestamp, so an
  unambiguous loss/gain pair sharing one is merged and flagged `probable_rename`
  rather than reported as an unfollower. Ambiguous cases are left as real churn —
  a wrong merge hides a genuine unfollower, which is worse than missing a rename.

## Privacy

`data/`, `*.db`, `exports/`, `*.zip` and `captures/` are gitignored. The database
contains your full social graph and DM history; keep it that way.

## What Meta's current export can and cannot tell you

Verified against a real September 2026 export. Meta has migrated several files
away from the older format, and in doing so **dropped the author from your
likes**. This is a limitation of the export, not of this tool.

| Signal | Rows here | Attributable to a person? |
|---|---|---|
| DMs | 86,223 | yes |
| Comment likes | 5,787 | yes |
| Story likes | 2,076 | yes, via the `/stories/<username>/` URL |
| Comments you left | 1,536 | yes |
| Accounts you unfollowed | 223 | yes, with dates |
| Profile searches | 35 | yes |
| **Liked posts** | **33,713** | **no** — the record is only `/p/<shortcode>` |
| **Saves** | **539** | **no** |
| **Posts/videos viewed** | **939** | **no** |

Unattributable events are kept in an `activity` table for their timestamps, so
the habits heatmap and volume trend still cover everything you did. They just
can't say who it was aimed at.

The practical consequence: **"who do I like most" cannot be answered from a
current export**, and the lurk gap is limited to what the bookmarklet captures.
Closeness is driven by DMs, comments and story likes instead.

If Meta restores authors, no change is needed — every handler tries the older
shape first and falls back.

### Delivery quirks worth knowing

- A **Google Drive transfer arrives unzipped**, as folders inside a
  `meta-2026-Sep-08-18-57-05` wrapper — note the month *name*, unlike the
  `2026-09-08` in a device download. Both are handled.
- **Cloud mounts are on-demand filesystems.** Reading this export's 837 JSON
  files in place took ten and a half minutes, since each cold read is a network
  fetch. Exports on a cloud mount are copied to `data/staged/` once — JSON only,
  which takes about ninety seconds and skips the 3,371 media files including DM
  attachments.
