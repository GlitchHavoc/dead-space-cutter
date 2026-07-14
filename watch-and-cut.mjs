import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, extname, join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const inbox = join(root, 'Drop Videos Here');
const outbox = join(root, 'edited');
const logPath = join(root, 'watch-and-cut.log');
const ffmpeg = '/opt/homebrew/bin/ffmpeg';
const ffprobe = '/opt/homebrew/bin/ffprobe';
const videoExts = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv']);
const silenceNoise = '-22dB';
const minimumSilence = 0.90;
const keepEachSide = 0.25;
const edgeTrimPadding = 0.20;
const minimumRemovableGap = 0.90;
const fade = 0.020;
const pollMs = 1000;
const videoCodec = process.env.VIDEO_CODEC || 'h264_videotoolbox';
const videoBitrate = process.env.VIDEO_BITRATE || '8M';

await fs.mkdir(inbox, { recursive: true });
await fs.mkdir(outbox, { recursive: true });

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function log(message) {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${message}`;
  console.log(line);
  await fs.appendFile(logPath, `${line}\n`).catch(() => {});
}

function run(cmd, args, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = timeoutMs ? setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${basename(cmd)} timed out`));
    }, timeoutMs) : null;
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${basename(cmd)} exited ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

function safeStem(path) {
  const stem = basename(path, extname(path)).replace(/[^A-Za-z0-9 _.-]+/g, '').trim().replace(/\s+/g, '-');
  return stem || 'video';
}

function outputFor(path) { return join(outbox, `${safeStem(path)}-edited.mp4`); }

async function stable(path) {
  let last = -1;
  let same = 0;
  for (let i = 0; i < 5; i += 1) {
    const stat = await fs.stat(path).catch(() => null);
    if (!stat?.isFile()) return false;
    if (stat.size > 0 && stat.size === last) {
      same += 1;
      if (same >= 2) return true;
    } else {
      same = 0;
      last = stat.size;
    }
    await sleep(500);
  }
  return false;
}

async function duration(path) {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', path], 30000);
  return Number(stdout.trim());
}

async function detectSilences(path) {
  const timeoutMs = Math.max(120000, Math.round((await duration(path)) / 60 * 20000 + 60000));
  const { stdout, stderr } = await run(ffmpeg, ['-nostdin', '-hide_banner', '-i', path, '-vn', '-af', `silencedetect=noise=${silenceNoise}:d=${minimumSilence}`, '-f', 'null', '-'], timeoutMs);
  const starts = [];
  const silences = [];
  for (const line of `${stderr}\n${stdout}`.split(/\r?\n/)) {
    let match = line.match(/silence_start: ([0-9.]+)/);
    if (match) starts.push(Number(match[1]));
    match = line.match(/silence_end: ([0-9.]+) \| silence_duration: ([0-9.]+)/);
    if (match && starts.length) silences.push([starts.shift(), Number(match[1]), Number(match[2])]);
  }
  return silences;
}

function keepIntervals(total, silences) {
  const remove = [];
  for (const [start, end, gap] of silences) {
    if (start <= 0.02 && gap >= minimumRemovableGap) remove.push([0, Math.max(0, end - edgeTrimPadding)]);
    else if (end >= total - 0.02 && gap >= minimumRemovableGap) remove.push([Math.min(total, start + edgeTrimPadding), total]);
    else if (gap >= Math.max(minimumRemovableGap, keepEachSide * 2 + 0.03)) remove.push([start + keepEachSide, end - keepEachSide]);
  }
  remove.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of remove) {
    if (b <= a) continue;
    const previous = merged.at(-1);
    if (previous && a <= previous[1] + 0.005) previous[1] = Math.max(previous[1], b);
    else merged.push([a, b]);
  }
  const keeps = [];
  let cursor = 0;
  for (const [a, b] of merged) {
    if (a > cursor) keeps.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < total) keeps.push([cursor, total]);
  return { keeps: keeps.filter(([a, b]) => b - a > 0.04), removed: merged };
}

async function render(path, out) {
  const total = await duration(path);
  const silences = await detectSilences(path);
  let { keeps, removed } = keepIntervals(total, silences);
  if (!keeps.length) keeps = [[0, total]];
  const filters = [];
  const labels = [];
  keeps.forEach(([a, b], i) => {
    const seg = b - a;
    filters.push(`[0:v]trim=start=${a.toFixed(6)}:end=${b.toFixed(6)},setpts=PTS-STARTPTS[v${i}]`);
    let af = `[0:a]atrim=start=${a.toFixed(6)}:end=${b.toFixed(6)},asetpts=PTS-STARTPTS`;
    if (seg > fade * 3) af += `,afade=t=in:st=0:d=${fade.toFixed(3)},afade=t=out:st=${Math.max(0, seg - fade).toFixed(6)}:d=${fade.toFixed(3)}`;
    filters.push(`${af}[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  filters.push(`${labels.join('')}concat=n=${keeps.length}:v=1:a=1[v][a]`);
  const tmp = out.replace(/\.mp4$/i, '.processing.mp4');
  await fs.rm(tmp, { force: true }).catch(() => {});
  await log(`Rendering ${basename(path)}: ${keeps.length} kept segment(s), removing ${removed.reduce((sum, [a, b]) => sum + b - a, 0).toFixed(2)}s`);
  await run(ffmpeg, ['-nostdin', '-y', '-i', path, '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', '-c:v', videoCodec, '-b:v', videoBitrate, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp], 0);
  await fs.rename(tmp, out);
  return {
    inputDuration: total,
    outputDuration: keeps.reduce((sum, [a, b]) => sum + b - a, 0),
    removedSeconds: removed.reduce((sum, [a, b]) => sum + b - a, 0),
    segments: keeps.length
  };
}

async function shouldProcess(path) {
  if (basename(path).startsWith('.') || !videoExts.has(extname(path).toLowerCase())) return false;
  const out = outputFor(path);
  const [src, dst] = await Promise.all([fs.stat(path).catch(() => null), fs.stat(out).catch(() => null)]);
  return Boolean(src?.isFile()) && (!dst || dst.mtimeMs < src.mtimeMs);
}

await log(`Watching ${inbox}`);
while (true) {
  try {
    const names = await fs.readdir(inbox);
    for (const name of names.sort()) {
      const path = join(inbox, name);
      if (!(await shouldProcess(path))) continue;
      await log(`Picked up ${name}`);
      if (!(await stable(path))) {
        await log(`Waiting for copy to finish: ${name}`);
        continue;
      }
      const out = outputFor(path);
      const stats = await render(path, out);
      await log(`Edited ${name} -> ${basename(out)} ${JSON.stringify(stats)}`);
    }
  } catch (error) {
    await log(`ERROR ${error.name}: ${error.message}`);
  }
  await sleep(pollMs);
}
