import { parsePixivCommand } from './command-parser.js';
import { PixivClient } from './client.js';
import { fetchByParsed } from './fetcher.js';
import { PresetStore } from './presets.js';

export function createPixivPlugin(deps) {
  return new PixivPlugin(deps);
}

class PixivPlugin {
  constructor({ logger, sendBundle, pixivConfig = {}, workspaceDir = null }) {
    this.log = logger;
    this.sendBundle = sendBundle;
    this.cfg = pixivConfig;
    this.client = new PixivClient();
    this.rate = new Map();
    this.presets = new PresetStore(workspaceDir);
  }

  async handleCommand({ cmd, traceId = null, isGroup, groupId, userId, contextKey, isAdmin = false }) {
    let parsed = parsePixivCommand(cmd);

    // Preset commands (no strict rate limit for list/get)
    if (parsed.type === 'presetList') {
      const list = await this.presets.list();
      if (!list.length) return { ok: false, message: '当前没有 preset。' };
      return { ok: false, message: 'preset 列表：\n' + list.map(x => `- ${x.name}: ${x.template}`).join('\n') };
    }
    if (parsed.type === 'presetSave') {
      if (!isAdmin) return { ok: false, message: '仅管理员可保存 preset。' };
      if (!parsed.name || !parsed.template) return { ok: false, message: '用法：/pixiv preset save <name> <template...>' };
      await this.presets.set(parsed.name, parsed.template, { updatedBy: userId });
      return { ok: false, message: `已保存 preset: ${parsed.name}` };
    }
    if (parsed.type === 'presetDelete') {
      if (!isAdmin) return { ok: false, message: '仅管理员可删除 preset。' };
      if (!parsed.name) return { ok: false, message: '用法：/pixiv preset delete <name>' };
      await this.presets.remove(parsed.name);
      return { ok: false, message: `已删除 preset: ${parsed.name}` };
    }
    if (parsed.type === 'presetRun') {
      if (!parsed.name) return { ok: false, message: '用法：/pixiv preset run <name> [count]' };
      const tpl = await this.presets.get(parsed.name);
      if (!tpl) return { ok: false, message: `preset 不存在: ${parsed.name}` };
      let normalized = `/pixiv ${tpl}`.trim();
      if (Number.isFinite(parsed.count) && parsed.count > 0) {
        // Override leading count/range if exists, else prepend count.
        const body = normalized.replace(/^\/pixiv\s+/i, '');
        if (/^\d+(?:-\d+)?\b/.test(body)) {
          normalized = `/pixiv ${body.replace(/^\d+(?:-\d+)?\b/, String(parsed.count))}`;
        } else {
          normalized = `/pixiv ${parsed.count} ${body}`;
        }
      }
      parsed = parsePixivCommand(normalized);
    }

    const now = Date.now();
    const last = this.rate.get(contextKey) || 0;
    if (now - last < 10_000) {
      return { ok: false, message: '请求太快，请10秒后再试。' };
    }
    this.rate.set(contextKey, now);

    const out = await fetchByParsed(this.client, {
      ...parsed,
      traceId,
      cfg: this.cfg,
    });
    if (!out.ok) return out;

    await this.sendBundle({
      isGroup,
      groupId,
      userId,
      contextKey,
      text: out.header,
      imagePaths: out.imagePaths,
    });
    return { ok: true, pickedIds: out.pickedIds, imageCount: out.imagePaths.length };
  }

  async handleHttpSearch(payload) {
    const parsed = {
      type: payload.author ? 'author' : (payload.mode ? 'rank' : 'search'),
      nsfw: payload.safeOnly === false,
      noHq: payload.highQuality === false,
      keyword: payload.keyword || payload.queryType || 'オリジナル',
      count: Number(payload.count || 5),
      range: payload.range || null,
      author: payload.author || '',
      mode: payload.mode || 'daily',
      traceId: payload.traceId || null,
      cfg: this.cfg,
    };
    return await fetchByParsed(this.client, parsed);
  }
}
