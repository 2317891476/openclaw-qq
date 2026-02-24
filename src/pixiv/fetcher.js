import fs from 'node:fs/promises';
import { normalizeTag } from './tag-mapping.js';

const QUALITY_TAGS = ['10000users入り', '5000users入り', '1000users入り'];

// Default recent-years window for /pixiv author when not using --alltime.
// (Overridable via config: pixiv.authorDefaultYears)
const AUTHOR_DEFAULT_YEARS = 3;

// Author exact-id overrides for high-confidence aliases.
// This is not cache; it's a deterministic mapping to avoid API user-search misses.
function normalizeAuthorKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s·・_\-]+/g, '')
    .trim();
}

// Deterministic UID mapping for known aliases/names.
// This is the most reliable path when Pixiv user search returns noisy candidates.
const AUTHOR_ID_MAP = new Map([
  ['ask', '1980643'],
  ['米山舞', '1554775'],
  ['yoneyamai', '1554775'],
  ['mai yoneyama', '1554775'],
  ['yoneyama', '1554775'],
].map(([k, v]) => [normalizeAuthorKey(k), v]));


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
    const result = await resolve(client, selected, parsed.nsfw, headerBase, {
      targetCount,
      fallbackPool,
      minBookmark: parsed.minBookmark,
      ratio: parsed.ratio,
      countFirst: !!parsed.countFirst,
      qualityFirst: !!parsed.qualityFirst,
    });
    result.debug = {
      poolCount: Array.isArray(rankedIds) ? rankedIds.length : 0,
      stageStats,
      mode,
      got: result?.imagePaths?.length || 0,
      target: targetCount,
    };
    tlog(parsed, 'search.result', { got: result?.imagePaths?.length || 0, targetCount });
    return result;
  }

  if (parsed.type === 'authorProfile') {
    let uid = String(parsed.author || '').trim();
    const aliasUid = (!/^\d+$/.test(uid) && parsed?.aliasStore) ? await parsed.aliasStore.resolve(uid) : null;
    if (aliasUid) uid = aliasUid;
    if (!uid) return { ok: false, message: '用法：/pixiv author profile <uid|name>' };
    if (!/^\d+$/.test(uid)) {
      const key = normalizeAuthorKey(uid);
      if (AUTHOR_ID_MAP.has(key)) uid = AUTHOR_ID_MAP.get(key);
      else {
        const users = await client.searchUsers(uid);
        if (!users?.length) return { ok: false, message: `未找到画师: ${parsed.author}` };
        uid = users[0].id;
      }
    }

    const ids = await client.userIllustIds(uid);
    if (!ids.length) return { ok: false, message: `画师无作品: ${parsed.author || uid}` };

    const sampleIds = ids.slice(0, 120);
    const rows = [];
    for (const id of sampleIds) {
      const meta = await client.illustMeta(id).catch(() => null);
      if (!meta) continue;
      rows.push({
        ts: meta.createDate ? Date.parse(meta.createDate) : 0,
        bk: Number(meta.bookmarkCount || 0),
      });
    }
    if (!rows.length) return { ok: false, message: `画师画像失败: ${parsed.author || uid}` };

    rows.sort((a, b) => a.bk - b.bk);
    const p50 = rows[Math.floor(rows.length * 0.5)]?.bk || 0;
    const p90 = rows[Math.floor(rows.length * 0.9)]?.bk || 0;
    const now = Date.now();
    const y1 = now - 365 * 24 * 60 * 60 * 1000;
    const y3 = now - 3 * 365 * 24 * 60 * 60 * 1000;
    const cnt1y = rows.filter(x => (x.ts || 0) >= y1).length;
    const cnt3y = rows.filter(x => (x.ts || 0) >= y3).length;
    const latestTs = Math.max(...rows.map(x => x.ts || 0));
    const latest = latestTs ? new Date(latestTs).toISOString().slice(0, 10) : 'n/a';

    const msg = [
      `画师画像: ${parsed.author || uid} (${uid})`,
      `- 样本数: ${rows.length} (最近作品池)` ,
      `- 近1年作品: ${cnt1y}`,
      `- 近3年作品: ${cnt3y}`,
      `- 收藏中位数(p50): ${p50}`,
      `- 收藏高位(p90): ${p90}`,
      `- 最近活跃: ${latest}`,
    ].join('\n');

    return { ok: false, message: msg };
  }

  if (parsed.type === 'authorPick') {
    const uid = String(parsed.uid || '').trim();
    if (!/^\d+$/.test(uid)) return { ok: false, message: '用法：/pixiv author pick <uid> [count]' };
    return await fetchByParsed(client, { ...parsed, type: 'author', author: uid });
  }

  if (parsed.type === 'author') {
    const rawAuthor = String(parsed.author || '').trim();
    const resolveT0 = Date.now();
    let resolvedFrom = /^\d+$/.test(String(rawAuthor)) ? 'uid-direct' : 'unknown';
    let uid = rawAuthor;
    let fallbackCandidateUids = [];
    if (!uid) return { ok: false, message: 'author 参数不能为空' };

    if (!/^\d+$/.test(uid)) {
      const aliasUid = parsed?.aliasStore ? await parsed.aliasStore.resolve(uid) : null;
      if (aliasUid) {
        uid = aliasUid;
        resolvedFrom = 'alias-cache';
      } else {
        const key = normalizeAuthorKey(uid);
        if (AUTHOR_ID_MAP.has(key)) {
          uid = AUTHOR_ID_MAP.get(key);
          resolvedFrom = 'builtin-map';
        } else {
          const users = await client.searchUsers(uid);
          const userCandidates = Array.isArray(users) ? users.map(u => String(u.id || '')).filter(Boolean) : [];
          fallbackCandidateUids = userCandidates.slice(0, 8);

          if (!users?.length) {
            let webUid = null;
            try { webUid = await client.searchUserIdByWeb(uid); } catch {}
            if (webUid) {
              uid = webUid;
              resolvedFrom = 'web-fallback-empty';
              fallbackCandidateUids = [String(webUid), ...fallbackCandidateUids.filter(x => x !== String(webUid))];
              if (parsed?.aliasStore) await parsed.aliasStore.set(rawAuthor, uid, 'webFallback');
            } else {
              return { ok: false, message: `未找到画师: ${parsed.author}` };
            }
          } else {
            const isExact = !!users[0]?.exact;
            if (isExact || users.length === 1) {
              uid = users?.[0]?.id || '';
              resolvedFrom = isExact ? 'pixiv-users-exact' : 'pixiv-users-single';
              if (uid && parsed?.aliasStore) {
                await parsed.aliasStore.set(rawAuthor, uid, 'searchUsers');
              }
            } else {
              let webUid = null;
              try { webUid = await client.searchUserIdByWeb(uid); } catch {}
              if (webUid) {
                uid = webUid;
                resolvedFrom = 'web-fallback-ambiguous';
                fallbackCandidateUids = [String(webUid), ...fallbackCandidateUids.filter(x => x !== String(webUid))];
                if (parsed?.aliasStore) await parsed.aliasStore.set(rawAuthor, uid, 'webFallback');
              } else {
                const top = users.slice(0, 5).map(u => ({ id: u.id, name: u.name, account: u.account || '' }));
                return {
                  ok: false,
                  message:
                    `找到多个画师候选，请选择：\n` +
                    top.map((u, i) => `${i + 1}. ${u.name}${u.account ? ` (@${u.account})` : ''} — ${u.id}`).join('\n') +
                    `\n\n用法：/pixiv author pick <uid> ${parsed.count || 5}`,
                };
              }
            }
          }
        }
      }

      if (!uid) return { ok: false, message: `未找到画师: ${parsed.author}` };
    }

    // Always cache successful alias -> uid mapping for acceleration next time.
    if (parsed?.aliasStore && rawAuthor && /^\d+$/.test(String(uid))) {
      await parsed.aliasStore.set(rawAuthor, uid, 'resolved');
    }

    const authorResolveMs = Date.now() - resolveT0;

    const targetCount = parsed.count || 5;
    let ids = await client.userIllustIds(uid);
    if (!ids.length && fallbackCandidateUids.length > 0) {
      for (const altUid of fallbackCandidateUids) {
        if (!altUid || altUid === uid) continue;
        const altIds = await client.userIllustIds(altUid).catch(() => []);
        if (altIds.length) {
          uid = altUid;
          resolvedFrom = 'fallback-has-works';
          ids = altIds;
          if (parsed?.aliasStore && rawAuthor) {
            await parsed.aliasStore.set(rawAuthor, uid, 'fallbackHasWorks');
          }
          break;
        }
      }
    }
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

    const result = await resolve(
      client,
      selected,
      parsed.nsfw,
      `P站画师:${parsed.author}(${uid}) ${modeText}`,
      { targetCount, fallbackPool },
    );
    result.debug = {
      ...(result.debug || {}),
      authorUid: uid,
      authorResolvedFrom: resolvedFrom,
      authorResolveMs,
      candidateCount: fallbackCandidateUids.length,
    };
    return result;
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
  const minBookmarkRaw = Number(opts.minBookmark || 0);
  const ratioRaw = String(opts.ratio || '').trim();
  const countFirst = !!opts.countFirst && !opts.qualityFirst;

  const pickedIds = [];
  const imagePaths = [];
  const tried = new Set();
  const stageHits = [];

  function ratioMatch(w, h, ratioExpr, tol = 0.08) {
    if (!ratioExpr) return true;
    const m = String(ratioExpr).match(/^(\d+):(\d+)$/);
    if (!m) return true;
    const rw = Number(m[1]);
    const rh = Number(m[2]);
    if (!rw || !rh || !w || !h) return true;
    const target = rw / rh;
    const actual = Number(w) / Number(h);
    return Math.abs(actual - target) <= target * tol;
  }

  async function tryAdd(id, stage) {
    if (!id || tried.has(id)) return false;
    tried.add(id);
    const meta = await client.illustMeta(id);
    if (!meta?.original) return false;
    if (!nsfw && Number(meta.xRestrict || 0) > 0) return false;
    if (stage.minBookmark > 0 && Number(meta.bookmarkCount || 0) < stage.minBookmark) return false;
    if (!ratioMatch(meta.width, meta.height, stage.ratio, stage.ratioTol)) return false;
    const p = await client.downloadOriginal(meta);
    if (!p) return false;
    pickedIds.push(String(id));
    imagePaths.push(p);
    return true;
  }

  const stages = [
    { name: 'strict', minBookmark: minBookmarkRaw, ratio: ratioRaw, ratioTol: 0.08 },
    ...(countFirst ? [
      { name: 'relax_ratio', minBookmark: minBookmarkRaw, ratio: ratioRaw, ratioTol: 0.16 },
      { name: 'relax_bookmark', minBookmark: minBookmarkRaw > 0 ? Math.max(1000, Math.floor(minBookmarkRaw * 0.6)) : 0, ratio: ratioRaw, ratioTol: 0.16 },
      { name: 'relax_more', minBookmark: minBookmarkRaw > 0 ? Math.max(300, Math.floor(minBookmarkRaw * 0.3)) : 0, ratio: '', ratioTol: 0.2 },
    ] : []),
  ];

  const fullPool = [...ids, ...fallbackPool];

  for (const stage of stages) {
    let added = 0;
    for (const id of fullPool) {
      const ok = await tryAdd(id, stage);
      if (ok) added += 1;
      if (targetCount > 0 && imagePaths.length >= targetCount) break;
    }
    stageHits.push(`${stage.name}:${added}`);
    if (targetCount > 0 && imagePaths.length >= targetCount) break;
  }

  const stageNote = countFirst ? `（fill:${stageHits.join(' > ')}）` : '';

  return {
    ok: true,
    pickedIds,
    imagePaths,
    header: `${headerBase}${stageNote} ×${imagePaths.length}${targetCount ? `/${targetCount}` : ''}${nsfw ? '（NSFW）' : '（全年龄）'}`,
  };
}
