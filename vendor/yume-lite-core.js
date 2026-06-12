/**
 * yume-lite/core.js
 *
 * Deliberately small.
 *
 * The goal of this smallness is clarity for AI:
 * the entire integrated worldview (Block as unit, visible append-only history,
 * expand/apply as transparent thick editing, skeleton/readPartial for cheap visibility,
 * domain-tagged values for self-describing data) fits in one file.
 * Constraint-based state derivation is provided as a separate living template (constraint-template.js).
 *
 * An AI can load the complete structure in a single context pass and
 * immediately see the shape without exploration or hidden capsules.
 *
 * This is "clear" in the literal sense: no hiding, no human-oriented encapsulation,
 * no distributed philosophy that requires piecing together.
 * The primitives exist to make logic, dependencies, types, and history
 * directly visible to the AI so inference requires fewer guesses.
 *
 * Extracted and simplified from ai-desk/v2 primitives.
 * Focus: the minimal seed that lets an AI quickly internalize the transparent,
 * anti-capsule model of development.
 */

// --- Minimal version / hash / compare ---
export function makeVersion({ content, refs = [], children = [], tags = [], meta = {} }, prev = null) {
  const v = { timestamp: Date.now(), prevHash: prev ? prev.hash : null, content, refs, children, tags, meta };
  v.hash = hashVersion(v);
  return v;
}

export function sameArr(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function sameRefs(a, b) {
  if (a.length !== b.length) return false;
  const key = r => `${r.kind}:${r.target}`;
  const aKeys = a.map(key).sort();
  const bKeys = b.map(key).sort();
  for (let i = 0; i < aKeys.length; i++) if (aKeys[i] !== bKeys[i]) return false;
  return true;
}

// 全ネスト階層でキーをソートして正規化する。
// （JSON.stringify の配列レプレーサーは全階層にキーフィルタとして効くため、
//   refs: [{kind, target}] の中身が [{}] に潰れてハッシュから脱落するバグがあった）
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

export function hashVersion(v) {
  const { hash, ...rest } = v;
  const stable = JSON.stringify(canonicalize(rest));
  let h = 0x811c9dc5;
  for (let i = 0; i < stable.length; i++) {
    h ^= stable.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// --- Block (minimal for heavy) ---
export class Block {
  constructor({ id, type, versions = [], meta = {} }) {
    if (!id) throw new Error('Block requires id');
    if (!type) throw new Error('Block requires type');
    this.id = id;
    this.type = type;
    this.versions = versions;
    this.meta = meta;
  }

  commit({ content = null, refs = [], children = [], tags = [], meta = {} } = {}) {
    const prev = this.head();
    const v = makeVersion({ content, refs, children, tags, meta }, prev);
    this.versions.push(v);
    // Lite: append-only but cap recent history at ~32
    // Older ones are dropped; only last 32 viewable via .versions
    const MAX_HISTORY = 32;
    if (this.versions.length > MAX_HISTORY) {
      const trimmed = this.versions.length - MAX_HISTORY;
      this.versions.splice(0, trimmed);
      this._trimmed = (this._trimmed || 0) + trimmed;
    }
    return v;
  }

  head() {
    return this.versions.length > 0 ? this.versions[this.versions.length - 1] : null;
  }

  get content() { return this.head()?.content ?? null; }
  get refs()    { return this.head()?.refs    ?? []; }
  get tags()    { return this.head()?.tags    ?? []; }

  // Lite history: only recent ~32 are kept in .versions
  // .trimmed : how many old versions were dropped
  get trimmed() { return this._trimmed || 0; }
  get totalHistory() { return this.trimmed + this.versions.length; }

  /**
   * read a past version (lite: only recent 32 are kept).
   * index: 0 = oldest kept, -1 or 'head' = latest
   * returns the version object (with content, refs, tags, hash, etc.) or null
   */
  read(index = -1) {
    let idx = index;
    if (idx === 'head') idx = -1;
    if (typeof idx === 'number' && idx < 0) {
      idx = this.versions.length + idx;
    }
    const v = this.versions[idx];
    if (!v) return null;
    return { ...v, index: idx };
  }

  readContent(index = -1) {
    const v = this.read(index);
    return v ? v.content : null;
  }

  applyPatch(content, opts = {}) {
    const head = this.head();
    if (head && head.content === content
        && (opts.refs == null || sameRefs(opts.refs, head.refs))
        && (opts.tags == null || sameArr(opts.tags, head.tags))) {
      return { action: 'unchanged', block: this };
    }
    this.commit({
      content,
      refs: opts.refs ?? head?.refs ?? [],
      children: opts.children ?? head?.children ?? [],
      tags: opts.tags ?? head?.tags ?? [],
      meta: { ...(head?.meta ?? {}), ...(opts.meta ?? {}), appliedAt: Date.now() },
    });
    return { action: head ? 'updated' : 'created', block: this };
  }

  toJSON() { return { id: this.id, type: this.type, versions: this.versions, meta: this.meta, trimmed: this._trimmed || 0 }; }
  static fromJSON(json) {
    const b = new Block({ id: json.id, type: json.type, versions: json.versions || [], meta: json.meta || {} });
    if (json.trimmed) b._trimmed = json.trimmed;
    return b;
  }
}

// --- Graph (minimal for heavy) ---
export class Graph {
  constructor(blocks = []) {
    this.blocks = new Map();
    for (const b of blocks) this.add(b);
  }
  add(block) {
    if (!(block instanceof Block)) block = Block.fromJSON(block);
    this.blocks.set(block.id, block);
    return this;
  }
  get(id) { return this.blocks.get(id); }
  has(id) { return this.blocks.has(id); }
  all() { return Array.from(this.blocks.values()); }
  toJSON() { return this.all().map(b => b.toJSON()); }
  static fromJSON(json) { return new Graph(json.map(Block.fromJSON)); }
}

// --- Virtual Heavy (core of lite) ---
// expand() exists to give the AI one transparent, thick, editable view
// instead of forcing it to mentally integrate scattered pieces (which creates opacity).
export function virtualHeavy(graph, rootId, opts = {}) {
  const { depth = Infinity, kind = 'calls' } = opts;
  const collected = new Map();
  function collect(id, d) {
    if (collected.has(id) || d > depth) return;
    const b = graph.get(id); if (!b) return;
    collected.set(id, b);
    for (const r of b.refs) if (kind == null || r.kind === kind) collect(r.target, d + 1);
  }
  collect(rootId, 0);
  return Array.from(collected.values());
}

// --- Boundary markers: open + close with shared hash (tamper-detectable) ---
// open : // >>> BLOCK <id> type=<t> hash=<h>
// close: // <<< /BLOCK <id> hash=<h>
// Same hash appears on both lines. apply() rejects when they diverge.
// Hash is opaque to the editor; LLM should treat hash= as do-not-touch.
const OPEN_ROOT_RE   = /^\s*\/\/\s*>>>\s+ROOT\s+(\S+)(?:\s+(.*))?\s*$/;
const CLOSE_ROOT_RE  = /^\s*\/\/\s*<<<\s+\/ROOT\s+(\S+)(?:\s+(.*))?\s*$/;
const OPEN_BLOCK_RE  = /^\s*\/\/\s*>>>\s+BLOCK\s+(\S+)(?:\s+(.*))?\s*$/;
const CLOSE_BLOCK_RE = /^\s*\/\/\s*<<<\s+\/BLOCK\s+(\S+)(?:\s+(.*))?\s*$/;
const META_LINE_RE   = /^\s*\/\/\s+(tags|refs):/;

function parseAttrs(s) {
  const out = {};
  if (!s) return out;
  for (const m of String(s).matchAll(/(\w+)=(\S+)/g)) out[m[1]] = m[2];
  return out;
}

function fingerprint(...parts) {
  const s = parts.map(p => p == null ? '' : String(p)).join('\0');
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function blockHash(b) {
  return fingerprint(b.id, b.type, b.content ?? '');
}

export function expand(graph, rootId, opts = {}) {
  const blocks = virtualHeavy(graph, rootId, opts);
  const rootHash = fingerprint(rootId, ...blocks.map(b => b.id));
  const out = [
    `// === Virtual Heavy rooted at ${rootId} (${blocks.length} blocks) ===`,
    `// Edit block bodies. Do NOT modify hash= attrs or boundary marker lines.`,
    `// >>> ROOT ${rootId} hash=${rootHash}`,
    ''
  ];
  for (const b of blocks) {
    const h = blockHash(b);
    out.push(`// >>> BLOCK ${b.id} type=${b.type} hash=${h}`);
    if (b.tags?.length) out.push(`//     tags: ${b.tags.join(', ')}`);
    if (b.refs?.length) out.push(`//     refs: ${b.refs.map(r => `${r.kind}->${r.target}`).join(', ')}`);
    if (b.content) out.push(b.content);
    out.push(`// <<< /BLOCK ${b.id} hash=${h}`);
    out.push('');
  }
  out.push(`// <<< /ROOT ${rootId} hash=${rootHash}`);
  out.push(`// === end ===`);
  return out.join('\n');
}

// apply: robust line-based parser with integrity checks.
//
// Returns an array-like value: [{id, action, ...}, ...] with .ok, .applied, .warnings attached.
//   action = 'created' | 'updated' | 'unchanged' | 'skipped-out-of-scope'
//          | 'skipped' (parse-level issue on that block)
//          | 'rejected-integrity' (whole transaction rejected)
//
// Strict by default: any fatal warning (id mismatch / hash tamper / dup id /
// missing close / root mismatch / stale write) rejects the entire apply atomically.
// stale-write = expand 後に他者がそのブロックを変更した（ヘッダ hash と現在の blockHash の不一致）。
// Pass opts.lenient = true to apply parseable blocks even when fatals exist
// (still reports them via .warnings). stale なブロック自体は lenient でも skip され、
// 並行変更が黙って上書きされることはない。re-expand してやり直すこと。
export function apply(graph, rootId, content, opts = {}) {
  const { lenient = false } = opts;
  const scope = virtualHeavy(graph, rootId, opts);
  const scopeById = new Map(scope.map(b => [b.id, b]));
  const lines = String(content ?? '').split('\n');

  const warnings = [];
  const parsed = [];
  let cur = null;
  let buf = [];
  let rootOpenSeen = false;

  function flush(status) {
    if (!cur) return;
    const body = buf
      .filter(l => !META_LINE_RE.test(l))
      .join('\n')
      .replace(/^\n+|\n+$/g, '');
    cur.body = body;
    cur.status = status;
    parsed.push(cur);
    cur = null;
    buf = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = i + 1;
    let m;

    if ((m = line.match(OPEN_ROOT_RE))) {
      rootOpenSeen = true;
      if (m[1] !== rootId) warnings.push({ kind: 'root-id-mismatch', at, expected: rootId, found: m[1] });
      continue;
    }
    if ((m = line.match(CLOSE_ROOT_RE))) {
      if (m[1] !== rootId) warnings.push({ kind: 'root-close-mismatch', at, expected: rootId, found: m[1] });
      if (cur) {
        warnings.push({ kind: 'block-no-close', at, id: cur.id });
        flush('no-close');
      }
      continue;
    }
    if ((m = line.match(OPEN_BLOCK_RE))) {
      if (cur) {
        warnings.push({ kind: 'block-no-close', at, id: cur.id });
        flush('no-close');
      }
      const attrs = parseAttrs(m[2]);
      cur = { id: m[1], type: attrs.type, hashOpen: attrs.hash, openLine: at };
      buf = [];
      continue;
    }
    if ((m = line.match(CLOSE_BLOCK_RE))) {
      if (!cur) {
        warnings.push({ kind: 'stray-close', at, id: m[1] });
        continue;
      }
      const attrs = parseAttrs(m[2]);
      let status = 'ok';
      if (m[1] !== cur.id) {
        warnings.push({ kind: 'block-id-mismatch', open: cur.id, close: m[1], at });
        status = 'id-mismatch';
      } else if (cur.hashOpen && attrs.hash && cur.hashOpen !== attrs.hash) {
        warnings.push({ kind: 'block-hash-tamper', id: cur.id, hashOpen: cur.hashOpen, hashClose: attrs.hash });
        status = 'header-tamper';
      }
      cur.hashClose = attrs.hash;
      cur.closeLine = at;
      flush(status);
      continue;
    }

    if (cur) buf.push(line);
    // lines outside any block are silently dropped (preamble / blanks / commentary)
  }
  if (cur) {
    warnings.push({ kind: 'block-no-close', at: lines.length, id: cur.id });
    flush('no-close');
  }

  const seen = new Set();
  for (const p of parsed) {
    if (seen.has(p.id)) {
      warnings.push({ kind: 'duplicate-id', id: p.id });
      p.status = 'duplicate';
    }
    seen.add(p.id);
  }
  if (rootOpenSeen) {
    for (const b of scope) {
      if (!seen.has(b.id)) warnings.push({ kind: 'missing-block', id: b.id });
    }
  }

  // Stale-write detection (yume-files heavyApply から移植した発想):
  // ヘッダの hash= は expand 時点のブロック状態。現在の blockHash と食い違うなら、
  // この view が作られた後に誰かがそのブロックを変更している → 黙って上書きしない。
  for (const p of parsed) {
    if (p.status !== 'ok' || !p.hashOpen) continue;
    const target = scopeById.get(p.id);
    if (target && blockHash(target) !== p.hashOpen) {
      warnings.push({ kind: 'stale-write', id: p.id, viewHash: p.hashOpen, currentHash: blockHash(target) });
      p.status = 'stale';
    }
  }

  const FATAL = new Set([
    'root-id-mismatch', 'root-close-mismatch',
    'block-id-mismatch', 'block-hash-tamper',
    'duplicate-id', 'block-no-close',
    'stale-write',
  ]);
  const hasFatal = warnings.some(w => FATAL.has(w.kind));

  const updates = [];
  if (hasFatal && !lenient) {
    for (const p of parsed) updates.push({ id: p.id, action: 'rejected-integrity', status: p.status });
    return Object.assign(updates, { ok: false, applied: false, warnings });
  }

  for (const p of parsed) {
    if (p.status !== 'ok') {
      updates.push({ id: p.id, action: 'skipped', status: p.status });
      continue;
    }
    const target = scopeById.get(p.id);
    if (!target) {
      updates.push({ id: p.id, action: 'skipped-out-of-scope' });
      continue;
    }
    const res = target.applyPatch(p.body);
    updates.push({ id: p.id, ...res });
  }
  return Object.assign(updates, { ok: true, applied: true, warnings });
}

// heavyApply: full loop helper. Preserved for symmetry with ai-desk/v2.
export function heavyApply(graph, rootId, content, opts = {}) {
  const updates = apply(graph, rootId, content, opts);
  const expanded = expand(graph, rootId, opts);
  return {
    updates,
    expanded,
    stats: { ok: updates.ok, warnings: updates.warnings },
    blocks: virtualHeavy(graph, rootId, opts).length,
  };
}

// ============================================================
// First-sight key (for AI that read the README)
// ============================================================
// The thick editing tool works in two layers:
//
// 1. Read path (editing tool / client side):
//    const view = expand(graph, rootId, opts);   // thick text with BLOCK boundaries + hashes
//
// 2. Write path (the one that must reach the real authority):
//    const cmd = makeThickEdit({ root: rootId, content: editedView, opts });
//    // send `cmd` over WS / postMessage / IPC / HTTP / whatever
//    const result = applyThickEdit(authorityGraph, cmd);
//
// Critical distinction:
// - Calling `apply(localGraphReplica, root, edited)` only mutates your local copy.
// - Only `applyThickEdit` on the *authority* that owns the real Graph counts as the canonical write.
// This is what makes browser UIs, agents, and automation actually safe and automatable.
//
// These two functions are intentionally tiny and must stay in core.js so the
// complete "expand for read → makeThickEdit for write" model fits in one mental pass.

// makeThickEdit: produces a plain, serializable command object.
// Clients (UI, scripts, remote agents) use this instead of calling apply directly.
export function makeThickEdit({ root, content, opts = {} }) {
  if (!root) throw new Error('makeThickEdit requires root');
  return {
    kind: 'yume-lite/thick-edit',
    version: 1,
    root: String(root),
    content: String(content ?? ''),
    opts: { ...opts },
    createdAt: Date.now(),
  };
}

// applyThickEdit: the authority-side executor for a command produced by makeThickEdit.
// This is the official write for the thick editing tool across process / network boundaries.
export function applyThickEdit(graph, cmd) {
  if (!cmd || typeof cmd !== 'object') {
    const err = new Error('applyThickEdit received invalid command');
    return Object.assign([], { ok: false, applied: false, error: err.message });
  }
  if (cmd.kind !== 'yume-lite/thick-edit' || cmd.version !== 1) {
    const err = new Error(`applyThickEdit: unsupported command kind/version (got ${cmd.kind} v${cmd.version})`);
    return Object.assign([], { ok: false, applied: false, error: err.message });
  }
  if (!cmd.root) {
    const err = new Error('applyThickEdit: command missing root');
    return Object.assign([], { ok: false, applied: false, error: err.message });
  }

  const updates = apply(graph, cmd.root, cmd.content, cmd.opts || {});
  // attach a little context so callers can see it came through the command path
  return Object.assign(updates, {
    command: { kind: cmd.kind, root: cmd.root },
  });
}

// ============================================================
// Header discipline LINT (for Virtual Heavy thick views)
// ============================================================
// The main rule: only edit the *body* of each BLOCK.
// Never modify:
//   - // >>> BLOCK ... hash=...
//   - // <<< /BLOCK ... hash=...
//   - //     tags: ...  or //     refs: ...
//   - the ROOT boundary lines
//
// This linter can be called *before* apply / applyThickEdit.
// Especially useful for AI agents: edit the view → lint → fix if needed → apply.
//
// It does two kinds of checks:
// 1. Structural integrity of the boundaries (matching ids, matching hashes on open/close).
// 2. If you pass `original` (the exact string from expand), it also checks that
//    all header / boundary lines are byte-for-byte unchanged.

export function lintThickView(content, opts = {}) {
  const { original = null, rootId = null } = opts;

  const lines = String(content ?? '').split('\n');
  const violations = [];

  let cur = null;
  let rootOpenSeen = false;
  let rootOpenLine = 0;

  function addViolation(kind, at, details) {
    violations.push({
      kind,
      line: at,
      message: details.message,
      blockId: details.id || null,
      severity: details.severity || 'error',
    });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = i + 1;
    let m;

    if ((m = line.match(OPEN_ROOT_RE))) {
      rootOpenSeen = true;
      rootOpenLine = at;
      if (rootId && m[1] !== rootId) {
        addViolation('root-id-mismatch', at, {
          message: `ROOT id が違います。expected: ${rootId}, found: ${m[1]}`,
          id: m[1],
        });
      }
      continue;
    }

    if ((m = line.match(CLOSE_ROOT_RE))) {
      if (rootId && m[1] !== rootId) {
        addViolation('root-close-mismatch', at, {
          message: `ROOT 終了 id が違います。expected: ${rootId}, found: ${m[1]}`,
          id: m[1],
        });
      }
      if (cur) {
        addViolation('block-no-close', cur.openLine || at, {
          message: `BLOCK ${cur.id} に閉じタグがありません。`,
          id: cur.id,
        });
      }
      cur = null;
      continue;
    }

    if ((m = line.match(OPEN_BLOCK_RE))) {
      if (cur) {
        addViolation('block-no-close', cur.openLine || at, {
          message: `BLOCK ${cur.id} の閉じタグが見つかる前に次のブロックが始まりました。`,
          id: cur.id,
        });
      }
      const attrs = parseAttrs(m[2]);
      cur = {
        id: m[1],
        hashOpen: attrs.hash,
        openLine: at,
        openLineText: line,
      };
      continue;
    }

    if ((m = line.match(CLOSE_BLOCK_RE))) {
      if (!cur) {
        addViolation('stray-close', at, {
          message: `対応する開始タグがない閉じタグがあります: ${line.trim()}`,
          id: m[1],
        });
        continue;
      }
      const attrs = parseAttrs(m[2]);

      if (m[1] !== cur.id) {
        addViolation('block-id-mismatch', at, {
          message: `BLOCK id が一致しません。open: ${cur.id}, close: ${m[1]} (行 ${cur.openLine}〜${at})`,
          id: cur.id,
        });
      }

      if (cur.hashOpen && attrs.hash && cur.hashOpen !== attrs.hash) {
        addViolation('header-tamper', at, {
          message: `BLOCK ${cur.id} のヘッダーが編集されています (hash mismatch)。\n` +
                   `  開始: ${cur.openLineText}\n` +
                   `  終了: ${line}\n` +
                   `  → hash= の部分や >>> / <<< 行は絶対に変更しないでください。本文だけを編集してください。`,
          id: cur.id,
          severity: 'error',
        });
      }

      // Check if the header line itself was modified in format (very common AI mistake)
      // We can't know the exact original without `original`, but we can at least warn on obvious tampering.
      cur = null;
      continue;
    }

    // If we're inside a block, we don't care about body lines for header discipline.
  }

  if (cur) {
    addViolation('block-no-close', lines.length, {
      message: `最後の BLOCK ${cur.id} に閉じタグがありません。`,
      id: cur.id,
    });
  }

  // If we have the original expanded view, do a strict header-line comparison.
  // This catches "I rewrote the header comment slightly" even if hashes happen to match.
  if (original) {
    const origLines = String(original).split('\n');
    // Match any line that is a yume Virtual Heavy boundary or meta line.
    // These are the lines the discipline says "do not touch".
    const isHeaderLine = (l) => {
      const t = l.trimStart();
      return t.startsWith('// >>>') ||
             t.startsWith('// <<<') ||
             t.startsWith('//     tags:') ||
             t.startsWith('//     refs:');
    };

    for (let i = 0; i < Math.min(lines.length, origLines.length); i++) {
      const orig = origLines[i];
      const edited = lines[i];
      if (isHeaderLine(orig) && orig !== edited) {
        addViolation('header-line-modified', i + 1, {
          message: `ヘッダー行が変更されています (行 ${i + 1})。\n` +
                   `  元: ${orig}\n` +
                   `  現: ${edited}\n` +
                   `  この行は expand が出力したそのままの状態を保ってください。本文 (BLOCK の中身) だけを編集してください。`,
          severity: 'error',
        });
      }
    }
  }

  const ok = violations.length === 0;
  const advice = ok
    ? 'ヘッダー規律は守られています。本文だけを編集したようです。'
    : 'ヘッダー規律違反を検出しました。BLOCK の >>> / <<< 行と hash=、tags:、refs: 行は変更しないでください。';

  return {
    ok,
    violations,
    count: violations.length,
    advice,
  };
}

// ============================================================
// Skeleton / List (for token saving)
// ============================================================
// Instead of full expand (which includes all content), get just the list of
// blocks in the heavy scope. This lets the LLM see the structure first
// (IDs, types, tags, refs, sizes) without dumping thousands of tokens of code.
// Then it can decide to "read" specific parts or full expand if needed.
//
// This directly addresses "ブロックのリストだけみれればいい" + partial read inside {}.

export function skeleton(graph, rootId, opts = {}) {
  const blocks = virtualHeavy(graph, rootId, opts);
  return blocks.map(item => {
    const b = item; // regular Block (constraint descriptors are handled outside core as templates)
    const h = b.head() || {};
    const content = h.content || '';
    // Extract signature only (up to first { ) for preview, to avoid leaking body
    let preview = content.split('{')[0] || '';
    preview = preview.trim();
    if (preview.length > 80) preview = preview.slice(0, 77) + '...';

    // Very rough "body size inside {}" estimate for token awareness
    const braceContent = content.match(/\{([\s\S]*?)\}/);
    const bodyLen = braceContent ? braceContent[1].length : content.length;

    return {
      id: b.id,
      type: b.type,
      tags: h.tags || [],
      refs: h.refs || [],
      children: h.children || [],
      preview,
      contentLength: content.length,
      bodyLength: bodyLen,
      versionCount: b.versions.length,
      trimmed: b.trimmed || 0,
    };
  });
}

// Read only a "part" of a block's content (e.g. only inside the main {} )
// This is a simple helper for " {}のなかだけ一部分読める "
// For now: returns the content between the first { and last } if present,
// or the full content. Can be extended later with line ranges etc.
export function readPartial(graph, blockId, opts = {}) {
  const b = graph.get(blockId);
  if (!b) return null;
  const h = b.head();
  if (!h || !h.content) return null;

  const content = h.content;
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    // Return with the surrounding braces for context, but mark it's partial
    return {
      partial: true,
      content: content.slice(start, end + 1),
      fullLength: content.length,
    };
  }
  return {
    partial: false,
    content,
    fullLength: content.length,
  };
}

// ============================================================
// Minimal high-leverage additions for 10k+ LOC scale
// (最大限の効果を最小の追加で)
// ============================================================
//
// These are deliberately tiny (keep the "read core.js once and hold the whole model" property).
// They directly port the highest-ROI ideas from the full yume-develop system:
//   - Curated cheap entry surface (aiDoc / manifest) instead of dumping the whole graph
//   - Smart scoping / impact before paying the cost of expand/heavy
//
// Use them like this:
//   1. Always start with skeleton(...) or getSurface(...) — never expand first.
//   2. Use getImpact(...) to decide whether a change is narrow or wide.
//   3. Maintain ONE (or very few) manifest block(s) as the AI's "first page".
//   4. Domain tags remain one of the highest-leverage conventions even at this scale.

export function getSurface(graph, opts = {}) {
  // Find an explicit curated "first page" block if the project maintains one.
  // Convention (cheap to follow):
  //   - id starts with 'meta:' or 'doc:' or 'ai:'
  //   - or has tag 'manifest' / 'aiDoc' / 'overview'
  //   - or type === 'manifest'
  //
  // The content of this block should be small + structured:
  //   key roots, important domains in use, entry points, notes. (constraints can be expressed as normal blocks or via separate templates)
  // This is the lite analog of AiRunAndRead_* + aiDoc in yume-develop.

  const all = graph.all();
  const manifest = all.find(b => {
    const id = b.id || '';
    const tags = (b.tags || b.head?.()?.tags || []);
    const t = b.type || '';
    return (
      id.startsWith('meta:') ||
      id.startsWith('doc:') ||
      id.startsWith('ai:') ||
      tags.includes('manifest') ||
      tags.includes('aiDoc') ||
      tags.includes('overview') ||
      t === 'manifest'
    );
  });

  if (manifest) {
    const h = manifest.head ? manifest.head() : {};
    return {
      kind: 'manifest',
      id: manifest.id,
      type: manifest.type,
      tags: h.tags || [],
      content: h.content || null,
      advice: 'This is the cheap curated surface. Read it first. Keep it small and up-to-date.'
    };
  }

  // No explicit manifest — give a cheap inferred surface + strong recommendation.
  // (The project should grow a meta:project block as it approaches 5k+ LOC.)
  const top = all.slice(0, 12).map(b => {
    const h = b.head ? b.head() : {};
    return {
      id: b.id,
      type: b.type,
      tags: h.tags || [],
      preview: (h.content || '').split('\n')[0]?.slice(0, 60)
    };
  });

  return {
    kind: 'inferred',
    advice: 'No manifest block found. Create one (id: meta:project or tag:manifest) with keyRoots, domains, and important entry points. This becomes the AI\'s primary cheap entry for the whole 10k+ project.',
    topBlocks: top,
    totalBlocks: all.length
  };
}

export function getImpact(graph, blockId, opts = {}) {
  // Cheap "who would be affected if I change this block?"
  // Returns direct dependents (incoming refs) so the AI can decide scope
  // *before* paying for a heavy expand.
  //
  // This is the lite version of ai-desk "impact" command.
  // Extremely high leverage for deciding "do I need depth=2 or can I stay narrow?"

  const dependents = [];
  for (const b of graph.all()) {
    const refs = b.refs || (b.head ? b.head().refs : []) || [];
    const matching = refs.filter(r => r.target === blockId);
    if (matching.length > 0) {
      dependents.push({
        id: b.id,
        type: b.type,
        via: matching.map(r => r.kind),
        tags: (b.tags || (b.head ? b.head().tags : [])) || []
      });
    }
  }

  return {
    target: blockId,
    directDependents: dependents,
    dependentCount: dependents.length,
    note: 'Small count = narrow change. Large count or deep transitive = consider skeleton first + limited depth heavy.'
  };
}

// Recommended discipline (put this in your project README or a meta:project block):
//   - For any non-trivial task: getSurface() or skeleton(root, {depth:0 or 1})
//   - Before touching a block: getImpact(blockId)
//   - Only then decide the exact root + depth for expand/apply
//   - Keep the manifest block tiny and the single source of "what matters in this project"


// ============================================================
// Domain-Tagged Values (A11 / LLM-First Typing) — コア規約
// ============================================================
// 値そのものにドメイン/型/単位を prefix で埋め込む。
// 例: domainTag('world', '5,0,2') => 'world:5,0,2'
//     domainTag('usd', 9.99) => 'usd:9.99'
// これにより LLM は context window 外でも型を即認識できる。
// 命名規則やコメントに頼らず、値が self-describing になるのがポイント。
//
// This is transparency, not "nice naming": the meaning is in the token the AI actually sees.

export function domainTag(domain, value) {
  if (value == null) return `${domain}:`;
  return `${domain}:${value}`;
}

export function parseDomainTag(tagged) {
  if (typeof tagged !== 'string') return { domain: null, value: tagged };
  const idx = tagged.indexOf(':');
  if (idx === -1) return { domain: null, value: tagged };
  return {
    domain: tagged.slice(0, idx),
    value: tagged.slice(idx + 1)
  };
}

// よく使うドメインの定数（規約として推奨）
export const DOMAINS = {
  WORLD: 'world',   // world coord (x,y,z など)
  USD: 'usd',       // 金額
  TIME: 'time',     // タイムスタンプ / 時間
  ID: 'id',         // 識別子
  HASH: 'hash',     // ハッシュ値
  COUNT: 'count',   // 個数
  RATIO: 'ratio',   // 比率 0.0-1.0
  PIXEL: 'px',      // ピクセル
};

