# Wayfarer

A responsive, personal travel-expense website. The app runs in the browser and stores trip data locally on the device. Google Drive sync is still in progress and is not currently configured.

## Features in this starter

- Trips, participants, expenses, and settlements
- New trips default to INR (Indian Rupee); the trip currency can be changed
- Edit or delete expenses; remove or restore trip participants while retaining recorded history
- Equal, custom-amount, weighted, and item-by-item splits
- Likely duplicate expenses and payments trigger a confirmation but can still be recorded when they are intentional
- Repeated form submissions are ignored after a record has been saved
- Integer-cent calculations with deterministic remainder allocation
- Balances remain grouped by currency; the app does not guess exchange rates
- A per-trip "Who pays whom" plan suggests payments that settle the current balances
- Suggested payments can be recorded directly with payer, recipient, currency, and amount prefilled
- Larger, higher-contrast labels and touch controls for easier use on phones
- Google Drive sync is planned/in progress; it is not available until OAuth setup is completed
- A local browser copy for offline use
- Per-trip PDF report with trip details, expenses, splits, balances, suggested payments, and recorded payments
- Excel-compatible CSV export with expenses, item splits, balances, suggested payments, and recorded payments
- Expired trips are pruned from browser storage when the app next opens after their retention period
- Responsive layout and a small offline app-shell cache

This is a personal ledger. Participants are names in the trip, not separate user accounts, and they do not receive live updates.

Trip names, destinations, dates, and base currency can be changed from **Edit trip**; entire trips can be deleted with confirmation. Expenses and settlements can be edited or deleted, and the balances recalculate after changes. People can be managed from the trip header: names can be changed, removing a person with recorded activity keeps their history and balances but removes them from new expenses, and an unused person is deleted outright. Removed participants can be restored.

## Run locally

The app is a static website: it needs no Node.js, application server, or database. Python 3 serves the files locally, and the `just` command runner provides the start/stop shortcuts.

1. Open Terminal and change to the project folder:

   ```sh
   cd /path/to/travel-expenses
   ```

   Replace `/path/to/travel-expenses` with the actual folder location on your computer.
2. Install [`just`](https://just.systems/) if it is not already installed. On macOS with Homebrew:

   ```sh
   brew install just
   ```

3. Start the local website:

   ```sh
   just local-start
   ```

   The command starts the server in the background and returns to the shell prompt. By default, the site is at <http://localhost:8000>.
4. To stop the server, open a Terminal in the project folder and run:

   ```sh
   just local-stop
   ```

   You can run this from the same Terminal after `local-start` returns, or from another Terminal opened in the project folder. It stops only a server managed by this project's start command. If you started an older foreground server that has not returned to the prompt, stop that process with **Ctrl+C** in its original Terminal.

The server runs Python's built-in static file server, bound to your own computer (`127.0.0.1`). The project stores its server PID and output log in `.wayfarer-server-<port>.pid` and `.wayfarer-server-<port>.log`; these local runtime files are ignored by Git.

To use a different port, specify the same `PORT` for both commands. For example:

```sh
PORT=8080 just local-start
PORT=8080 just local-stop
```

Then open <http://localhost:8080>. If the page does not load, confirm the server is running and that the browser URL uses the same port.

Stopping the server does **not** clear saved trips. Trip data stays in the browser's local storage for that origin and browser profile. For example, `localhost:8000` and `localhost:8080` have separate browser storage. See [Data and privacy](#data-and-privacy) for where app data is stored. You can use the app locally without connecting Google Drive.

## Google Drive sync (in progress)

Google Drive sync is **not currently set up for use**. The app contains an initial OAuth/Drive integration, but `config.js` has no Google OAuth client ID yet. Until OAuth credentials and the required Google Cloud configuration are completed and tested, trip data is stored only in the current browser profile and does not sync between devices or get backed up to Google Drive. The steps below describe the remaining setup work; they do not mean sync is already enabled.

The planned integration uses Google's OAuth 2.0 browser flow and the restricted `drive.appdata` scope, which does not access ordinary Drive files. The OAuth client ID is public configuration, not a client secret.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Drive API**.
2. Configure the OAuth consent screen. For a personal test, leave the app in Testing and add your own Google account as a test user.
3. Create an OAuth client ID of type **Web application**.
4. Add `http://localhost:8000` to **Authorized JavaScript origins**. Add the published website's exact HTTPS origin after hosting it.
5. Put your client ID in `config.js`. The file is included in the deployed website, but it contains no secret.
6. Reload the website, then test **Connect Google Drive**, syncing, and recovery on the intended origins/devices before relying on it.

Once configured, OAuth browser tokens are intended to be kept in memory and requested again in a new browser session. Only the Google account that authorizes the app will be able to sync its data. Do not add a client secret to this static website. If you publish the site, make `config.js` available to the deployed static site; a public OAuth client ID is expected in browser code.

After the integration is configured and tested, the intended behavior is to store one data file in the Google app-data area and load it on another device after connecting the same Google account. Conflict handling and backup/recovery behavior still need end-to-end verification before depending on this as a backup.

## 30-day retention

A trip is considered expired at midnight UTC 30 days after its end date. Expired trip records are removed from the browser when the app next opens. The browser-only app cannot run a cleanup job while closed, so deletion is not guaranteed exactly at the expiry instant. Google Drive sync is not configured; no Drive copy is currently deleted by this cleanup.

PDF and CSV downloads are outside the app and are **not** automatically deleted. Delete those downloads yourself if you want them removed too. PDF export opens the browser print dialog; choose **Save as PDF** to download the report. The CSV spreadsheet can be opened in Excel.

## Publish for laptop and phone

This repository includes a GitHub Pages workflow. The repository is public, so GitHub Pages can host the static site without a separate server:

1. Push the `main` branch to GitHub.
2. In the repository, open **Settings → Pages** and select **GitHub Actions** as the build and deployment source.
3. Google Drive sync is not configured yet. When completing that work, add `https://sanjay8553.github.io` to the OAuth client's authorized JavaScript origins and test the integration on the deployed origin.
4. Never put a client secret or trip data in the repository. A public OAuth client ID may be placed in `config.js` when the Google integration is ready.
5. After the workflow completes, open `https://sanjay8553.github.io/Splitwise/` on your laptop or phone.

The app source is public in this repository; trip data is not. Currently, trip data is stored in the browser's local storage for the site origin and browser profile. Google Drive sync is still in progress, so do not rely on it for cross-device access or backup yet. GitHub Pages is subject to GitHub's current terms and usage limits.

## Data and privacy

- Trip records are currently stored in browser `localStorage` for each site origin and browser profile.
- The app does not upload receipt photos.
- Google Drive sync is not yet configured; no data is currently sent to Google Drive by the app.
- The repository must never contain expense data, access tokens, or a client secret.
- The app's 30-day cleanup only runs when the app opens. Downloaded PDF and CSV exports are separate and need to be deleted separately.
