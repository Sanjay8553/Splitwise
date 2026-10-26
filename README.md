# Wayfarer

A responsive, personal travel-expense website. There is no application server or hosted database: the app runs in the browser, keeps an offline copy on the device, and can sync a single data file to the signed-in Google account's private Drive `appDataFolder`.

## Features in this starter

- Trips, participants, expenses, and settlements
- Equal, custom-amount, weighted, and item-by-item splits
- Integer-cent calculations with deterministic remainder allocation
- Balances remain grouped by currency; the app does not guess exchange rates
- Optional Google Drive sync across browsers signed in to the same Google account
- A local browser copy for offline use
- Trip export to JSON
- Expired trips are pruned when the app is opened; a later Drive sync carries deletions to Google
- Responsive layout and a small offline app-shell cache

This is a personal ledger. Participants are names in the trip, not separate user accounts, and they do not receive live updates.

## Run locally

No Node.js, package manager, backend, or database is required.

1. Open a terminal in this folder.
2. Start Python's static file server:

   ```sh
   python3 -m http.server 8000
   ```

3. Open <http://localhost:8000>.

The first trip can be created and used locally without connecting Google Drive. Browser data is specific to the browser profile and device.

## Enable Google Drive sync

The application uses Google's OAuth 2.0 browser flow and the `drive.appdata` scope. It cannot access ordinary Drive files. The OAuth client ID is public configuration, not a client secret.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Drive API**.
2. Configure the OAuth consent screen. For a personal test, leave the app in Testing and add your own Google account as a test user.
3. Create an OAuth client ID of type **Web application**.
4. Add `http://localhost:8000` to **Authorized JavaScript origins**. Add the published website's exact HTTPS origin after hosting it.
5. Put your client ID in `config.js`. The file is included in the deployed website, but it contains no secret.
6. Reload the website and select **Connect Google Drive**.

OAuth browser tokens are kept in memory and must be requested again in a new browser session. Only the Google account that authorizes the app syncs its data. Do not add a client secret to this static website. If you publish the site, make `config.js` available to the deployed static site; a public OAuth client ID is expected in browser code.

The first sync stores the current local data file in the Google app-data area. On another device, use the same Google account and connect before creating new records to load the latest copy. If both devices have made unsynced edits, the app stops rather than silently overwriting the remote file. Use one device at a time and sync after changes for the simplest experience.

Google Drive is a third-party provider. The data is not end-to-end encrypted by this app, and provider quotas and account policies apply.

## 30-day retention

A trip is considered expired at midnight UTC 30 days after its end date. Expired trip records are removed from the browser when the app next opens. They are removed from Google Drive when the app next syncs. A static website cannot run a background deletion job while it is closed, so the deletion is not guaranteed to happen exactly at the expiry instant.

Exported JSON downloads are outside the app and are **not** automatically deleted. Delete those downloads yourself if you want them removed too.

## Publish for laptop and phone

This is a static website; any static host works. A straightforward free-tier option is Cloudflare Pages:

1. Create a GitHub repository for this source and push the project.
2. In Cloudflare Pages, import that repository.
3. Choose **Direct Upload / static assets** with no build command and the repository root (`/`) as the output directory, or use the Pages Git integration with no build step.
4. Add the resulting HTTPS origin to the OAuth client's authorized JavaScript origins.
5. Ensure `config.js` is included in the deployed static files. Its OAuth client ID is visible to website visitors by design; do not place a client secret or expense records in it.

The site source contains no trip data. Keep the repository private if you prefer not to publish your source. A free hosting plan is subject to the provider's current terms and limits.

## Data and privacy

- Trip records are stored in browser `localStorage` and in one JSON file in the user's Google Drive app-data area.
- The app does not upload receipt photos.
- Google Drive access is granted only after the user chooses the Google sign-in button.
- The repository must never contain expense data, access tokens, or a client secret.
- A Google Drive export and this app's 30-day deletion policy are separate: downloaded exports need to be deleted separately.
