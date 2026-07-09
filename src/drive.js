const { google } = require("googleapis");
const { getUser } = require("./store");
const { getAuthorizedClient } = require("./googleAuth");

const FOLDER_MIME = "application/vnd.google-apps.folder";

// Google native (Docs/Sheets/Slides/Drawings) files have no raw binary
// content — they must be exported to another format to read their content.
const GOOGLE_EXPORT_MIME = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.drawing": "image/png",
};

// Safety cap so a huge/misconfigured folder tree can't hang the connector.
const MAX_ENTRIES = 5000;

function requireSelectedFolder(userId) {
  const user = getUser(userId);
  if (!user?.selectedFolder) {
    const err = new Error("No folder connected yet");
    err.status = 400;
    throw err;
  }
  return user.selectedFolder;
}

function driveClient(userId) {
  const client = getAuthorizedClient(userId);
  return google.drive({ version: "v3", auth: client });
}

async function listChildren(drive, folderId) {
  let files = [];
  let pageToken;
  do {
    const { data } = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, size, modifiedTime)",
      pageSize: 200,
      pageToken,
      spaces: "drive",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    files = files.concat(data.files || []);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

/**
 * Recursively walks the connected root folder and returns a flat list of
 * every file and subfolder inside it (at any depth), each annotated with
 * its path relative to the root and its direct parent id. Intended to be
 * consumed by an external app/indexer that needs the full contents of the
 * folder the user connected.
 */
async function listFolderTree(userId) {
  const root = requireSelectedFolder(userId);
  const drive = driveClient(userId);

  const results = [];
  const queue = [{ id: root.id, path: [] }];
  let truncated = false;

  while (queue.length) {
    const { id, path } = queue.shift();
    const children = await listChildren(drive, id);

    for (const child of children) {
      if (results.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const isFolder = child.mimeType === FOLDER_MIME;
      results.push({
        id: child.id,
        name: child.name,
        mimeType: child.mimeType,
        isFolder,
        size: child.size || null,
        modifiedTime: child.modifiedTime,
        parentId: id,
        path: [...path, child.name].join("/"),
      });
      if (isFolder) {
        queue.push({ id: child.id, path: [...path, child.name] });
      }
    }
    if (truncated) break;
  }

  return { folder: root, files: results, truncated };
}

/**
 * Returns { meta, stream } for a file's content, suitable for piping to an
 * HTTP response. Google-native files (Docs/Sheets/Slides/Drawings) are
 * exported to a plain, indexable format since they have no raw binary body.
 */
async function getFileContent(userId, fileId) {
  const drive = driveClient(userId);
  const { data: meta } = await drive.files.get({
    fileId,
    fields: "id, name, mimeType, size, modifiedTime",
    supportsAllDrives: true,
  });

  if (meta.mimeType === FOLDER_MIME) {
    const err = new Error("Cannot fetch content of a folder");
    err.status = 400;
    throw err;
  }

  const exportMime = GOOGLE_EXPORT_MIME[meta.mimeType];
  if (exportMime) {
    const { data: stream } = await drive.files.export(
      { fileId, mimeType: exportMime, supportsAllDrives: true },
      { responseType: "stream" }
    );
    return { meta: { ...meta, mimeType: exportMime }, stream };
  }

  const { data: stream } = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream" }
  );
  return { meta, stream };
}

module.exports = { listFolderTree, getFileContent };
