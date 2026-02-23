import fs from 'node:fs/promises';
import { normalizeTag } from './tag-mapping.js';

const QUALITY_TAGS = ['10000users入り', '5000users入り', '1000users入り'];

// Default recent-years window for /pixiv author when not using --alltime.
// (Overridable via config: pixiv.authorDefaultYears)
const AUTHOR_DEFAULT_YEARS = 3;

// Author exact-id overrides for high-confidence aliases.
// This is not cache; it's a deterministic mapping to avoid API user-search misses.
const AUTHOR_ID_MAP = new Map([
  ['ask', '1980643'],
]);


function tlog(parsed, stage, extra = {}) {
  const traceId = parsed?.traceId;
  if (!traceId) return;
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), subsystem: 'pixiv', traceId, stage, ...extra }));
  } catch {}
}
function shuffle(a) {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export async function fetchByParsed(client, parsed) {
  await fs.mkdir('/tmp/openclaw-qq-pixiv', { recursive: true });

  if (parsed.type === 'search') {
    const base = normalizeTag(parsed.keyword);
    const targetCount = parsed.range
      ? Math.max(0, parsed.range.end - parsed.range.start + 1)
      : parsed.count;

    // Progressive quality fallback:
    // 10000users入り -> 5000users入り -> 1000users入り -> base
    const queryPlan = parsed.noHq
      ? [{ label: 'base', query: base }]
      : [
          { label: '10000', query: `${base} 10000users入り` },
          { label: '5000', query: `${base} 5000users入り` },
          { label: '1000', query: `${base} 1000users入り` },
          { label: 'base', query: base },
        ];

    const allIds = [];
    const seen = new Set();
    const stageStats = [];

    tlog(parsed, 'search.start', { keyword: base, targetCount, nsfw: parsed.nsfw, noHq: parsed.noHq });

    for (const stage of queryPlan) {
      // Widen candidate pool so random sampling has enough diversity.
      // More pages when targetCount is large to reduce "insufficient results".
      const cfg = parsed?.cfg || {};
      const pagesSmall = Number(cfg.searchPages || 8);
      const pagesLarge = Number(cfg.searchPagesLarge || 12);
      const pages = targetCount >= 8 ? pagesLarge : pagesSmall;
      const ids = await client.searchIllustIds(stage.query, { nsfw: parsed.nsfw, pages });
      let added = 0;
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        allIds.push(id);
        added++;
      }
      stageStats.push(`${stage.label}:${added}`);

      // Stop early when candidate pool is sufficiently large.
      // Need a big buffer because some items fail download/filter (>8MB, xRestrict, network).
      const want = Math.max(targetCount * 8, targetCount + 50);
      if (allIds.length >= want) break;
    }

    // Optional quality mode: users | bookmark | hybrid
    const mode = String(parsed.qualityMode || 'users').toLowerCase();
    let rankedIds = allIds;
    if (mode === 'bookmark' || mode === 'hybrid') {
      // Score top slice by bookmark count to avoid too many detail requests
      const scorePool = allIds.slice(0, Math.max(80, targetCount * 12));
      const scored = [];
      for (const id of scorePool) {
        const meta = await client.illustMeta(id).catch(() => null);
        if (!meta) continue;
        scored.push({ id: String(id), bookmarkCount: Number(meta.bookmarkCount || 0) });
      }
      scored.sort((a, b) => b.bookmarkCount - a.bookmarkCount);
      const top = scored.map(x => x.id);
      rankedIds = mode === 'bookmark'
        ? top
        : [...top, ...allIds.filter(id => !top.includes(id))];
    }

    const selected = parsed.range
      ? rankedIds.slice(Math.max(0, parsed.range.start - 1), parsed.range.end)
      : shuffle(rankedIds).slice(0, parsed.count);

    // fallback pool: when selected items fail to download/filter, keep filling from remaining candidates
    const fallbackPool = parsed.range
      ? rankedIds.slice(parsed.range.end)
      : rankedIds;

    const qualityNote = parsed.noHq ? '（nohq）' : `（分层:${stageStats.join(' > ')}）`;
    const filterNote = `（mode=${mode}${parsed.minBookmark ? `,minBk=${parsed.minBookmark}` : ''}${parsed.ratio ? `,ratio=${parsed.ratio}` : ''}）`;
    const headerBase = parsed.range
      ? `P站原图：关键词:${base} 区间:${parsed.range.start}-${parsed.range.end}${qualityNote}${filterNote}`
      : `P站原图：关键词:${base}${qualityNote}${filterNote}`;

    tlog(parsed, 'search.pick', { selectedCount: Array.isArray(selected) ? selected.length : 0, poolCount: Array.isArray(rankedIds) ? rankedIds.length : 0, stageStats, mode });
    const result = await resolve(client, selected, parsed.nsfw, headerBase, { targetCount, fallbackPool, minBookmark: parsed.minBookmark, ratio: parsed.ratio });
    tlog(parsed, 'search.result', { got: result?.imagePaths?.length || 0, targetCount });
    return result;
  }

  if (parsed.type === 'authorPick') {
    const uid = String(parsed.uid || '').trim();
    if (!/^\d+$/.test(uid)) return { ok: false, message: '用法：/pixiv author pick <uid> [count]' };
    return await fetchByParsed(client, { ...parsed, type: 'author', author: uid });
  }

  if (parsed.type === 'author') {
    let uid = parsed.author;
    if (!uid) return { ok: false, message: 'author 参数不能为空' };
    if (!/^\d+$/.test(uid)) {
      const key = String(uid).trim().toLowerCase();
      if (AUTHOR_ID_MAP.has(key)) {
        uid = AUTHOR_ID_MAP.get(key);
      } else {
        const users = await client.searchUsers(uid);
        if (!users?.length) return { ok: false, message: `未找到画师: ${parsed.author}` };

        // If not exact and multiple candidates, ask user to pick.
        const isExact = !!users[0]?.exact;
        if (!isExact && users.length > 1) {
          const top = users.slice(0, 5).map(u => ({ id: u.id, name: u.name, account: u.account || '' }));
          return {
            ok: false,
            message:
              `找到多个画师候选，请选择：\n` +
              top.map((u, i) => `${i + 1}. ${u.name}${u.account ? ` (@${u.account})` : ''} — ${u.id}`).join('\n') +
              `\n\n用法：/pixiv author pick <uid> ${parsed.count || 5}`,
          };
        }

        uid = users?.[0]?.id || '';
      }
      if (!uid) return { ok: false, message: `未找到画师: ${parsed.author}` };
    }

    const targetCount = parsed.count || 5;
    const ids = await client.userIllustIds(uid);
    if (!ids.length) return { ok: false, message: `画师无作品: ${parsed.author}` };

    const cfg = parsed?.cfg || {};
    const defaultYears = Number(cfg.authorDefaultYears || AUTHOR_DEFAULT_YEARS);
    const years = Number(parsed.years || defaultYears);
    const useAllTime = !!parsed.alltime;
    const cutoffTs = Date.now() - years * 365 * 24 * 60 * 60 * 1000;

    // "最新最热"：取较新作品池，按(收藏+新近度)打分。
    const latestPool = ids.slice(0, Math.max(160, targetCount * 24));
    const scored = [];
    for (const id of latestPool.slice(0, 120)) {
      const meta = await client.illustMeta(id).catch(() => null);
      if (!meta) continue;
      const ts = meta.createDate ? Date.parse(meta.createDate) : 0;
      scored.push({ id: String(id), bookmarkCount: Number(meta.bookmarkCount || 0), ts });
    }

    const filteredByTime = useAllTime
      ? scored
      : scored.filter(x => (x.ts || 0) >= cutoffTs);

    const baseScored = filteredByTime.length >= Math.max(targetCount, 5)
      ? filteredByTime
      : scored;

    const minTs = baseScored.length ? Math.min(...baseScored.map(x => x.ts || 0)) : 0;
    const maxTs = baseScored.length ? Math.max(...baseScored.map(x => x.ts || 0)) : 0;
    const denom = Math.max(1, maxTs - minTs);

    const ranked = baseScored
      .map(x => {
        const recencyNorm = (x.ts - minTs) / denom; // 0..1
        const score = (x.bookmarkCount * 0.75) + (recencyNorm * 800);
        return { ...x, score };
      })
      .sort((a, b) => b.score - a.score);

    const candidatePool = ranked.map(x => x.id);
    const pickPoolSize = Math.max(targetCount * 6, 30);
    const selected = shuffle(candidatePool.slice(0, pickPoolSize)).slice(0, targetCount);

    const fallbackPool = [...candidatePool.slice(pickPoolSize), ...ids.slice(latestPool.length)];
    const modeText = useAllTime ? '全作品随机' : `近${years}年随机`;

    return await resolve(
      client,
      selected,
      parsed.nsfw,
      `P站画师:${parsed.author}(${uid}) ${modeText}`,
      { targetCount, fallbackPool },
    );
  }

  if (parsed.type === 'rank') {
    const modes = parsed.mode === 'all' ? ['daily', 'weekly', 'monthly'] : [parsed.mode];
    const ids = [];
    for (const m of modes) ids.push(...await client.rankIds(m));
    const selected = [...new Set(ids)].slice(0, parsed.count * modes.length);
    return await resolve(client, selected, parsed.nsfw, `P站排行:${parsed.mode}`);
  }

  return { ok: false, message: '不支持的命令类型' };
}

async function resolve(client, ids, nsfw, headerBase, opts = {}) {
  const targetCount = Number(opts.targetCount || ids.length || 0);
  const fallbackPool = Array.isArray(opts.fallbackPool) ? opts.fallbackPool : [];
  const minBookmark = Number(opts.minBookmark || 0);
  const ratio = String(opts.ratio || '').trim();

  const pickedIds = [];
  const imagePaths = [];
  const tried = new Set();

  function ratioMatch(w, h, ratioExpr) {
    if (!ratioExpr) return true;
    const m = String(ratioExpr).match(/^(\d+):(\d+)$/);
    if (!m) return true;
    const rw = Number(m[1]);
    const rh = Number(m[2]);
    if (!rw || !rh || !w || !h) return true;
    const target = rw / rh;
    const actual = Number(w) / Number(h);
    // tolerance ~8%
    return Math.abs(actual - target) <= target * 0.08;
  }

  async function tryAdd(id) {
    if (!id || tried.has(id)) return;
    tried.add(id);
    const meta = await client.illustMeta(id);
    if (!meta?.original) return;
    if (!nsfw && Number(meta.xRestrict || 0) > 0) return;
    if (minBookmark > 0 && Number(meta.bookmarkCount || 0) < minBookmark) return;
    if (!ratioMatch(meta.width, meta.height, ratio)) return;
    const p = await client.downloadOriginal(meta);
    if (!p) return;
    pickedIds.push(String(id));
    imagePaths.push(p);
  }

  for (const id of ids) {
    await tryAdd(id);
    if (targetCount > 0 && imagePaths.length >= targetCount) break;
  }

  if (targetCount > 0 && imagePaths.length < targetCount) {
    for (const id of fallbackPool) {
      await tryAdd(id);
      if (imagePaths.length >= targetCount) break;
    }
  }

  return {
    ok: true,
    pickedIds,
    imagePaths,
    header: `${headerBase} ×${imagePaths.length}${targetCount ? `/${targetCount}` : ''}${nsfw ? '（NSFW）' : '（全年龄）'}`,
  };
}
