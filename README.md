# Drive Connector

A self-hosted **Google Drive connector**: a user signs in with Google once, picks a folder through the native Google Picker UI, and from then on the connector exposes that folder's entire contents — recursively, including subfolders — through a small read-only REST API that any other application can call to browse, fetch, and index the data.

## Contents

- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Project structure](#project-structure)
- [Setup](#setup)
  - [1. Create Google Cloud credentials](#1-create-google-cloud-credentials)
  - [2. Configure the app](#2-configure-the-app)
  - [3. Install and run](#3-install-and-run)
- [User flow](#user-flow)
- [Connector API (for any external application)](#connector-api-for-any-external-application)
- [Notes on permissions](#notes-on-permissions)
- [Troubleshooting](#troubleshooting)
- [Extending this app](#extending-this-app)

## How it works

1. **Sign in** — the user authenticates with Google via a standard OAuth 2.0 server-side flow.
2. **Pick a folder** — the app opens Google's official **Picker** widget, where the user can browse into folders and click **Select** (Picker's equivalent of "Done") to choose whichever folder they're currently viewing.
3. **Connect** — the chosen folder's ID and name are saved server-side against that user.
4. **Index** — the connector can recursively scan the folder (including all subfolders) and serve every file's metadata and content through a JSON API, ready for another application to consume — no further action from the end user required.

The one-time OAuth consent silently provisions a long-lived **connector API key** behind the scenes so that any integrating application can call the API directly (server-to-server), without ever needing a live browser session.

## Architecture

- **Backend** — Node.js + Express (`server.js`, `src/`)
  - Handles the OAuth 2.0 authorization-code flow with Google and auto-refreshes access tokens using the stored refresh token.
  - Persists tokens, the selected folder, and the connector API key in `data/store.json`, keyed by the user's Google account ID.
  - `src/drive.js` recursively walks the connected folder tree via the Drive API v3 and streams any file's content — exporting Google-native files (Docs/Sheets/Slides/Drawings) to a plain format since they have no raw binary body.
- **Frontend** — static HTML/CSS/JS (`public/`)
  - Sign-in screen, connected-folder view, the Google Picker integration, and a read-only browser of the folder's contents.

## Project structure

```
drive connector/
├── server.js              # Express app: routes, sessions, auth wiring
├── src/
│   ├── googleAuth.js       # OAuth client, consent URL, token refresh
│   ├── drive.js            # Recursive folder listing + file content/export
│   └── store.js            # Simple JSON-file persistence layer
├── public/
│   ├── index.html           # Sign-in / connected-folder UI
│   ├── style.css
│   └── app.js               # Picker integration + folder browser
├── data/
│   └── store.json           # Runtime data: tokens, selected folder, API keys (gitignored)
├── .env.example              # Template for required environment variables
└── README.md
```

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ (or [Bun](https://bun.sh/) as a drop-in runtime/package manager)
- A Google account and access to the [Google Cloud Console](https://console.cloud.google.com/)

### 1. Create Google Cloud credentials

You need a Google Cloud project with an OAuth client and an API key. This only needs to be done once.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a new project (or pick an existing one).
2. **Enable APIs** — go to *APIs & Services → Library* and enable:
   - **Google Drive API**
   - **Google Picker API**
3. **Configure the OAuth consent screen** — go to *APIs & Services → OAuth consent screen*.
   - User type: *External* (unless you have a Google Workspace org and want *Internal*).
   - Fill in the required app info (name, support email).
   - Under **Scopes**, add: `.../auth/drive.readonly`.
   - Under **Test users** (while the app is in "Testing" mode), add the Google account(s) you'll sign in with.
   - Note: `drive.readonly` is a **sensitive** scope. While your app is unverified ("Testing" status), it works fine for test users, but each user's consent/refresh token expires after 7 days and they'll need to re-consent. Production use with real users beyond your test list requires a Google verification review.
4. **Create an OAuth Client ID** — go to *APIs & Services → Credentials → Create Credentials → OAuth client ID*.
   - Application type: **Web application**.
   - Authorized JavaScript origins: `http://localhost:3000`
   - Authorized redirect URIs: `http://localhost:3000/auth/google/callback`
   - Save it, then copy the **Client ID** and **Client Secret**.
5. **Create an API key** — go to *APIs & Services → Credentials → Create Credentials → API key*.
   - Under **Application restrictions**, choose **Websites** and add `http://localhost:3000`.
   - Under **API restrictions**, restrict it to the **Google Picker API** (and Drive API if you plan to extend the app).
   - Copy the key.

### 2. Configure the app

```bash
cp .env.example .env
```

Fill in `.env` with the values from step 1:

```
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
GOOGLE_API_KEY=your-api-key
SESSION_SECRET=any-long-random-string
PORT=3000
```

### 3. Install and run

```bash
npm install   # or: bun install
npm start     # or: bun server.js
```

Then open [http://localhost:3000](http://localhost:3000).

## User flow

| Step | What happens |
|---|---|
| Click "Sign in with Google" | Redirects to Google's OAuth consent screen requesting the `drive.readonly` scope |
| Google redirects back | Server exchanges the auth code for tokens, fetches the user's profile, stores tokens in `data/store.json`, and silently provisions a connector API key if one doesn't exist yet |
| Click "Choose a folder" | Frontend fetches a fresh access token from the server, then opens the Google Picker configured to browse/select folders |
| Navigate & click "Select" (Done) | Picker returns the chosen folder's ID and name; frontend POSTs it to the server, which saves it against the signed-in user |
| Reload / revisit | `/api/session` returns the saved folder, and the UI recursively scans + displays its contents |

## Connector API (for any external application)

This is the part meant to be consumed like an SDK by another application — a clean, language-agnostic REST API over HTTP. There's no UI screen for API keys; it's purely a backend integration credential, generated automatically the first time a user signs in.

### Authentication

Every connector endpoint accepts **either**:

- the browser session cookie (used automatically by this app's own UI), or
- an `Authorization: Bearer <connector-api-key>` header (used by any external application).

To fetch the key for the currently signed-in user (a one-time manual step for the developer integrating an app — not part of the end-user flow):

```bash
curl http://localhost:3000/api/connector-key --cookie "connect.sid=<your session cookie>"
# -> {"apiKey":"dck_...."}
```

Alternatively, read it directly from `data/store.json` on the server (`users.<googleAccountId>.apiKey`).

### Endpoints

**`GET /api/folder/files`** — recursively lists every file and subfolder inside the connected root folder.

```bash
curl http://localhost:3000/api/folder/files \
  -H "Authorization: Bearer dck_your_key_here"
```

```json
{
  "folder": { "id": "1pNW...", "name": "shared" },
  "truncated": false,
  "files": [
    {
      "id": "1abc...",
      "name": "notes.txt",
      "mimeType": "text/plain",
      "isFolder": false,
      "size": "1234",
      "modifiedTime": "2026-07-01T09:00:00.000Z",
      "parentId": "1def...",
      "path": "Project/notes.txt"
    }
  ]
}
```

**`GET /api/files/:fileId/content`** — streams a given file's content. Google-native files (Docs → plain text, Sheets → CSV, Slides → plain text, Drawings → PNG) are automatically exported since they have no raw binary body; everything else streams as-is.

```bash
curl http://localhost:3000/api/files/1abc.../content \
  -H "Authorization: Bearer dck_your_key_here" \
  -o notes.txt
```

### Example: integrating from another application

Node.js / JavaScript:

```javascript
const BASE_URL = "http://localhost:3000";
const API_KEY = process.env.DRIVE_CONNECTOR_API_KEY;

async function indexConnectedFolder() {
  const res = await fetch(`${BASE_URL}/api/folder/files`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  const { files } = await res.json();

  for (const file of files.filter((f) => !f.isFolder)) {
    const contentRes = await fetch(`${BASE_URL}/api/files/${file.id}/content`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const text = await contentRes.text();
    console.log(file.path, "->", text.length, "chars");
  }
}
```

Python:

```python
import os
import requests

BASE_URL = "http://localhost:3000"
API_KEY = os.environ["DRIVE_CONNECTOR_API_KEY"]
headers = {"Authorization": f"Bearer {API_KEY}"}

files = requests.get(f"{BASE_URL}/api/folder/files", headers=headers).json()["files"]
for file in files:
    if file["isFolder"]:
        continue
    content = requests.get(f"{BASE_URL}/api/files/{file['id']}/content", headers=headers).content
    print(file["path"], "->", len(content), "bytes")
```

Any language works the same way: enumerate via `/api/folder/files`, then fetch each file's content via `/api/files/:fileId/content`, using the `Authorization: Bearer` header.

## Notes on permissions

- `drive.readonly` is used instead of the narrower `drive.file` scope because the core requirement — reading files and subfolders that **already exist** inside the folder the user picks — is exactly what `drive.file` cannot do. `drive.file` only ever grants access to files the app itself creates; selecting an existing folder via the Picker does not unlock its pre-existing contents under that scope. `drive.readonly` is read-only (no write/delete capability), though it does apply to the user's whole Drive at the OAuth-grant level even though this connector only ever reads within the folder they connected.
- `access_type=offline` + `prompt=consent` are used during the OAuth request so a refresh token is issued, letting the server keep working after the initial access token expires (typically 1 hour) without asking the user to sign in again.
- Tokens and the connector API key are kept server-side only; the browser only ever receives a short-lived access token when it actually needs to talk to the Picker.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `redirect_uri_mismatch` on Google's consent screen | The redirect URI in `.env` doesn't exactly match one configured on the OAuth Client ID in Google Cloud Console. |
| "Access blocked: this app's request is invalid" or scope errors | The scope requested by the app (`drive.readonly`) isn't listed under **Scopes** on the OAuth consent screen — add it there. |
| "Google hasn't verified this app" warning | Expected while the app is in "Testing" publishing status — click **Advanced → Go to (app name)** to continue as a test user. |
| `Error: listen EADDRINUSE` on startup | Another process is already using the configured `PORT`. Find and stop it, or change `PORT` in `.env`. |
| Empty `files` array from `/api/folder/files` | Either the folder genuinely has no contents, or you're still on an old `drive.file`-scoped token — sign out and sign in again to re-consent with `drive.readonly`. |
| `401 Not authenticated` from the connector API | Missing/incorrect `Authorization: Bearer <key>` header, or no active session cookie. |

## Extending this app

- Add periodic or webhook-based re-scans (e.g. via [Drive push notifications](https://developers.google.com/drive/api/guides/push)) so an external index stays fresh without manual "Refresh" clicks.
- Swap the JSON file store (`src/store.js`) for a real database once you need multi-instance or production-grade persistence.
- Add per-application API keys (rather than one key per Google account) if multiple external apps need independently revocable credentials.
