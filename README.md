# Tracey’s Leaving Card

An interactive digital **A4 portrait** leaving card. Colleagues add handwritten-style notes or voice messages. Pages turn like a book. **Submitted messages are stored in a shared Supabase project** so every device sees the same card.

Built with plain **HTML, CSS and vanilla JavaScript**. No build step.

Do **not** invite contributors until you have completed the dashboard steps below and passed the two-device test.

## Access model

This card has **no contributor logins**. The browser uses the public anon/publishable key.

| Action | Who |
| --- | --- |
| Read all messages | Anyone with the website (and therefore the anon key) |
| Add a written or voice message | Anyone with the website |
| Change someone else’s message | Nobody via the website |
| Delete one message | Organiser, after **Admin** sign-in with a Supabase Auth email and password |
| Play a public voice message | Anyone with the website, via a short-lived signed URL |
| Play a private voice message | Someone with that note’s 4-digit PIN, or the master passcode. Admin can play it without the PIN |
| Wipe the whole card | **Not available on the website.** Use the Supabase dashboard |
| Export an offline archive | Shown only when you open the site on `localhost` on your computer |

A private Storage bucket plus signed URLs is **not** the same as authenticating visitors. An unlisted Netlify address is **not** access control. Anyone who has the website can read messages and request playback URLs.

**Admin** in the footer opens an email/password sign-in. That uses Supabase Authentication, not a password hardcoded in the website. Create the user in **Authentication → Users**. After sign-in, a delete control appears on each note. Visitors who are not signed in never see those controls.

**Export** stays on `localhost` only. That is a convenience so colleagues do not see it. It is **not** a password and **not** backend authentication.

Never put the **service_role** key, other secret keys, or the database password in any frontend file or GitHub.

## Where to put the project URL and anon key

There is **no build step**. Netlify environment variables are **not** injected into this JavaScript.

1. Open [js/supabase-config.js](js/supabase-config.js).
2. In the Supabase dashboard go to **Project Settings → API**.
3. Paste **Project URL** into `url`.
4. Paste **anon public** (publishable) into `anonKey`.
5. Deploy or refresh the site.

Leave the placeholders (`YOUR-PROJECT`, `YOUR-PUBLISHABLE-ANON-KEY`) and the app will refuse to save or load shared messages. It will not fall back to browser storage.

## What you must still do in the Supabase dashboard

1. Open your Supabase project.
2. **SQL Editor** → New query.
3. Run all of [supabase/setup.sql](supabase/setup.sql).  
   It is safe to re-run. If `public.messages` already exists with dashboard names (`audio_key`, `contributor_name`, and so on), those columns are renamed to the names the app uses. Rows are not deleted.
   If the project is already live and you only need Admin delete, run [supabase/enable-admin-delete.sql](supabase/enable-admin-delete.sql) instead.
4. If the card is already live, also run [supabase/private-voice.sql](supabase/private-voice.sql). A fresh run of `setup.sql` already includes it. Then, if Tracey should open every private note with one passcode, run the commented `insert into public.card_secrets` statement in that file with a passphrase you choose. Do not commit the passphrase.
5. **Authentication → Users → Add user** with the organiser email and password. Use that pair in the footer **Admin** control. The GitHub login that opens this dashboard is not the Admin password.
6. Confirm **Storage → Buckets** shows `voice-messages` as **private**, 5 MB limit. Admin delete removes the object from this bucket, then the `public.messages` row. Private recordings are stored under `private/` and stay unplayable until the PIN check.
7. Confirm **Table Editor → messages** shows `audio_path` (not `audio_key`) plus `type`, `name`, `text`, `font`, `duration`, `mime_type`, and `is_private`.
8. Redeploy on Netlify (`main`, empty base, empty build, publish `.`) or refresh a local server.

**Enabling RLS without the policies in `setup.sql` would hide every row from the API.**

### If a voice upload is not saved as a message

The website cannot delete Storage objects. If a recording uploads and the database row is not created:

1. Open **Table Editor → messages** and note the `audio_path` values that exist.
2. Open **Storage → voice-messages**.
3. Delete only files whose names do **not** appear as an `audio_path`.

Do not delete a file that is referenced by a submitted message.

## Two-device acceptance test

Do this before inviting colleagues:

1. Submit a written message from your computer.
2. Open the same website on your phone and confirm that message appears.
3. Record a voice message on one device (name → Record → Stop → Play → Add to card) and play it on the other.
4. Refresh both devices and confirm both submissions remain.

If a save fails, the site must show an error and must **not** say the message was added.

## Using the live card

- **Page 1** is the cover. Use **Turn the page to leave your message →**.
- **Page 2** is the only place to add a written or voice message. Editors open as dialogs so they do not stretch the A4 page.
- Further pages show submitted notes. Voice **playback** stays on those notes.
- In the voice dialog, **Make this message private (for Tracey only)** asks for a 4-digit PIN. The card then shows a lock. The PIN, or the master passcode, opens it. Admin mode plays and deletes that note without the PIN.
- The final page is always last.
- Each page is A4 portrait (210 × 297 proportions). On a wide desktop, two portrait pages may sit side by side. On a phone, one portrait page is shown.
- **Export archive** (localhost only): downloads a ZIP. Unzip and open `index.html` from disk — no internet and no local server. Messages are embedded in `js/archive-data.js`. The archive CTA reads **Open your card →**. A private recording is included only after you sign in as Admin. Otherwise the ZIP keeps the lock and omits that audio file.

## Netlify

| Field | Value |
| --- | --- |
| Branch | `main` |
| Base directory | empty |
| Build command | empty |
| Publish directory | `.` |

## Local preview and archive export

```powershell
python -m http.server 8080
```

Open http://localhost:8080. Shared messages still require a configured Supabase project. The Admin / Export control appears only on localhost.

## Project structure

```
index.html
css/styles.css
js/supabase-config.js   ← paste Project URL + anon key here
js/storage.js           ← Supabase (or offline archive); no browser fallback
js/archive.js           ← ZIP export
js/app.js
js/book.js
js/layout.js
js/fonts.js
js/messages-library.js
supabase/setup.sql
supabase/private-voice.sql
supabase/migrate-remove-unsafe-rpcs.sql
assets/bouquet.svg      ← original watercolour-style botanical SVG
assets/
```

## Completed in code vs still yours

**Done in this repository**

- Every page is A4 portrait (210÷297). Desktop may show two portrait pages; phones show one.
- Cover wording, Page 2 contribution only, revised final message, new floral SVG.
- Website reset and public wipe/orphan-delete RPCs removed.
- Shared Supabase storage preserved (Postgres + private voice bucket). No localStorage fallback.
- Offline ZIP export updated; no Supabase scripts or config file in the archive.
- Admin / Export is shown only on localhost.

**You still need to do**

- Run `supabase/setup.sql` and, if the earlier script was already applied, `supabase/migrate-remove-unsafe-rpcs.sql`. For a card that is already live, run `supabase/private-voice.sql` as well.
- Keep your Project URL and anon key in `js/supabase-config.js` (do not replace real values with placeholders).
- Deploy the updated files.
- Pass the two-device test.
- Open the site on localhost to export an archive, then open that ZIP from disk.

This update has **not** been tested against your live Supabase project from this environment. Do not share the card for collecting messages until the two-device test passes.

