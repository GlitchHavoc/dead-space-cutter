const els = {
  videoInput: document.querySelector("#videoInput"),
  dropZone: document.querySelector("#dropZone"),
  refreshBtn: document.querySelector("#refreshBtn"),
  processExistingBtn: document.querySelector("#processExistingBtn"),
  statusText: document.querySelector("#statusText"),
  dropList: document.querySelector("#dropList"),
  editedList: document.querySelector("#editedList"),
  dropCount: document.querySelector("#dropCount"),
  editedCount: document.querySelector("#editedCount"),
  logText: document.querySelector("#logText"),
  lastUpdated: document.querySelector("#lastUpdated"),
};

els.dropZone.addEventListener("click", () => els.videoInput.click());
els.videoInput.addEventListener("change", () => {
  const [file] = els.videoInput.files || [];
  if (file) uploadVideo(file);
  els.videoInput.value = "";
});
els.refreshBtn.addEventListener("click", refreshStatus);
els.processExistingBtn.addEventListener("click", processExisting);

["dragenter", "dragover"].forEach((eventName) => {
  els.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropZone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  els.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropZone.classList.remove("dragging");
  });
});

els.dropZone.addEventListener("drop", (event) => {
  const [file] = event.dataTransfer.files || [];
  if (file) uploadVideo(file);
});

async function uploadVideo(file) {
  setBusy(true, `Editing ${file.name}...`);
  const body = new FormData();
  body.append("video", file);

  try {
    const response = await fetch("/api/upload", { method: "POST", body });
    const result = await readJson(response);
    setStatus(result.message || "Video edited");
  } catch (error) {
    setStatus(error.message || "Upload failed");
  } finally {
    setBusy(false);
    refreshStatus();
  }
}

async function processExisting() {
  setBusy(true, "Processing videos already in the drop folder...");
  try {
    const response = await fetch("/api/process-existing", { method: "POST" });
    const result = await readJson(response);
    setStatus(result.message || "Finished processing drop folder");
  } catch (error) {
    setStatus(error.message || "Processing failed");
  } finally {
    setBusy(false);
    refreshStatus();
  }
}

async function refreshStatus() {
  try {
    const response = await fetch("/api/status");
    const status = await readJson(response);
    renderFiles(els.dropList, status.drop_files, false);
    renderFiles(els.editedList, status.edited_files, true);
    els.dropCount.textContent = status.drop_files.length;
    els.editedCount.textContent = status.edited_files.length;
    els.logText.textContent = status.log_tail || "No activity yet.";
    els.lastUpdated.textContent = new Date().toLocaleTimeString();
  } catch (error) {
    setStatus(error.message || "Could not refresh status");
  }
}

function renderFiles(list, files, downloadable) {
  list.textContent = "";
  if (!files.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = downloadable ? "No edited videos yet" : "No videos waiting";
    list.append(empty);
    return;
  }

  files.forEach((file) => {
    const row = document.createElement("li");
    row.className = "file-item";

    const info = document.createElement("div");
    const name = document.createElement("div");
    const meta = document.createElement("div");
    name.className = "file-name";
    meta.className = "file-meta";
    name.textContent = file.name;
    meta.textContent = `${file.size_label} · ${file.modified_label}`;
    info.append(name, meta);
    row.append(info);

    if (downloadable) {
      const link = document.createElement("a");
      link.href = file.url;
      link.textContent = "Open";
      link.target = "_blank";
      row.append(link);
    }

    list.append(row);
  });
}

async function readJson(response) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}

function setBusy(isBusy, message = "") {
  els.processExistingBtn.disabled = isBusy;
  els.refreshBtn.disabled = isBusy;
  if (message) setStatus(message);
}

function setStatus(message) {
  els.statusText.textContent = message;
}

refreshStatus();
setInterval(refreshStatus, 3000);
