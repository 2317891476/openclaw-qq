import { parsePixivCommand } from './command-parser.js';
import { PixivClient } from './client.js';
import { fetchByParsed } from './fetcher.js';
import { PresetStore } from './presets.js';
import { PixivSettingsStore } from './settings.js';
import { LastStateStore } from './last-state.js';
import { FavStore } from './favs.js';
import { TopicStore } from './topics.js';
import { AuthorAliasStore } from './aliases.js';

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
    this.favs = new FavStore(workspaceDir);
    this.topics = new TopicStore(workspaceDir);
    this.authorAliases = new AuthorAliasStore(workspaceDir);
  }

  async handleCommand({ cmd, traceId = null, isGroup, groupId, userId, contextKey, isAdmin = false }) {
    let parsed = parsePixivCommand(cmd);

    // Last/rerun
    if (parsed.type === 'last') {
      const last = await this.lastState.get(contextKey);
      if (!last) return { ok: false, message: '暂无最近一次 Pixiv 请求。' };
      return { ok: false, message: `last:\n- cmd: ${last.cmd}\n- got/target: ${last.got || 0}/${last.target || 0}\n- at: ${last.updatedAt || 'n/a'}` };
    }

    if (parsed.type === 'export') {
      const last = await this.lastState.get(contextKey);
      if (!last?.pickedIds?.length) return { ok: false, message: '暂无可导出的结果。先执行一次 /pixiv。' };
      const links = last.pickedIds.map(id => `https://www.pixiv.net/artworks/${id}`);
      if (parsed.mode === 'json') {
        const payload = {
          cmd: last.cmd,
          got: last.got || 0,
          target: last.target || 0,
          updatedAt: last.updatedAt || null,
          pickedIds: last.pickedIds || [],
          links,
        };
        const txt = JSON.stringify(payload, null, 2);
        if (txt.length <= 3000) return { ok: false, message: txt };
        // Split long JSON output into chunks
        const chunks = [];
        for (let i = 0; i < txt.length; i += 2800) chunks.push(txt.slice(i, i + 2800));
        for (const c of chunks) {
          await this.sendBundle({ isGroup, groupId, userId, contextKey, text: c, imagePaths: [] });
        }
        return { ok: false, message: `export json 已发送，共 ${chunks.length} 段。` };
      }

      const msg = [
        'export links:',
        ...links,
      ].join('\n');
      return { ok: false, message: msg };
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

    // Topic commands
    if (parsed.type === 'topicList') {
      const list = await this.topics.list(parsed.name || null);
      if (!list.length) return { ok: false, message: parsed.name ? `topic ${parsed.name} 暂无模板。` : '当前没有 topic。' };
      if (parsed.name) {
        return { ok: false, message: `topic ${parsed.name} 模板：\n` + list.map(x => `- #${x.idx + 1}: ${x.template}`).join('\n') };
      }
      return { ok: false, message: 'topic 列表：\n' + list.map(x => `- ${x.name} (${x.count}) ${x.template}`).join('\n') };
    }
    if (parsed.type === 'topicSave') {
      if (!isAdmin) return { ok: false, message: '仅管理员可保存 topic。' };
      if (!parsed.name || !parsed.template) return { ok: false, message: '用法：/pixiv topic save <name> <template...>' };
      await this.topics.set(parsed.name, parsed.template, { updatedBy: userId });
      return { ok: false, message: `已保存 topic: ${parsed.name}` };
    }
    if (parsed.type === 'topicAdd') {
      if (!isAdmin) return { ok: false, message: '仅管理员可添加 topic 模板。' };
      if (!parsed.name || !parsed.template) return { ok: false, message: '用法：/pixiv topic add <name> <template...>' };
      const n = await this.topics.add(parsed.name, parsed.template, { updatedBy: userId });
      return { ok: false, message: `已添加模板到 topic: ${parsed.name}（共 ${n} 条）` };
    }
    if (parsed.type === 'topicDelete') {
      if (!isAdmin) return { ok: false, message: '仅管理员可删除 topic。' };
      if (!parsed.name) return { ok: false, message: '用法：/pixiv topic delete <name>' };
      await this.topics.remove(parsed.name);
      return { ok: false, message: `已删除 topic: ${parsed.name}` };
    }
    if (parsed.type === 'topicRun') {
      if (!parsed.name) return { ok: false, message: '用法：/pixiv topic <name> [count]' };
      const tpl = await this.topics.get(parsed.name, true);
      if (!tpl) return { ok: false, message: `topic 不存在: ${parsed.name}` };
      let normalized = `/pixiv ${tpl}`.trim();
      if (Number.isFinite(parsed.count) && parsed.count > 0) {
        const body = normalized.replace(/^\/pixiv\s+/i, '');
        if (/^\d+(?:-\d+)?\b/.test(body)) normalized = `/pixiv ${body.replace(/^\d+(?:-\d+)?\b/, String(parsed.count))}`;
        else normalized = `/pixiv ${parsed.count} ${body}`;
      }
      parsed = parsePixivCommand(normalized);
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

    // Fav commands
    if (parsed.type === 'favList') {
      let list = await this.favs.list(contextKey);
      if (parsed.tag) list = list.filter(x => Array.isArray(x.tags) && x.tags.includes(parsed.tag));
      if (!list.length) return { ok: false, message: parsed.tag ? `收藏夹中没有标签 ${parsed.tag} 的条目。` : '收藏夹为空。' };
      return {
        ok: false,
        message: 'fav 列表：\n' + list.slice(0, 30).map((x, i) => `${i + 1}. ${x.id} (${x.addedAt || 'n/a'})${Array.isArray(x.tags) && x.tags.length ? ' [' + x.tags.join(',') + ']' : ''}`).join('\n'),
      };
    }

    if (parsed.type === 'favAdd') {
      const last = await this.lastState.get(contextKey);
      const ids = Array.isArray(last?.pickedIds) ? last.pickedIds : [];
      const paths = Array.isArray(last?.imagePaths) ? last.imagePaths : [];
      if (!ids.length || !paths.length) return { ok: false, message: '没有可收藏的最近结果。先执行一次 /pixiv。' };
      const items = [];
      const n = Math.min(ids.length, paths.length);
      for (let i = 0; i < n; i++) items.push({ id: String(ids[i]), imagePath: String(paths[i]) });
      const total = await this.favs.addMany(contextKey, items);
      return { ok: false, message: `已收藏 ${items.length} 张（收藏总数: ${total}）` };
    }

    if (parsed.type === 'favTag') {
      if (!isAdmin) return { ok: false, message: '仅管理员可标记收藏。' };
      if (!parsed.id || !Array.isArray(parsed.tags) || !parsed.tags.length) {
        return { ok: false, message: '用法：/pixiv fav tag <id> <tag1,tag2...>' };
      }
      const ok = await this.favs.setTags(contextKey, parsed.id, parsed.tags);
      if (!ok) return { ok: false, message: `未找到该收藏 id: ${parsed.id}` };
      return { ok: false, message: `已标记 ${parsed.id} => [${parsed.tags.join(', ')}]` };
    }

    if (parsed.type === 'favRemove') {
      if (!isAdmin) return { ok: false, message: '仅管理员可删除收藏。' };
      if (!parsed.id) return { ok: false, message: '用法：/pixiv fav remove <id>' };
      const total = await this.favs.remove(contextKey, parsed.id);
      return { ok: false, message: `已删除 ${parsed.id}（剩余: ${total}）` };
    }

    if (parsed.type === 'favSend') {
      let list = await this.favs.list(contextKey);
      if (parsed.tag) list = list.filter(x => Array.isArray(x.tags) && x.tags.includes(parsed.tag));
      if (!list.length) return { ok: false, message: parsed.tag ? `收藏夹中没有标签 ${parsed.tag} 的条目。` : '收藏夹为空。' };
      const count = Math.max(1, Math.min(20, Number(parsed.count || 5)));
      const shuffled = [...list].sort(() => Math.random() - 0.5).slice(0, count);
      const imagePaths = shuffled.map(x => x.imagePath).filter(Boolean);
      await this.sendBundle({
        isGroup,
        groupId,
        userId,
        contextKey,
        text: `Fav 随机发送 ×${imagePaths.length}/${count}${parsed.tag ? ` tag=${parsed.tag}` : ''}`,
        imagePaths,
      });
      return { ok: true, imageCount: imagePaths.length };
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
      aliasStore: this.authorAliases,
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
      if (d.authorUid) {
        text += `\n[author] uid=${d.authorUid} from=${d.authorResolvedFrom || 'n/a'} resolve=${d.authorResolveMs ?? 'n/a'}ms candidates=${d.candidateCount ?? 'n/a'}`;
      }
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
        pickedIds: out.pickedIds || [],
        imagePaths: out.imagePaths || [],
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
    return await fetchByParsed(this.client, { ...parsed, aliasStore: this.authorAliases });
  }
}
