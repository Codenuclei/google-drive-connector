require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");

const { getUser, upsertUser, findUserIdByApiKey } = require("./src/store");
const {
  getConsentUrl,
  handleOAuthCallback,
  getFreshAccessToken,
} = require("./src/googleAuth");
const { listFolderTree, getFileContent } = require("./src/drive");

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not signed in" });
  }
  next();
}

function generateConnectorApiKey() {
  return `dck_${crypto.randomBytes(24).toString("hex")}`;
}

/**
 * Authenticates either via the browser session cookie (used by this app's
 * own UI) or via an `Authorization: Bearer <connector-api-key>` header
 * (used by any external application integrating with the connector API).
 */
function authenticate(req, res, next) {
  if (req.session.userId) {
    req.userId = req.session.userId;
    return next();
  }

  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match) {
    const userId = findUserIdByApiKey(match[1].trim());
    if (userId) {
      req.userId = userId;
      return next();
    }
  }

  res.status(401).json({
    error:
      "Not authenticated. Sign in via the browser, or call this API with an 'Authorization: Bearer <connector-api-key>' header.",
  });
}

const REQUIRED_ENV = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "GOOGLE_API_KEY",
  "SESSION_SECRET",
];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length) {
  console.warn(
    `Warning: missing environment variables: ${missing.join(", ")}.\n` +
      "Copy .env.example to .env and fill them in (see README.md)."
  );
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax" },
  })
);
app.use(express.static(path.join(__dirname, "public")));

// --- Auth routes -----------------------------------------------------

app.get("/auth/google", (req, res) => {
  res.redirect(getConsentUrl());
});

app.get("/auth/google/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    return res.redirect(`/?error=${encodeURIComponent(error)}`);
  }
  try {
    const { userId, email } = await handleOAuthCallback(code);
    req.session.userId = userId;
    req.session.email = email;

    // Silently provision a connector API key the first time this user
    // authorizes, so any integrating application can call the connector
    // API immediately — no manual setup step for the end user.
    const user = getUser(userId);
    if (!user?.apiKey) {
      const apiKey = generateConnectorApiKey();
      upsertUser(userId, { apiKey });
      console.log(
        `Provisioned a connector API key for ${email}. ` +
          `Retrieve it via GET /api/connector-key (while signed in) or from data/store.json.`
      );
    }

    res.redirect("/");
  } catch (err) {
    console.error("OAuth callback failed:", err);
    res.redirect("/?error=oauth_failed");
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// --- App/session state -------------------------------------------------

app.get("/api/session", (req, res) => {
  if (!req.session.userId) {
    return res.json({ loggedIn: false });
  }
  const user = getUser(req.session.userId);
  res.json({
    loggedIn: true,
    email: req.session.email,
    selectedFolder: user?.selectedFolder || null,
  });
});

// Short-lived access token + public API key handed to the Picker JS client.
app.get("/api/drive-token", async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not signed in" });
  }
  try {
    const accessToken = await getFreshAccessToken(req.session.userId);
    res.json({ accessToken, apiKey: process.env.GOOGLE_API_KEY });
  } catch (err) {
    console.error("Failed to get access token:", err);
    res.status(500).json({ error: "Failed to get access token" });
  }
});

// Lets the developer integrating an external app retrieve the
// auto-provisioned connector API key without it being surfaced anywhere
// in the picker UI. Requires an active browser session (i.e. call this
// once, manually, while signed in).
app.get("/api/connector-key", requireLogin, (req, res) => {
  const user = getUser(req.session.userId);
  if (!user?.apiKey) {
    return res.status(404).json({ error: "No API key provisioned yet" });
  }
  res.json({ apiKey: user.apiKey });
});

app.post("/api/save-folder", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not signed in" });
  }
  const { id, name } = req.body || {};
  if (!id || !name) {
    return res.status(400).json({ error: "Missing folder id/name" });
  }
  const user = upsertUser(req.session.userId, {
    selectedFolder: { id, name, selectedAt: new Date().toISOString() },
  });
  res.json({ ok: true, selectedFolder: user.selectedFolder });
});

// --- Connector API: read-only access to everything inside the selected folder ---
// Intended to be called both by this app's UI and by any external app/indexer
// that needs the contents of the folder the user connected.

app.get("/api/folder/files", authenticate, async (req, res) => {
  try {
    const { folder, files, truncated } = await listFolderTree(req.userId);
    res.json({ folder, files, truncated });
  } catch (err) {
    console.error("Failed to list folder contents:", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to list folder contents" });
  }
});

app.get("/api/files/:fileId/content", authenticate, async (req, res) => {
  try {
    const { meta, stream } = await getFileContent(req.userId, req.params.fileId);
    res.setHeader("Content-Type", meta.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${meta.name}"`);
    stream.pipe(res);
  } catch (err) {
    console.error("Failed to fetch file content:", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to fetch file content" });
  }
});

app.listen(PORT, () => {
  console.log(`Drive Connector running at http://localhost:${PORT}`);
});
