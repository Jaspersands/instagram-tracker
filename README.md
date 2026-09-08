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

In the Instagram app: **Settings → Accounts Center → Your information and
permissions → Download your information**.

- **All available information**
- Format: **JSON** (not HTML — HTML is unparseable here)
- Date range: **All time**

Check whether your account offers a **cloud destination with a repeating
schedule** (Google Drive, Dropbox, Koofr). If it does, point it at a synced
folder and Instagram will push fresh exports on its own — fully zero-touch. If
not, requesting an export takes about twenty seconds a month and the download
lands in a watched folder that ingests itself.

## Usage

```bash
npm install
```

Inspect an archive before trusting anything — this prints every JSON file, its
row count, and whether a parser claims it:

```bash
npm run inventory -- ~/Downloads/instagram-export.zip
```

Ingest one archive (idempotent — re-ingesting the same file is a no-op):

```bash
npm run ingest -- ~/Downloads/instagram-export.zip
```

Watch a folder and ingest anything that lands in it:

```bash
npm run watch -- ~/Dropbox/Instagram
```

Open the dashboard:

```bash
npm run serve
```

Then visit **http://127.0.0.1:4317**. It binds to loopback only — it serves your DM
history and full social graph and must never be reachable from the network.

Tabs: Overview (stat tiles + follower trend) · People (the big sortable table,
click any row for that person's full timeline) · Unfollowers · Lurk gap · Going
quiet · Habits (activity heatmap + monthly volume) · Taste.

Or from the terminal:

```bash
npm run report              # unfollowers
npm run report -- lurkers   # accounts you watch constantly and never engage with
```

The database lives at `data/instagram.db`. Override with `IG_DB=/path/to.db`, and
the dashboard port with `PORT=`.

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

## What cannot be tracked, and why

- **Who likes or comments on *your* posts.** Meta scopes exports to your own
  actions, so those live in the other person's export. Coming in Plan 3 via a
  bookmarklet that reads lists you have opened yourself.
- **Profile views and story viewers.** Not available to personal accounts through
  any route.
- **Exact unfollow timing.** Resolution is however often you export.
- **Username changes** read as churn, since the export has no stable user ID.
  Mitigated: a renamed follower keeps their original follow timestamp, so an
  unambiguous loss/gain pair sharing one is merged and flagged `probable_rename`
  rather than reported as an unfollower. Ambiguous cases are left as real churn —
  a wrong merge hides a genuine unfollower, which is worse than missing a rename.

## Privacy

`data/`, `*.db`, `exports/`, `*.zip` and `captures/` are gitignored. The database
contains your full social graph and DM history; keep it that way.
