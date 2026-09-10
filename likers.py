from instagrapi import Client
from getpass import getpass
import csv
import time
import random

cl = Client()

sessionid = getpass("Instagram sessionid: ").strip()

print("Logging in...")
cl.login_by_sessionid(sessionid)
print(f"Logged in. User ID: {cl.user_id}")

# Get all posts/reels/carousels from your profile
medias = list(cl.iter_user_medias(cl.user_id, amount=0))

print(f"Found {len(medias)} posts\n")

output_file = "all_instagram_likers.csv"

with open(output_file, "w", newline="", encoding="utf-8") as f:
    writer = csv.writer(f)

    writer.writerow([
        "post_number",
        "post_date",
        "post_url",
        "post_shortcode",
        "like_count",
        "username",
        "full_name",
        "user_id"
    ])

    for i, media in enumerate(medias, 1):

        post_url = f"https://www.instagram.com/p/{media.code}/"
        date = media.taken_at.strftime("%Y-%m-%d %H:%M:%S")

        print(
            f"[{i}/{len(medias)}] "
            f"{date} | {media.code} | "
            f"Instagram says {media.like_count} likes"
        )

        try:
            likers = cl.media_likers(media.id)

            print(f"    Retrieved {len(likers)} likers")

            for user in likers:
                writer.writerow([
                    i,
                    date,
                    post_url,
                    media.code,
                    media.like_count,
                    user.username,
                    user.full_name,
                    user.pk
                ])

            # Make sure this post is written to disk immediately
            f.flush()

        except Exception as e:
            print(f"    ERROR: {e}")

        # Don't hammer Instagram
        if i < len(medias):
            delay = random.uniform(3, 6)
            print(f"    Waiting {delay:.1f}s...\n")
            time.sleep(delay)

print(f"\nDone. Saved everything to {output_file}")