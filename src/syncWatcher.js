const crypto = require("crypto");
const { readStore } = require("./store");
const { listFolderTree } = require("./drive");

const POLL_MS = Math.max(15, Number(process.env.SYNC_POLL_INTERVAL_SECONDS || 30)) * 1000;
const lastFingerprints = new Map();
const cachedListings = new Map();
let lastPollAt = null;
let lastPollError = null;

function webhookUrls() {
  return (process.env.WEBHOOK_URLS || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}

function fingerprintFiles(files) {
  const payload = files
    .map((file) => `${file.id}:${file.modifiedTime || ""}:${file.name}:${file.mimeType}`)
    .sort()
    .join("|");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

async function notifyWebhooks(payload) {
  const urls = webhookUrls();
  if (!urls.length) return;

  const secret = process.env.WEBHOOK_SECRET || "";
  const body = JSON.stringify({
    ...payload,
    source: "drive-connector",
    timestamp: new Date().toISOString(),
  });

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { "X-Webhook-Secret": secret } : {}),
        },
        body,
      });
      if (!res.ok) {
        const text = await res.text();
        console.warn(`Webhook ${url} returned ${res.status}: ${text.slice(0, 200)}`);
      } else {
        console.log(`Webhook delivered to ${url} (${payload.reason || "event"})`);
      }
    } catch (err) {
      console.error(`Webhook failed for ${url}:`, err.message);
    }
  }
}

function resetUserFingerprint(userId) {
  lastFingerprints.delete(userId);
  cachedListings.delete(userId);
}

function getCachedListing(userId) {
  return cachedListings.get(userId) || null;
}

async function refreshUserListing(userId, { notifyOnChange = true, reason = "poll" } = {}) {
  const data = readStore();
  const user = data.users[userId];
  if (!user?.selectedFolder) return null;

  const listing = await listFolderTree(userId);
  const fingerprint = fingerprintFiles(listing.files);
  const previous = lastFingerprints.get(userId);
  lastFingerprints.set(userId, fingerprint);

  const cachedAt = new Date().toISOString();
  cachedListings.set(userId, {
    folder: listing.folder,
    files: listing.files,
    truncated: listing.truncated,
    cachedAt,
  });

  if (!previous) {
    console.log(`Initial Drive sync snapshot for ${user.selectedFolder.name} (${listing.files.length} entries)`);
    await notifyWebhooks({
      userId,
      folder: listing.folder,
      fileCount: listing.files.length,
      reason: "initial_sync",
    });
    return listing;
  }

  if (previous !== fingerprint && notifyOnChange) {
    console.log(`Drive folder changed for ${listing.folder.name} — notifying webhooks`);
    await notifyWebhooks({
      userId,
      folder: listing.folder,
      fileCount: listing.files.length,
      reason: reason === "poll" ? "folder_changed" : reason,
    });
  }

  return listing;
}

async function pollUser(userId) {
  await refreshUserListing(userId, { notifyOnChange: true, reason: "poll" });
}

async function pollAllUsers() {
  const data = readStore();
  const userIds = Object.keys(data.users || {});
  for (const userId of userIds) {
    try {
      await pollUser(userId);
      lastPollAt = new Date().toISOString();
      lastPollError = null;
    } catch (err) {
      lastPollError = err.message;
      console.error(`Drive sync poll failed for user ${userId}:`, err.message);
    }
  }
}

let timer = null;

function startSyncWatcher() {
  if (timer) return;
  const intervalSec = POLL_MS / 1000;
  console.log(
    `Drive sync watcher started (every ${intervalSec}s` +
      `${webhookUrls().length ? `, webhooks: ${webhookUrls().join(", ")}` : ", no webhooks configured"})`
  );
  pollAllUsers().catch((err) => console.error("Initial Drive sync poll failed:", err.message));
  timer = setInterval(() => {
    pollAllUsers().catch((err) => console.error("Drive sync poll failed:", err.message));
  }, POLL_MS);
}

module.exports = {
  startSyncWatcher,
  notifyWebhooks,
  resetUserFingerprint,
  pollUser,
  getCachedListing,
  refreshUserListing,
  getSyncStatus: () => ({
    pollIntervalSeconds: POLL_MS / 1000,
    lastPollAt,
    lastPollError,
    webhookUrls: webhookUrls(),
  }),
};
