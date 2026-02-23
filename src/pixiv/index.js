import { parsePixivCommand } from './command-parser.js';
import { PixivClient } from './client.js';
import { fetchByParsed } from './fetcher.js';
import { PresetStore } from './presets.js';
import { PixivSettingsStore } from './settings.js';
import { LastStateStore } from './last-state.js';

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
    this.settings = new PixivSettingsStore(workspaceDir);
    this.lastState = new LastStateStore(workspaceDir);
  }

  async handleCommand({ cmd, traceId = null, isGroup, groupId, userId, contextKey, isAdmin = false }) {
    let parsed = parsePixivCommand(cmd);

    // Last/rerun
    if (parsed.type === 'last') {
      const last = await this.lastState.get(contextKey);
      if (!last) return { ok: false, message: '暂无最近一次 Pixiv 请求。' };
      return { ok: false, message: `last:\n- cmd: ${last.cmd}\n- got/target: ${last.got || 0}/${last.target || 0}\n- at: ${last.updatedAt || 'n/a'}` };
    }

    if (parsed.type === 'rerun') {
      const last = await this.lastState.get(contextKey);
      if (!last?.cmd) return { ok: false, message: '暂无可重跑请求。先执行一次 /pixiv ...' };
      let rerunCmd = String(last.cmd);
      if (Number.isFinite(parsed.count) && parsed.count > 0) {
        const body = rerunCmd.replace(/^\/pixiv\s+/i, '');
        if (/^\d+(?:-\d+)?\b/.test(body)) rerunCmd = `/pixiv ${body.replace(/^\d+(?:-\d+)?\b/, String(parsed.count))}`;
        else rerunCmd = `/pixiv ${parsed.count} ${body}`;
      }
      parsed = parsePixivCommand(rerunCmd);
    }

    // Verbose toggle (per context)
    if (parsed.type === 'verbose') {
      if (parsed.enabled === null) return { ok: false, message: '用法：/pixiv verbose on|off' };
      if (!isAdmin) return { ok: false, message: '仅管理员可修改 verbose。' };
      await this.settings.setVerbose(contextKey, parsed.enabled);
      return { ok: false, message: `已设置 verbose=${parsed.enabled ? 'on' : 'off'}` };
    }

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

    const t0 = Date.now();
    const out = await fetchByParsed(this.client, {
      ...parsed,
      traceId,
      cfg: this.cfg,
    });
    if (!out.ok) return out;

    let text = out.header;
    const verbose = await this.settings.getVerbose(contextKey);
    if (verbose && out.debug) {
      const d = out.debug;
      const cost = Date.now() - t0;
      const got = (d.got ?? out.imageCount ?? out.imagePaths?.length ?? 0);
      const target = (d.target ?? out.imagePaths?.length ?? 0);
      const stage = Array.isArray(d.stageStats) ? d.stageStats.join(' > ') : 'n/a';
      text += `\n[verbose] pool=${d.poolCount ?? 'n/a'} stage=${stage} mode=${d.mode || 'n/a'} result=${got}/${target} t=${cost}ms`;
    }

    await this.sendBundle({
      isGroup,
      groupId,
      userId,
      contextKey,
      text,
      imagePaths: out.imagePaths,
    });

    // Persist last successful pixiv command for rerun/last
    try {
      await this.lastState.set(contextKey, {
        cmd,
        got: out.imagePaths?.length || 0,
        target: out.debug?.target || out.imagePaths?.length || 0,
      });
    } catch {}

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
