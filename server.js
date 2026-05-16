import { createServer } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import { extname, join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const root = new URL(".", import.meta.url).pathname;
const publicDir = join(root, "public");
const uploadsDir = join(root, "uploads");
const outputsDir = process.env.OUTPUTS_DIR || "/Users/strife/Desktop/Dead Space Cutter Exports";
const ffmpeg = process.env.FFMPEG || "ffmpeg";
const ffprobe = process.env.FFPROBE || "ffprobe";

await fs.mkdir(uploadsDir, { recursive: true });
await fs.mkdir(outputsDir, { recursive: true });

const jobs = new Map();

function send(res, code, body, type = "application/json") {
  const payload = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(code, { "content-type": type });
  res.end(payload);
}

function run(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const collect = (chunk, isErr) => {
      const text = chunk.toString();
      if (isErr) stderr += text;
      else stdout += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) onLine?.(line);
      }
    };
    child.stdout.on("data", (c) => collect(c, false));
    child.stderr.on("data", (c) => collect(c, true));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}\n${stderr}`));
    });
  });
}

async function parseMultipart(req) {
  const contentType = req.headers["content-type"] || "";
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.slice(1).find(Boolean);
  if (!boundary) throw new Error("Missing multipart boundary");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  const marker = Buffer.from(`--${boundary}`);
  const out = { fields: {}, files: {} };
  let pos = buffer.indexOf(marker);
  while (pos !== -1) {
    const next = buffer.indexOf(marker, pos + marker.length);
    if (next === -1) break;
    let part = buffer.subarray(pos + marker.length + 2, next - 2);
    pos = next;
    if (part.length < 4 || part.toString("utf8", 0, 2) === "--") continue;
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;
    const headers = part.subarray(0, headerEnd).toString("utf8");
    const body = part.subarray(headerEnd + 4);
    const name = headers.match(/name="([^"]+)"/)?.[1];
    const filename = headers.match(/filename="([^"]*)"/)?.[1];
    if (!name) continue;
    if (filename) {
      const safeExt = extname(filename).replace(/[^.\w]/g, "") || ".mov";
      const path = join(uploadsDir, `${randomUUID()}${safeExt}`);
      await fs.writeFile(path, body);
      out.files[name] = { path, filename };
    } else {
      out.fields[name] = body.toString("utf8");
    }
  }
  return out;
}

async function getDuration(input) {
  const { stdout } = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input]);
  return Number(stdout.trim());
}


async function getVideoInfo(input) {
  const { stdout } = await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-show_entries", "format=duration", "-of", "json", input]);
  const info = JSON.parse(stdout);
  const stream = info.streams?.[0] || {};
  return {
    duration: Number(info.format?.duration || 0),
    width: Number(stream.width || 1080),
    height: Number(stream.height || 1920)
  };
}

function parseTimecode(value) {
  const [h, m, rest] = value.replace(",", ".").split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(rest);
}

function chunkWords(words, start, end, size) {
  const chunks = [];
  const total = words.length || 1;
  for (let i = 0; i < words.length; i += size) {
    const group = words.slice(i, i + size);
    const chunkStart = start + (end - start) * (i / total);
    const chunkEnd = start + (end - start) * (Math.min(i + size, total) / total);
    chunks.push({ start: chunkStart, end: Math.max(chunkStart + 0.08, chunkEnd), words: group });
  }
  return chunks;
}

function parseCaptionChunks(raw, duration, mode) {
  const text = String(raw || "").trim();
  if (!text) return [];
  const chunkSize = mode === "oneword" ? 1 : 4;
  const srtBlocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const chunks = [];
  for (const block of srtBlocks) {
    const match = block.match(/(?:^\d+\s*\n)?(\d\d:\d\d:\d\d[,.]\d{3})\s*-->\s*(\d\d:\d\d:\d\d[,.]\d{3})\s*\n([\s\S]+)/);
    if (match) {
      const words = match[3].replace(/\n/g, " ").trim().split(/\s+/).filter(Boolean);
      chunks.push(...chunkWords(words, parseTimecode(match[1]), parseTimecode(match[2]), chunkSize));
    }
  }
  if (chunks.length) return chunks;
  const words = text.split(/\s+/).filter(Boolean);
  return chunkWords(words, 0, Math.max(0.5, duration), chunkSize);
}

function remapCaptionChunks(chunks, keep) {
  const mapped = [];
  let offset = 0;
  for (const interval of keep) {
    const length = interval.end - interval.start;
    for (const caption of chunks) {
      const start = Math.max(caption.start, interval.start);
      const end = Math.min(caption.end, interval.end);
      if (end > start) mapped.push({ ...caption, start: offset + start - interval.start, end: offset + end - interval.start });
    }
    offset += length;
  }
  return mapped;
}

function xmlEscape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function viralCaptionSvg(caption, fields) {
  const width = Number(fields._videoWidth || 1080);
  const height = Math.max(150, Math.round(width * 0.28));
  const fontSize = Math.max(28, Math.round(Number(fields.captionSize || 76) * width / 1080));
  const outline = Math.max(5, Math.round(fontSize * 0.13));
  const gap = Math.round(fontSize * 0.24);
  const words = caption.words.map((w) => w.toUpperCase());
  const active = Math.max(0, words.length - 1);
  const measure = (word) => Math.max(fontSize * 0.42, word.length * fontSize * 0.58);
  const widths = words.map(measure);
  const total = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, words.length - 1);
  let x = (width - total) / 2;
  const y = Math.round(height * 0.55);
  const rectPadX = Math.round(fontSize * 0.20);
  const rectPadY = Math.round(fontSize * 0.16);
  const rects = [];
  const texts = [];
  words.forEach((word, i) => {
    const w = widths[i];
    if (i === active) {
      rects.push(`<rect x="${Math.round(x - rectPadX)}" y="${Math.round(y - fontSize * 0.62 - rectPadY)}" width="${Math.round(w + rectPadX * 2)}" height="${Math.round(fontSize * 1.12 + rectPadY * 2)}" rx="${Math.round(fontSize * 0.16)}" fill="#ff1f55"/>`);
    }
    texts.push(`<text x="${Math.round(x + w / 2)}" y="${y}" text-anchor="middle" dominant-baseline="middle" font-family="TikTok Sans, Proxima Nova, Montserrat, Arial Black, Impact, sans-serif" font-size="${fontSize}" font-weight="900" fill="#ffffff" stroke="#050505" stroke-width="${outline}" paint-order="stroke fill" stroke-linejoin="round">${xmlEscape(word)}</text>`);
    x += w + gap;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#00ff00"/>${rects.join("")}${texts.join("")}</svg>`;
}

async function writeCaptionImages(id, captions, fields, job) {
  const paths = [];
  for (let i = 0; i < captions.length; i += 1) {
    const svg = join(outputsDir, `${id}-caption-${i}.svg`);
    await fs.writeFile(svg, viralCaptionSvg(captions[i], fields), "utf8");
    await run("qlmanage", ["-t", "-s", String(fields._videoWidth || 1080), "-o", outputsDir, svg], (line) => {
      if (/produced|thumbnail/i.test(line)) job.log.push(line);
    });
    paths.push(`${svg}.png`);
  }
  return paths;
}

function labelRef(label) {
  return `[${label}]`;
}

function buildCaptionOverlays(startLabel, captions, fields) {
  const filters = [];
  let current = startLabel;
  const margin = Math.max(20, Math.round(Number(fields._videoHeight || 1920) * 0.24));
  captions.forEach((caption, i) => {
    const inputIndex = i + 1;
    const start = Math.max(0, caption.start).toFixed(3);
    const end = Math.max(caption.start + 0.05, caption.end).toFixed(3);
    const duration = Math.max(0.05, caption.end - caption.start);
    const fadeOut = Math.max(0, duration - 0.08).toFixed(3);
    const cap = `cap${i}`;
    const out = `vcap${i}`;
    filters.push(`[${inputIndex}:v]format=rgba,colorkey=0x00ff00:0.22:0.0,fade=t=in:st=0:d=0.05:alpha=1,fade=t=out:st=${fadeOut}:d=0.05:alpha=1,setpts=PTS-STARTPTS+${start}/TB[${cap}]`);
    filters.push(`${labelRef(current)}[${cap}]overlay=x=0:y='main_h-overlay_h-${margin}':enable='between(t\,${start}\,${end})'[${out}]`);
    current = out;
  });
  return { filters, videoLabel: current };
}

async function detectSilences(input, opts, job) {
  const threshold = opts.threshold || "-35dB";
  const duration = String(opts.deadspace || "0.1");
  const silences = [];
  let current = null;
  await run(ffmpeg, ["-hide_banner", "-i", input, "-af", `silencedetect=noise=${threshold}:d=${duration}`, "-f", "null", "-"], (line) => {
    const start = line.match(/silence_start:\s*([0-9.]+)/);
    const end = line.match(/silence_end:\s*([0-9.]+)/);
    if (start) current = Number(start[1]);
    if (end && current !== null) {
      silences.push({ start: current, end: Number(end[1]) });
      current = null;
    }
    if (/silence_(start|end)/.test(line)) job.log.push(line);
  });
  return silences;
}

function keepIntervals(duration, silences) {
  let cursor = 0;
  const keep = [];
  for (const silence of silences) {
    const start = Math.max(0, Math.min(duration, silence.start));
    const end = Math.max(0, Math.min(duration, silence.end));
    if (start > cursor + 0.03) keep.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (duration > cursor + 0.03) keep.push({ start: cursor, end: duration });
  return keep.length ? keep : [{ start: 0, end: duration }];
}

function buildCutFilter(keep, audioFade = 0) {
  const parts = [];
  const concatInputs = [];
  keep.forEach((interval, i) => {
    const length = Math.max(0.01, interval.end - interval.start);
    const fade = Math.max(0, Math.min(audioFade, length / 3));
    const fadeOutStart = Math.max(0, length - fade);
    const audioFilters = fade > 0
      ? `,afade=t=in:st=0:d=${fade.toFixed(3)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fade.toFixed(3)}`
      : "";
    parts.push(`[0:v]trim=start=${interval.start}:end=${interval.end},setpts=PTS-STARTPTS[v${i}]`);
    parts.push(`[0:a]atrim=start=${interval.start}:end=${interval.end},asetpts=PTS-STARTPTS${audioFilters}[a${i}]`);
    concatInputs.push(`[v${i}][a${i}]`);
  });
  parts.push(`${concatInputs.join("")}concat=n=${keep.length}:v=1:a=1[vbase][aout]`);
  return parts.join(";");
}

async function processJob(id, file, fields) {
  const job = jobs.get(id);
  try {
    job.status = "analyzing";
    const info = await getVideoInfo(file.path);
    fields._videoWidth = info.width;
    fields._videoHeight = info.height;
    let keep = null;
    let captions = fields.addCaptions === "true"
      ? parseCaptionChunks(fields.captionText, info.duration, fields.captionMode)
      : [];

    if (fields.cutDeadspace === "true") {
      const silences = await detectSilences(file.path, fields, job);
      keep = keepIntervals(info.duration, silences);
      if (captions.length) captions = remapCaptionChunks(captions, keep);
    }

    const captionFiles = captions.length ? await writeCaptionImages(id, captions, fields, job) : [];

    job.status = "rendering";
    const output = join(outputsDir, `${id}-dead-space-cut.mp4`);
    const args = ["-y", "-i", file.path];
    captions.forEach((caption, i) => {
      const duration = Math.max(0.05, caption.end - caption.start);
      args.push("-loop", "1", "-t", duration.toFixed(3), "-i", captionFiles[i]);
    });

    const filterParts = [];
    let videoLabel = "0:v";
    let audioMap = "0:a";
    if (keep) {
      filterParts.push(buildCutFilter(keep, fields.smoothAudio === "true" ? Number(fields.audioFade || 0.03) : 0));
      videoLabel = "vbase";
      audioMap = "[aout]";
    }
    if (captions.length) {
      const overlay = buildCaptionOverlays(videoLabel, captions, fields);
      filterParts.push(...overlay.filters);
      videoLabel = overlay.videoLabel;
    }

    if (filterParts.length) {
      const videoMap = videoLabel.includes(":") ? videoLabel : `[${videoLabel}]`;
      args.push("-filter_complex", filterParts.join(";"), "-map", videoMap, "-map", audioMap);
    }

    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "192k", output);
    job.log.push(`ffmpeg ${args.join(" ")}`);
    await run(ffmpeg, args, (line) => {
      if (/time=|silence|thumbnail/.test(line)) job.log.push(line);
    });
    job.status = "done";
    job.output = `/outputs/${basename(output)}`;
    job.captionCount = captions.length;
  } catch (error) {
    job.status = "error";
    job.error = error.message;
  } finally {
    await fs.unlink(file.path).catch(() => {});
  }
}


const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, await fs.readFile(join(publicDir, "index.html"), "utf8"), "text/html");
    }
    if (req.method === "GET" && url.pathname.startsWith("/public/")) {
      const path = join(publicDir, url.pathname.replace("/public/", ""));
      return send(res, 200, await fs.readFile(path), path.endsWith(".css") ? "text/css" : "text/javascript");
    }
    if (req.method === "GET" && url.pathname.startsWith("/outputs/")) {
      const path = join(outputsDir, basename(url.pathname));
      res.writeHead(200, { "content-type": "video/mp4" });
      return createReadStream(path).pipe(res);
    }
    if (req.method === "POST" && url.pathname === "/api/process") {
      const form = await parseMultipart(req);
      if (!form.files.video) return send(res, 400, { error: "Upload a video first" });
      const id = randomUUID();
      jobs.set(id, { id, status: "queued", log: [] });
      processJob(id, form.files.video, form.fields);
      return send(res, 200, { id });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      const id = url.pathname.split("/").pop();
      return send(res, 200, jobs.get(id) || { status: "missing" });
    }
    send(res, 404, { error: "Not found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});


server.listen(5177, "127.0.0.1", () => {
  console.log("Dead Space Cutter running at http://127.0.0.1:5177");
});
