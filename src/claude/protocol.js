// Pure helpers over the Claude Code stream-json protocol. No DOM, no bridge.
// Shapes verified against fixtures/*.jsonl captured from claude 2.1.261 on 2026-09-06.

/** Vault-relative path from anything the CLI hands us (absolute Windows, absolute posix, relative). */
export function vaultRel(p, root) {
  if (!p) return '';
  let s = String(p).replace(/\\/g, '/');
  const r = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (r && s.toLowerCase().startsWith(r.toLowerCase() + '/')) s = s.slice(r.length + 1);
  else if (r && s.toLowerCase() === r.toLowerCase()) s = '';
  return s.replace(/^\.?\/+/, '');
}

/** True when the path looks like a page we can open in the editor. */
export const isPagePath = (p) => !!p && !/^[a-z]+:\/\//i.test(p) && /\.md$/i.test(p) && !p.startsWith('..');

const firstString = (o) => {
  for (const v of Object.values(o || {})) if (typeof v === 'string' && v.trim()) return v;
  return '';
};

/**
 * One compact row per tool call: a 5-char label and one line of argument.
 * Returns {label, arg, path} where `path` (if set) is vault-relative and clickable.
 */
export function toolRow(name, input, root) {
  const i = input && typeof input === 'object' ? input : {};
  const rel = (p) => vaultRel(p, root);
  const label = (name || '?').replace(/^mcp__.*?__/, '').slice(0, 12);
  switch (name) {
    case 'Read': {
      const p = rel(i.file_path);
      let arg = p;
      if (i.offset || i.limit) arg += `:${i.offset || 1}${i.limit ? '+' + i.limit : ''}`;
      return { label: 'READ', arg, path: p };
    }
    case 'Edit': return { label: 'EDIT', arg: rel(i.file_path), path: rel(i.file_path) };
    case 'NotebookEdit': return { label: 'EDIT', arg: rel(i.notebook_path), path: rel(i.notebook_path) };
    case 'Write': return { label: 'WRITE', arg: rel(i.file_path), path: rel(i.file_path) };
    case 'Grep': {
      const where = i.path ? rel(i.path) : '';
      return { label: 'GREP', arg: `"${i.pattern ?? ''}"${where ? ' in ' + where : ''}`, path: '' };
    }
    case 'Glob': {
      const where = i.path ? rel(i.path) : '';
      return { label: 'GLOB', arg: `${i.pattern ?? ''}${where ? ' in ' + where : ''}`, path: '' };
    }
    case 'Bash': return { label: 'BASH', arg: String(i.command ?? '').replace(/\s*\n\s*/g, ' ⏎ '), path: '' };
    case 'Task': return { label: 'TASK', arg: i.description || i.subagent_type || '', path: '' };
    case 'TodoWrite': return { label: 'TODO', arg: `${(i.todos || []).length} items`, path: '' };
    case 'WebFetch': return { label: 'FETCH', arg: i.url || '', path: '' };
    case 'WebSearch': return { label: 'SEARCH', arg: i.query || '', path: '' };
    case 'Skill': return { label: 'SKILL', arg: i.skill || '', path: '' };
    default: return { label: label.toUpperCase(), arg: firstString(i).replace(/\s*\n\s*/g, ' ⏎ '), path: '' };
  }
}

/** tool_result content is a string or a list of blocks; flatten to text. */
export function resultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : `[${b?.type || 'block'}]`)).join('\n');
  }
  return typeof content === 'object' ? JSON.stringify(content, null, 2) : String(content);
}

export const fmtDuration = (ms) => {
  if (!Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  return `${m}m ${Math.round((ms % 60000) / 1000)}s`;
};

export const fmtClock = (t) => {
  const d = new Date(t || Date.now());
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `6 Sep 2026 14:32`, for the resume divider. */
export const fmtDate = (t) => {
  const d = new Date(t || Date.now());
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${fmtClock(d.getTime())}`;
};

/** Relative time for the sessions list. */
export const fmtAgo = (t) => {
  const s = Math.max(0, (Date.now() - (t || 0)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return fmtDate(t).slice(0, -6);
};

/** Parse a possibly-incomplete JSON string streamed via input_json_delta. */
export function looseJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { }
  // best effort: close open strings/braces so a partially streamed input still shows something
  let out = s, depth = 0, inStr = false, escaped = false;
  for (const c of s) {
    if (inStr) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{' || c === '[') depth++; else if (c === '}' || c === ']') depth--;
  }
  if (inStr) out += '"';
  while (depth-- > 0) out += '}';
  try { return JSON.parse(out); } catch { return null; }
}
