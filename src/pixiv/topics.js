import fs from 'node:fs/promises';
import path from 'node:path';

export class TopicStore {
  constructor(workspaceDir) {
    this.path = path.join(workspaceDir || process.cwd(), 'pixiv-topics.json');
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

  async list() {
    const j = await this._read();
    return Object.entries(j).map(([name, v]) => ({ name, template: String(v?.template || '') }));
  }

  async get(name) {
    const j = await this._read();
    const v = j[String(name || '')];
    return v ? String(v.template || '') : null;
  }

  async set(name, template, meta = {}) {
    const key = String(name || '').trim();
    if (!key) throw new Error('topic name empty');
    const j = await this._read();
    j[key] = {
      template: String(template || '').trim(),
      updatedAt: new Date().toISOString(),
      updatedBy: meta.updatedBy || '',
    };
    await this._write(j);
  }

  async remove(name) {
    const key = String(name || '').trim();
    if (!key) return;
    const j = await this._read();
    delete j[key];
    await this._write(j);
  }
}
