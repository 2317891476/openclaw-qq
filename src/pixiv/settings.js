import fs from 'node:fs/promises';
import path from 'node:path';

export class PixivSettingsStore {
  constructor(workspaceDir) {
    this.path = path.join(workspaceDir || process.cwd(), 'pixiv-settings.json');
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

  async getVerbose(contextKey) {
    const j = await this._read();
    return !!j?.verbose?.[String(contextKey || '')];
  }

  async setVerbose(contextKey, enabled) {
    const k = String(contextKey || '');
    const j = await this._read();
    j.verbose = j.verbose || {};
    j.verbose[k] = !!enabled;
    await this._write(j);
  }
}
