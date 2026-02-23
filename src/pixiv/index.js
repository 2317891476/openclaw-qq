import { parsePixivCommand } from './command-parser.js';
import { PixivClient } from './client.js';
import { fetchByParsed } from './fetcher.js';

export function createPixivPlugin(deps) {
  return new PixivPlugin(deps);
}

class PixivPlugin {
  constructor({ logger, sendBundle }) {
    this.log = logger;
    this.sendBundle = sendBundle;
    this.client = new PixivClient();
    this.rate = new Map();
  }

  async handleCommand({ cmd, isGroup, groupId, userId, contextKey }) {
    const parsed = parsePixivCommand(cmd);
    const now = Date.now();
    const last = this.rate.get(contextKey) || 0;
    if (now - last < 10_000) {
      return { ok: false, message: '请求太快，请10秒后再试。' };
    }
    this.rate.set(contextKey, now);

    const out = await fetchByParsed(this.client, parsed);
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
    };
    return await fetchByParsed(this.client, parsed);
  }
}
