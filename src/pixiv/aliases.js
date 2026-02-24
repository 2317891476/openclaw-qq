import fs from 'node:fs/promises';
import path from 'node:path';

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s·・_\-]+/g, '')
    .trim();
}

export class AuthorAliasStore {
  constructor(workspaceDir) {
    this.path = path.join(workspaceDir || process.cwd(), 'pixiv-author-aliases.json');
    this._cache = null;
  }

  async _read() {
    if (this._cache) return this._cache;
    try {
      const txt = await fs.readFile(this.path, 'utf8');
      const j = JSON.parse(txt);
      this._cache = (j && typeof j === 'object') ? j : { aliases: {} };
      return this._cache;
    } catch {
      this._cache = { aliases: {} };
      return this._cache;
    }
  }

  async _write(obj) {
    this._cache = obj;
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    await fs.writeFile(this.path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  }

  async resolve(alias) {
    const key = norm(alias);
    if (!key) return null;
    const j = await this._read();
    const row = j.aliases?.[key];
    return row?.uid ? String(row.uid) : null;
  }

  async set(alias, uid, source = 'learned') {
    const key = norm(alias);
    const id = String(uid || '').trim();
    if (!key || !/^\d+$/.test(id)) return;
    const j = await this._read();
    j.aliases = j.aliases || {};
    j.aliases[key] = { uid: id, source, updatedAt: new Date().toISOString() };
    await this._write(j);
  }
}
