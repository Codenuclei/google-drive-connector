const els = {
  error: document.getElementById("error"),
  signedOut: document.getElementById("signed-out"),
  signedIn: document.getElementById("signed-in"),
  email: document.getElementById("email"),
  noFolder: document.getElementById("no-folder"),
  hasFolder: document.getElementById("has-folder"),
  folderName: document.getElementById("folder-name"),
  chooseBtn: document.getElementById("choose-folder-btn"),
  changeBtn: document.getElementById("change-folder-btn"),
  signoutBtn: document.getElementById("signout-btn"),
  refreshBtn: document.getElementById("refresh-files-btn"),
  refreshLabel: document.getElementById("refresh-label"),
  fileList: document.getElementById("file-list"),
  fileEmpty: document.getElementById("file-empty"),
  fileTruncated: document.getElementById("file-truncated"),
};

let pickerApiLoaded = false;

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

function renderState(state) {
  if (!state.loggedIn) {
    els.signedOut.hidden = false;
    els.signedIn.hidden = true;
    return;
  }

  els.signedOut.hidden = true;
  els.signedIn.hidden = false;
  els.email.textContent = state.email || "";

  if (state.selectedFolder) {
    els.noFolder.hidden = true;
    els.hasFolder.hidden = false;
    els.folderName.textContent = state.selectedFolder.name;
    loadFiles();
  } else {
    els.noFolder.hidden = false;
    els.hasFolder.hidden = true;
  }
}

function formatBytes(bytes) {
  if (!bytes) return "";
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

function renderFiles(files, truncated) {
  els.fileList.innerHTML = "";
  els.fileEmpty.hidden = files.length > 0;
  els.fileTruncated.hidden = !truncated;

  for (const file of files) {
    const li = document.createElement("li");
    li.className = "file-row";
    const icon = file.isFolder ? "📁" : "📄";
    const contentLink = file.isFolder
      ? ""
      : `<a href="/api/files/${file.id}/content" target="_blank" title="View/download content">Open</a>`;
    li.innerHTML = `
      <span class="file-icon">${icon}</span>
      <div class="file-info">
        <span class="file-name">${file.path}</span>
        <span class="file-meta">${file.isFolder ? "Folder" : formatBytes(file.size)}${file.size ? " · " : ""}${formatDate(file.modifiedTime)}</span>
      </div>
      <div class="file-actions">${contentLink}</div>
    `;
    els.fileList.appendChild(li);
  }
}

async function loadFiles() {
  const originalLabel = els.refreshLabel.textContent;
  els.refreshLabel.textContent = "Scanning…";
  try {
    const res = await fetch("/api/folder/files");
    if (!res.ok) throw new Error("Failed to load folder contents");
    const { files, truncated } = await res.json();
    renderFiles(files, truncated);
  } catch (err) {
    console.error(err);
    showError("Could not load this folder's contents.");
  } finally {
    els.refreshLabel.textContent = originalLabel;
  }
}

async function loadSession() {
  try {
    const res = await fetch("/api/session");
    const state = await res.json();
    renderState(state);
  } catch (err) {
    showError("Could not reach the server. Please refresh and try again.");
  }
}

async function openDrivePicker() {
  try {
    const res = await fetch("/api/drive-token");
    if (!res.ok) throw new Error("Failed to fetch access token");
    const { accessToken, apiKey } = await res.json();

    if (!pickerApiLoaded) {
      await new Promise((resolve) => gapi.load("picker", resolve));
      pickerApiLoaded = true;
    }

    const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMimeTypes("application/vnd.google-apps.folder");

    const picker = new google.picker.PickerBuilder()
      .setTitle("Choose a folder")
      .addView(view)
      .setOAuthToken(accessToken)
      .setDeveloperKey(apiKey)
      .setCallback(onPicked)
      .build();

    picker.setVisible(true);
  } catch (err) {
    console.error(err);
    showError("Could not open the folder picker. Please try again.");
  }
}

async function onPicked(data) {
  if (data.action !== google.picker.Action.PICKED) return;

  const doc = data.docs[0];
  try {
    const res = await fetch("/api/save-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: doc.id, name: doc.name }),
    });
    if (!res.ok) throw new Error("Failed to save folder");
    await loadSession();
  } catch (err) {
    console.error(err);
    showError("Could not save your folder selection. Please try again.");
  }
}

els.chooseBtn.addEventListener("click", openDrivePicker);
els.changeBtn.addEventListener("click", openDrivePicker);
els.refreshBtn.addEventListener("click", loadFiles);

els.signoutBtn.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.reload();
});

const params = new URLSearchParams(window.location.search);
if (params.get("error")) {
  showError("Sign-in failed. Please try again.");
  window.history.replaceState({}, "", "/");
}

loadSession();
