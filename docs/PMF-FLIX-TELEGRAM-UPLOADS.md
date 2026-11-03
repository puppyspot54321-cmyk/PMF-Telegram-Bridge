# PMF-Flix Telegram media upload workflow

PMF-Flix continues to use the existing private Telegram media group and the existing PMF Telegram Bridge deployment. Videos remain in Telegram; Supabase stores movie metadata, poster URLs, upload intents and Telegram message references.

## New upload

1. In PMF-Flix Studio, create the movie and save it. Keep it in Draft or Pending until its metadata and rights are reviewed.
2. Studio creates a pending `telegram_upload_intents` row for a movie that has no mapped Telegram media.
3. Copy the caption marker shown in Studio. It has this exact form:

   `PMF_MOVIE_ID: 123`

4. Post the video to the existing private PMF Media Vault group and include that marker in the Telegram caption.
5. The bridge accepts the mapping only when the movie has a matching pending upload intent. It stores the Telegram message reference, writes the Telegram message ID to the movie row, marks the intent fulfilled and clears that movie's stream cache.
6. PMF-Flix plays the movie using `/telegram-media/<movie_id>`. The bridge resolves the mapped Telegram post and retains HTTP Range support for seeking and playback.

## Replace an existing video

Use **Prepare Upload** beside the movie in Studio. It re-opens that movie's upload intent and copies a fresh marker. Post the replacement video with that marker. The bridge updates only that movie's mapping; it does not match by filename or guess from the latest upload.

## Safety and troubleshooting

- A post without a valid `PMF_MOVIE_ID` marker remains an unassociated media reference.
- A marker without a pending upload intent is not linked to a movie.
- Never paste Telegram bot tokens, API hashes or Supabase service-role keys into captions or the client app.
- Keep the media group private and restrict posting access to trusted admins.
- Upload only content you are authorized to distribute, with documented rights and appropriate moderation.
- If playback fails, verify the upload intent is pending, the marker matches the movie ID, the bridge logs show a successful mapping, and the movie-specific stream endpoint returns HTTP 206 for a Range request.
