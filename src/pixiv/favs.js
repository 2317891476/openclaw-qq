import fs from 'node:fs/promises';
import path from 'node:path';

export class FavStore {
  constructor(workspaceDir) {
    this.path = path.join(workspaceDir || process.cwd(), 'pixiv-favs.json');
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

  async list(contextKey) {
    const j = await this._read();
    return Array.isArray(j[String(contextKey || '')]) ? j[String(contextKey || '')] : [];
  }

  async addMany(contextKey, items) {
    const key = String(contextKey || '');
    const j = await this._read();
    const arr = Array.isArray(j[key]) ? j[key] : [];
    const byId = new Map(arr.map(x => [String(x.id), x]));
    for (const it of (Array.isArray(items) ? items : [])) {
      const id = String(it?.id || '').trim();
      const imagePath = String(it?.imagePath || '').trim();
      if (!id || !imagePath) continue;
      byId.set(id, { id, imagePath, addedAt: new Date().toISOString() });
    }
    j[key] = [...byId.values()];
    await this._write(j);
    return j[key].length;
  }

  async remove(contextKey, id) {
    const key = String(contextKey || '');
    const j = await this._read();
    const arr = Array.isArray(j[key]) ? j[key] : [];
    const n = arr.filter(x => String(x.id) !== String(id));
    j[key] = n;
    await this._write(j);
    return n.length;
  }
}
