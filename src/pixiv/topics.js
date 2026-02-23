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

  async list(name = null) {
    const j = await this._read();
    if (name) {
      const v = j[String(name || '')];
      if (!v) return [];
      const arr = Array.isArray(v?.templates) ? v.templates : (v?.template ? [v.template] : []);
      return arr.map((template, idx) => ({ name: String(name), idx, template: String(template) }));
    }
    return Object.entries(j).map(([n, v]) => {
      const arr = Array.isArray(v?.templates) ? v.templates : (v?.template ? [v.template] : []);
      return { name: n, count: arr.length, template: String(arr[0] || '') };
    });
  }

  async get(name, random = false) {
    const j = await this._read();
    const v = j[String(name || '')];
    if (!v) return null;
    const arr = Array.isArray(v?.templates) ? v.templates : (v?.template ? [v.template] : []);
    if (!arr.length) return null;
    if (!random) return String(arr[0]);
    const i = Math.floor(Math.random() * arr.length);
    return String(arr[i]);
  }

  async set(name, template, meta = {}) {
    const key = String(name || '').trim();
    if (!key) throw new Error('topic name empty');
    const j = await this._read();
    j[key] = {
      templates: [String(template || '').trim()].filter(Boolean),
      updatedAt: new Date().toISOString(),
      updatedBy: meta.updatedBy || '',
    };
    await this._write(j);
  }

  async add(name, template, meta = {}) {
    const key = String(name || '').trim();
    if (!key) throw new Error('topic name empty');
    const t = String(template || '').trim();
    if (!t) throw new Error('topic template empty');
    const j = await this._read();
    const old = j[key] || {};
    const arr = Array.isArray(old.templates) ? old.templates : (old.template ? [old.template] : []);
    if (!arr.includes(t)) arr.push(t);
    j[key] = {
      templates: arr,
      updatedAt: new Date().toISOString(),
      updatedBy: meta.updatedBy || '',
    };
    await this._write(j);
    return arr.length;
  }

  async remove(name) {
    const key = String(name || '').trim();
    if (!key) return;
    const j = await this._read();
    delete j[key];
    await this._write(j);
  }
}
