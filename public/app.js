const videoInput = document.querySelector("#video");
const fileName = document.querySelector("#fileName");
const preview = document.querySelector("#preview");
const processBtn = document.querySelector("#processBtn");
const statusEl = document.querySelector("#status");
const logEl = document.querySelector("#log");
const result = document.querySelector("#result");
const download = document.querySelector("#download");

videoInput.addEventListener("change", () => {
  const file = videoInput.files[0];
  if (!file) return;
  fileName.textContent = file.name;
  preview.src = URL.createObjectURL(file);
});

function field(id) {
  const el = document.querySelector(`#${id}`);
  return el.type === "checkbox" ? String(el.checked) : el.value;
}

async function poll(id) {
  const res = await fetch(`/api/jobs/${id}`);
  const job = await res.json();
  statusEl.textContent = job.status || "working";
  logEl.textContent = (job.log || []).slice(-24).join("\n");
  if (job.status === "done") {
    result.src = job.output;
    download.href = job.output;
    download.download = "dead-space-cut.mp4";
    statusEl.textContent = job.captionCount ? `Done. Captions: ${job.captionCount}` : "Done.";
    processBtn.disabled = false;
    return;
  }
  if (job.status === "error") {
    statusEl.textContent = job.error || "Something went wrong";
    processBtn.disabled = false;
    return;
  }
  setTimeout(() => poll(id), 1200);
}

processBtn.addEventListener("click", async () => {
  const file = videoInput.files[0];
  if (!file) {
    statusEl.textContent = "Choose a video first.";
    return;
  }
  processBtn.disabled = true;
  result.removeAttribute("src");
  download.href = "#";
  logEl.textContent = "";
  statusEl.textContent = "Uploading...";

  const form = new FormData();
  form.append("video", file);
  for (const id of ["cutDeadspace", "deadspace", "threshold", "smoothAudio", "audioFade", "addCaptions", "captionStyle", "captionMode", "captionSize", "captionText"]) {
    form.append(id, field(id));
  }

  const res = await fetch("/api/process", { method: "POST", body: form });
  const data = await res.json();
  if (!data.id) {
    statusEl.textContent = data.error || "Could not start.";
    processBtn.disabled = false;
    return;
  }
  poll(data.id);
});
