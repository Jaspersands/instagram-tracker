#!/usr/bin/env python3
"""
Pull the things Instagram's export cannot give: who liked your posts, who
commented on them, and which real account is behind each DM thread.

Generalises likers.py into three jobs so the dashboard can drive it.

The session id arrives on **stdin**, never as a command-line argument: a command
line is readable by every process on the machine via `ps`, so passing a
credential that way would leak it to anything running as you. It is never
written to disk, never logged, and scrubbed out of any error text before it is
printed.

Progress is written to stdout as one JSON object per line so the caller can
stream it. Anything not machine-readable goes to stderr.
"""

import argparse
import csv
import json
import os
import random
import sys
import time

JOBS = ("likers", "threads", "comments")

# Instagram lets you pin three posts to the top of your profile, and the feed
# endpoint returns them first regardless of age. Asking it for "the newest 3"
# could therefore hand back a two-year-old pin. Over-fetch by the pin limit and
# sort by date ourselves. This costs nothing: a page is one request whether you
# ask it for 3 items or 6.
PIN_ALLOWANCE = 3


def _when(media):
    """Sortable epoch for a media. Never raises: a single undated item must not
    take down a pull that is otherwise fine, and mixing datetime with a numeric
    fallback is an unorderable-type error waiting to happen."""
    t = getattr(media, "taken_at", None)
    if t is None:
        return 0.0
    if isinstance(t, (int, float)):
        return float(t)
    try:
        return t.timestamp()
    except (AttributeError, ValueError, OSError):
        return 0.0


def newest(medias, amount):
    """The `amount` most recently posted medias, newest first.

    Sorted here rather than trusting the feed's order, which puts pinned posts
    first and is Instagram's business to change. Undated items sort last.
    """
    ordered = sorted(medias, key=_when, reverse=True)
    return ordered[:amount] if amount else ordered

_SECRET = ""


def scrub(text) -> str:
    """Remove the session id from anything we are about to print.

    instagrapi can include request context in exception messages, and a session
    id has both a raw and a percent-encoded form depending on where it came
    from, so both are replaced.
    """
    s = str(text)
    if _SECRET:
        for form in {_SECRET, _SECRET.replace(":", "%3A"), _SECRET.replace("%3A", ":")}:
            if form:
                s = s.replace(form, "<redacted>")
    return s


def emit(**kw) -> None:
    kw.setdefault("t", time.time())
    sys.stdout.write(json.dumps(kw, default=scrub) + "\n")
    sys.stdout.flush()


def log(msg) -> None:
    sys.stderr.write(scrub(msg) + "\n")
    sys.stderr.flush()


def pace(lo: float, hi: float) -> None:
    """The reason the first run completed without incident. Request volume and
    rhythm are what get accounts actioned, not reading your own data."""
    time.sleep(random.uniform(lo, hi))


# --------------------------------------------------------------------------
# jobs
# --------------------------------------------------------------------------

def job_likers(cl, medias, out_dir, lo, hi):
    """One request per post. Columns match likers.py exactly."""
    path = os.path.join(out_dir, "likers.csv")
    total = len(medias)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["post_number", "post_date", "post_url", "post_shortcode",
                    "like_count", "username", "full_name", "user_id"])
        for i, media in enumerate(medias, 1):
            url = "https://www.instagram.com/p/%s/" % media.code
            date = media.taken_at.strftime("%Y-%m-%d %H:%M:%S")
            try:
                likers = cl.media_likers(media.id)
                for u in likers:
                    w.writerow([i, date, url, media.code, media.like_count,
                                u.username, u.full_name, u.pk])
                f.flush()
                emit(event="progress", job="likers", done=i, total=total,
                     message="%s — %d of %d likers" % (media.code, len(likers),
                                                       media.like_count or 0))
            except Exception as e:            # one bad post must not lose the rest
                emit(event="warn", job="likers", done=i, total=total,
                     message="%s failed: %s" % (media.code, scrub(e)))
            if i < total:
                pace(lo, hi)
    return path


def job_comments(cl, medias, out_dir, lo, hi):
    """About one request per post. Absent from the export at every account tier."""
    path = os.path.join(out_dir, "comments.csv")
    total = len(medias)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["post_shortcode", "post_url", "post_date", "comment_id",
                    "created_at", "username", "full_name", "user_id", "text"])
        for i, media in enumerate(medias, 1):
            url = "https://www.instagram.com/p/%s/" % media.code
            date = media.taken_at.strftime("%Y-%m-%d %H:%M:%S")
            try:
                comments = cl.media_comments(media.id, amount=0)
                for c in comments:
                    ts = ""
                    got = getattr(c, "created_at_utc", None) or getattr(c, "created_at", None)
                    if got is not None:
                        try:
                            ts = int(got.timestamp())
                        except AttributeError:
                            ts = got
                    w.writerow([media.code, url, date, c.pk, ts,
                                c.user.username, c.user.full_name, c.user.pk, c.text])
                f.flush()
                emit(event="progress", job="comments", done=i, total=total,
                     message="%s — %d comments" % (media.code, len(comments)))
            except Exception as e:
                emit(event="warn", job="comments", done=i, total=total,
                     message="%s failed: %s" % (media.code, scrub(e)))
            if i < total:
                pace(lo, hi)
    return path


def job_threads(cl, out_dir, lo, hi):
    """Roughly 5-10 requests, and the highest value per request in the system:
    it reports the same thread id the export names its folders with, next to the
    real username, so DM attribution becomes an equality test instead of a guess.

    Message requests are included — those are exactly the threads least likely
    to be resolvable any other way, since the person may have no other trace.
    """
    path = os.path.join(out_dir, "threads.csv")
    threads, seen = [], set()

    def collect(label, fetch):
        try:
            emit(event="status", job="threads", message="Fetching %s…" % label)
            got = list(fetch())
            for t in got:
                if t.id not in seen:
                    seen.add(t.id)
                    threads.append(t)
            emit(event="status", job="threads", message="%s: %d thread(s)" % (label, len(got)))
        except Exception as e:
            # A pending inbox may not exist on this instagrapi version, and an
            # empty one is not an error worth failing the whole job for.
            emit(event="warn", job="threads", message="%s unavailable: %s" % (label, scrub(e)))
        pace(lo, hi)

    collect("inbox", lambda: cl.direct_threads(amount=0))
    collect("message requests", lambda: cl.direct_pending_inbox(amount=0))

    me = cl.user_id
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        # A thread has two ids. `pk` is thread_v2_id, the 15-16 digit form the
        # web client uses and the export names its folders with. `id` is the
        # 39-digit form the private API keys on. Only the first one joins to
        # anything we have; writing the second here once linked zero of 654.
        w.writerow(["thread_id", "thread_title", "is_group", "username", "full_name", "user_id",
                    "thread_id_long"])
        for n, t in enumerate(threads, 1):
            others = [u for u in (t.users or []) if str(u.pk) != str(me)]
            group = bool(getattr(t, "is_group", False)) or len(others) > 1
            for u in others:
                w.writerow([getattr(t, "pk", "") or t.id, getattr(t, "thread_title", "") or "", group,
                            u.username, u.full_name, u.pk, t.id])
            emit(event="progress", job="threads", done=n, total=len(threads),
                 message="%s — %d participant(s)%s" % (t.id, len(others), " (group)" if group else ""))
    return path


# --------------------------------------------------------------------------

def main() -> int:
    global _SECRET

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--jobs", required=True, help="comma separated: %s" % ",".join(JOBS))
    ap.add_argument("--out", required=True, help="directory to write CSVs into")
    ap.add_argument("--delay-min", type=float, default=3.0)
    ap.add_argument("--delay-max", type=float, default=6.0)
    ap.add_argument("--max-posts", type=int, default=0, help="0 = every post")
    args = ap.parse_args()

    jobs = [j.strip() for j in args.jobs.split(",") if j.strip()]
    bad = [j for j in jobs if j not in JOBS]
    if bad or not jobs:
        emit(event="error", message="unknown job(s): %s" % ", ".join(bad or ["<none given>"]))
        return 2

    lo, hi = args.delay_min, args.delay_max
    if lo > hi:
        lo, hi = hi, lo

    os.makedirs(args.out, exist_ok=True)

    # The credential comes down the pipe, not the command line.
    _SECRET = (sys.stdin.readline() or "").strip()
    if not _SECRET:
        emit(event="error", message="no session id on stdin")
        return 2

    try:
        from instagrapi import Client
    except ImportError:
        emit(event="error", message="instagrapi is not installed — pip3 install instagrapi")
        return 3

    cl = Client()
    # instagrapi's own inter-request pacing, which also covers the pagination
    # requests that my per-post sleeps below never see.
    cl.delay_range = [lo, hi]

    emit(event="status", message="Signing in…")
    try:
        cl.login_by_sessionid(_SECRET)
        me = cl.user_id
    except Exception as e:
        emit(event="error", message="Session id rejected (%s). It may have expired — "
                                    "take a fresh one from your browser cookies." % scrub(e))
        return 4
    emit(event="login", message="Signed in.", user_id=str(me))

    medias = None

    def get_medias():
        nonlocal medias
        if medias is None:
            want = args.max_posts
            emit(event="status", message="Listing your posts…" if not want
                 else "Listing your %d most recent posts…" % want)
            fetched = list(cl.iter_user_medias(
                me, amount=(want + PIN_ALLOWANCE) if want else 0))
            medias = newest(fetched, want)
            if medias:
                def day(md):
                    t = getattr(md, "taken_at", None)
                    return t.strftime("%Y-%m-%d") if hasattr(t, "strftime") else "unknown"
                emit(event="status", message="Using %d post(s): %s to %s."
                     % (len(medias), day(medias[-1]), day(medias[0])))
            else:
                emit(event="status", message="No posts found.")
        return medias

    files = []
    try:
        # Threads first: cheapest, and the most valuable per request.
        if "threads" in jobs:
            emit(event="job", job="threads", message="DM threads")
            files.append(("threads", job_threads(cl, args.out, lo, hi)))
        if "likers" in jobs:
            emit(event="job", job="likers", message="Post likers")
            files.append(("likers", job_likers(cl, get_medias(), args.out, lo, hi)))
        if "comments" in jobs:
            emit(event="job", job="comments", message="Post comments")
            files.append(("comments", job_comments(cl, get_medias(), args.out, lo, hi)))
    except KeyboardInterrupt:
        emit(event="error", message="Cancelled.")
        return 5
    except Exception as e:
        emit(event="error", message=scrub(e))
        return 1

    for kind, path in files:
        emit(event="file", job=kind, path=path)
    emit(event="done", message="Pulled %d file(s)." % len(files))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(5)
