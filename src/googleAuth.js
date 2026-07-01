const { google } = require("googleapis");
const { getUser, upsertUser } = require("./store");

// Read-only access to Drive metadata + content. This is required so the
// connector can recursively browse/read pre-existing files and subfolders
// inside the folder the user picked (drive.file cannot do this — it only
// sees files the app itself creates). This scope cannot write/delete files.
const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "openid",
  "email",
  "profile",
];

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getConsentUrl() {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline", // request a refresh_token
    prompt: "consent", // always show the consent screen so we reliably get a refresh_token
    scope: SCOPES,
  });
}

/**
 * Exchanges an OAuth "code" for tokens, fetches basic profile info,
 * and persists tokens keyed by the Google account id ("sub").
 * Returns { userId, email, tokens }.
 */
async function handleOAuthCallback(code) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ auth: client, version: "v2" });
  const { data: profile } = await oauth2.userinfo.get();

  const userId = profile.id;
  const existing = getUser(userId);

  upsertUser(userId, {
    email: profile.email,
    tokens: {
      // Google only returns refresh_token on the very first consent;
      // keep the previous one if this response didn't include a new one.
      refresh_token: tokens.refresh_token || existing?.tokens?.refresh_token,
      access_token: tokens.access_token,
      expiry_date: tokens.expiry_date,
      scope: tokens.scope,
      token_type: tokens.token_type,
    },
  });

  return { userId, email: profile.email };
}

/**
 * Returns an OAuth2 client hydrated with the user's stored tokens,
 * wired to persist any auto-refreshed access token back to the store.
 * Use this for any authenticated Google API call (Drive, etc.).
 */
function getAuthorizedClient(userId) {
  const user = getUser(userId);
  if (!user || !user.tokens) {
    throw new Error("No stored credentials for this user");
  }

  const client = createOAuthClient();
  client.setCredentials(user.tokens);

  client.on("tokens", (newTokens) => {
    upsertUser(userId, {
      tokens: {
        ...user.tokens,
        ...newTokens,
        refresh_token: newTokens.refresh_token || user.tokens.refresh_token,
      },
    });
  });

  return client;
}

/**
 * Returns a valid (auto-refreshed) access token for the given user,
 * persisting any refreshed token back to the store.
 */
async function getFreshAccessToken(userId) {
  const client = getAuthorizedClient(userId);
  // Triggers a refresh under the hood if the current access token is expired.
  const { token } = await client.getAccessToken();
  if (!token) {
    throw new Error("Unable to obtain an access token");
  }
  return token;
}

module.exports = {
  SCOPES,
  createOAuthClient,
  getConsentUrl,
  handleOAuthCallback,
  getAuthorizedClient,
  getFreshAccessToken,
};
