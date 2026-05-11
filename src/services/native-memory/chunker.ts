import { createHash } from 'crypto';

export interface MarkdownChunk {
  title: string | null;
  body: string;
}

export function chunkMarkdown(text: string): MarkdownChunk[] {
  const lines = text.split('\n');
  const chunks: MarkdownChunk[] = [];
  let cur: { title: string | null; body: string[] } = { title: null, body: [] };
  const flush = () => {
    const body = cur.body.join('\n').trim();
    if (body) chunks.push({ title: cur.title, body });
  };
  for (const line of lines) {
    const m = line.match(/^(#{1,2})\s+(.+?)\s*$/);
    if (m) {
      flush();
      cur = { title: m[2].trim(), body: [] };
    } else {
      cur.body.push(line);
    }
  }
  flush();
  return chunks;
}

export function chunkHash(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

export function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split('\n')) {
    const t = line.trim().replace(/^[#>*\-\s]+/, '').slice(0, 120);
    if (t) return t;
  }
  return null;
}

export function tagFor(filename: string): string {
  const base = filename.replace(/\.md$/, '');
  if (/^MEMORY$/i.test(base)) return 'overview';
  return base.split('_')[0].toLowerCase();
}

function isoFromEpoch(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

export interface BuildContext {
  project: string;
  filename: string;
  file: string;
  mtime: number;
}

export function buildSession(ctx: BuildContext): unknown {
  const id = `native-memory:${ctx.project}/${ctx.filename}`;
  const iso = isoFromEpoch(ctx.mtime);
  return {
    content_session_id: id,
    memory_session_id: id,
    project: ctx.project,
    platform_source: 'claude',
    user_prompt: `<native memory file: ${ctx.filename}>`,
    started_at: iso,
    started_at_epoch: ctx.mtime,
    completed_at: iso,
    completed_at_epoch: ctx.mtime,
    status: 'completed',
  };
}

export function buildObservation(ctx: BuildContext, chunk: MarkdownChunk, idx: number): unknown {
  const title = chunk.title || firstNonEmptyLine(chunk.body) || `${ctx.filename}#${idx}`;
  return {
    memory_session_id: `native-memory:${ctx.project}/${ctx.filename}`,
    project: ctx.project,
    type: 'native_memory',
    created_at: isoFromEpoch(ctx.mtime),
    created_at_epoch: ctx.mtime,
    title: `[native:${tagFor(ctx.filename)}] ${title}`.slice(0, 200),
    text: chunk.body,
    subtitle: null,
    facts: JSON.stringify([
      { source_file: ctx.file, chunk_hash: chunkHash(chunk.body), filename: ctx.filename, tag: tagFor(ctx.filename) },
    ]),
    narrative: null,
    concepts: null,
    files_read: null,
    files_modified: null,
    prompt_number: null,
    discovery_tokens: 0,
  };
}

export function buildRetraction(ctx: BuildContext, shadow: string): unknown {
  return {
    memory_session_id: `native-memory:${ctx.project}/${ctx.filename}`,
    project: ctx.project,
    type: 'native_memory_retracted',
    created_at: isoFromEpoch(ctx.mtime),
    created_at_epoch: ctx.mtime,
    title: `[native:retracted] ${ctx.filename}`,
    text: shadow,
    subtitle: null,
    facts: JSON.stringify([{ source_file: ctx.file, filename: ctx.filename, tag: 'retracted' }]),
    narrative: null,
    concepts: null,
    files_read: null,
    files_modified: null,
    prompt_number: null,
    discovery_tokens: 0,
  };
}
