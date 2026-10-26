# Wayfarer

A responsive, personal travel-expense website. There is no application server or hosted database: the app runs in the browser, keeps an offline copy on the device, and can sync a single data file to the signed-in Google account's private Drive `appDataFolder`.

## Features in this starter

- Trips, participants, expenses, and settlements
- Edit or delete expenses; remove or restore trip participants while retaining recorded history
- Equal, custom-amount, weighted, and item-by-item splits
- Integer-cent calculations with deterministic remainder allocation
- Balances remain grouped by currency; the app does not guess exchange rates
- A per-trip "Who pays whom" plan suggests payments that settle the current balances
- Suggested payments can be recorded directly with payer, recipient, currency, and amount prefilled
- Larger, higher-contrast labels and touch controls for easier use on phones
- Optional Google Drive sync across browsers signed in to the same Google account
- A local browser copy for offline use
- Per-trip PDF report with trip details, expenses, splits, balances, suggested payments, and recorded payments
- Excel-compatible CSV export with expenses, item splits, balances, suggested payments, and recorded payments
- Expired trips are pruned when the app is opened; a later Drive sync carries deletions to Google
- Responsive layout and a small offline app-shell cache

This is a personal ledger. Participants are names in the trip, not separate user accounts, and they do not receive live updates.

Trip names, destinations, dates, and base currency can be changed from **Edit trip**; entire trips can be deleted with confirmation. Expenses and settlements can be edited or deleted, and the balances recalculate after changes. People can be managed from the trip header: names can be changed, removing a person with recorded activity keeps their history and balances but removes them from new expenses, and an unused person is deleted outright. Removed participants can be restored.

## Run locally

No Node.js, backend, or database is required. The `just` command runner is needed for the shortcut below.

1. Open a terminal in this folder.
2. Install [`just`](https://just.systems/) if it is not installed. On macOS with Homebrew, run `brew install just`.
3. Start the site:

   ```sh
   just local-start
   ```

4. Open <http://localhost:8000>.
5. Press **Ctrl+C** in the terminal to stop the server.

The recipe uses Python's built-in static file server. To choose a different port, run `PORT=8080 just local-start` and open <http://localhost:8080>.

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

PDF and CSV downloads are outside the app and are **not** automatically deleted. Delete those downloads yourself if you want them removed too. PDF export opens the browser print dialog; choose **Save as PDF** to download the report. The CSV spreadsheet can be opened in Excel.

## Publish for laptop and phone

This repository includes a GitHub Pages workflow. The repository is public, so GitHub Pages can host the static site without a separate server:

1. Push the `main` branch to GitHub.
2. In the repository, open **Settings → Pages** and select **GitHub Actions** as the build and deployment source.
3. Add `https://sanjay8553.github.io` to the OAuth client's authorized JavaScript origins.
4. Keep the public OAuth client ID in `config.js` so the deployed website can use Google Drive. Never put a client secret or trip data in the repository.
5. After the workflow completes, open `https://sanjay8553.github.io/Splitwise/` on your laptop or phone.

The app source is public in this repository; trip data is not. It is stored in the signed-in Google account's private app-data area and in the browser's local storage. GitHub Pages is subject to GitHub's current terms and usage limits.

## Data and privacy

- Trip records are stored in browser `localStorage` and in one JSON file in the user's Google Drive app-data area.
- The app does not upload receipt photos.
- Google Drive access is granted only after the user chooses the Google sign-in button.
- The repository must never contain expense data, access tokens, or a client secret.
- A Google Drive export and this app's 30-day deletion policy are separate: downloaded exports need to be deleted separately.
