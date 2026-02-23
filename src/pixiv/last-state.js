import fs from 'node:fs/promises';
import path from 'node:path';

export class LastStateStore {
  constructor(workspaceDir) {
    this.path = path.join(workspaceDir || process.cwd(), 'pixiv-last.json');
  }

  async _read() {
    try {
      const txt = await fs.readFile(this.path, 'utf8');
      const j = JSON.parse(txt);
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {};
    }
  }

  async _write(obj) {
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    await fs.writeFile(this.path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  }

  async get(contextKey) {
    const j = await this._read();
    return j[String(contextKey || '')] || null;
  }

  async set(contextKey, state) {
    const k = String(contextKey || '');
    const j = await this._read();
    j[k] = { ...state, updatedAt: new Date().toISOString() };
    await this._write(j);
  }
}
