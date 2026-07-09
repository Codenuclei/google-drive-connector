const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");

function ensureStoreFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ users: {} }, null, 2));
  }
}

function readStore() {
  ensureStoreFile();
  const raw = fs.readFileSync(STORE_FILE, "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    return { users: {} };
  }
}

function writeStore(data) {
  ensureStoreFile();
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
}

function getUser(userId) {
  const data = readStore();
  return data.users[userId] || null;
}

function upsertUser(userId, partial) {
  const data = readStore();
  data.users[userId] = { ...(data.users[userId] || {}), ...partial };
  writeStore(data);
  return data.users[userId];
}

/** Looks up which user owns a given API key. Returns the userId, or null. */
function findUserIdByApiKey(apiKey) {
  if (!apiKey) return null;
  const data = readStore();
  const entry = Object.entries(data.users).find(([, u]) => u.apiKey === apiKey);
  return entry ? entry[0] : null;
}

module.exports = { readStore, getUser, upsertUser, findUserIdByApiKey };
