import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';

export interface Candidate {
  label: string;
  file: string;
  metadata?: string;
}

export interface ReviewGroup {
  id: string;
  title: string;
  note: string;
  audioFile?: string;
  candidates: Candidate[];
}

function html(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function media(relative: string, candidate: Candidate): string {
  if (/\.(mp4|webm)$/i.test(candidate.file)) {
    return `<video src="${html(relative)}" controls muted playsinline></video>`;
  }
  return `<img src="${html(relative)}" alt="${html(candidate.label)}">`;
}

export function writeChoiceReview(
  outputFile: string,
  title: string,
  commandPrefix: string,
  groups: ReviewGroup[],
): string {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const sections = groups
    .map((group) => {
      const candidates = group.candidates
        .map((candidate, index) => {
          const relative = path.relative(path.dirname(outputFile), candidate.file);
          return `<label class="card">
  <input type="radio" name="${html(group.id)}" value="${index + 1}">
  ${media(relative, candidate)}
  <strong>${html(candidate.label)}</strong>
  <small>${html(candidate.metadata ?? '')}</small>
</label>`;
        })
        .join('\n');
      const audio = group.audioFile
        ? `<audio controls preload="none" src="${html(path.relative(path.dirname(outputFile), group.audioFile))}"></audio>`
        : '';
      return `<section data-group="${html(group.id)}">
  <header><h2>${html(group.title)}</h2><p>${html(group.note)}</p>${audio}</header>
  <div class="grid">${candidates}</div>
</section>`;
    })
    .join('\n');
  const document = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(title)}</title>
<style>
:root{color-scheme:dark;--bg:#0d1117;--panel:#161b22;--line:#30363d;--muted:#8b949e;--accent:#f0b35a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:#f0f3f6;font:15px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
main{max-width:1180px;margin:auto;padding:30px}h1{font-size:25px}h2{font-size:17px;margin:0}header p,.intro,small{color:var(--muted)}
section{padding:20px 0;border-top:1px solid var(--line)}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px;margin-top:12px}
.card{display:grid;gap:8px;padding:10px;border:1px solid var(--line);border-radius:12px;background:var(--panel);cursor:pointer}
.card:has(input:checked){border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 30%,transparent)}
.card input{accent-color:var(--accent)}img,video{width:100%;aspect-ratio:9/16;object-fit:cover;border-radius:8px;background:#05070a}
.bar{position:sticky;bottom:0;padding:15px;background:#0d1117ee;border-top:1px solid var(--line);backdrop-filter:blur(10px)}
button{border:0;border-radius:8px;padding:10px 16px;background:var(--accent);color:#251603;font-weight:700;cursor:pointer}
audio{width:min(100%,420px)}
code{display:block;margin-top:10px;white-space:pre-wrap;color:#d2a8ff}
</style>
</head>
<body><main>
<h1>${html(title)}</h1>
<p class="intro">先完成每组单选，再复制命令回到终端执行。圈选结果只有经 CLI 落盘后才算通过关卡。</p>
${sections}
</main>
<div class="bar"><button id="copy">复制批准命令</button><code id="command"></code></div>
<script>
const prefix=${JSON.stringify(commandPrefix)};
const command=document.querySelector('#command');
function build(){
  const picks=[...document.querySelectorAll('section[data-group]')].map(section=>{
    const id=section.dataset.group;
    const selected=section.querySelector('input:checked');
    return selected ? id+'='+selected.value : null;
  }).filter(Boolean);
  command.textContent=prefix+' --pick '+picks.join(',');
}
document.addEventListener('change',build);build();
document.querySelector('#copy').addEventListener('click',async()=>{
  await navigator.clipboard.writeText(command.textContent);
  document.querySelector('#copy').textContent='已复制';
});
</script>
</body></html>`;
  fs.writeFileSync(outputFile, document, 'utf8');
  return outputFile;
}

export function writeDocumentReview(
  outputFile: string,
  title: string,
  approveCommand: string,
  documents: Array<{ label: string; content: string }>,
): string {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const blocks = documents
    .map(
      (document) =>
        `<section><h2>${html(document.label)}</h2><pre>${html(document.content)}</pre></section>`,
    )
    .join('');
  fs.writeFileSync(
    outputFile,
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${html(title)}</title><style>body{max-width:1000px;margin:30px auto;padding:0 20px;background:#0d1117;color:#e6edf3;font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}h1,h2{font-family:-apple-system,"PingFang SC",sans-serif}section{border-top:1px solid #30363d;padding:18px 0}pre{white-space:pre-wrap;background:#161b22;padding:18px;border-radius:10px}code{color:#f0b35a}</style></head>
<body><h1>${html(title)}</h1><p>确认后执行：<code>${html(approveCommand)}</code></p>${blocks}</body></html>`,
    'utf8',
  );
  return outputFile;
}

export function openReview(config: AppConfig, file: string): void {
  if (config.noOpen) return;
  execFile(process.platform === 'win32' ? 'cmd' : 'open', process.platform === 'win32' ? ['/c', 'start', '', file] : [file], () => undefined);
}
