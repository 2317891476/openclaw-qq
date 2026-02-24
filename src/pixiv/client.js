import { createRequire } from 'node:module';

const UA = 'Mozilla/5.0';

// Optional proxy bridge for Node fetch(undici). Must never hard-fail plugin loading.
try {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || '';
  if (proxyUrl) {
    const require = createRequire(import.meta.url);
    const { ProxyAgent, setGlobalDispatcher } = require('undici');
    if (ProxyAgent && setGlobalDispatcher) setGlobalDispatcher(new ProxyAgent(proxyUrl));
  }
} catch {}


function normText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s·・_\-]+/g, '')
    .trim();
}

function scoreUserCandidate(q, user) {
  const nq = normText(q);
  const name = normText(user?.name || '');
  const account = normText(user?.account || '');
  const id = String(user?.id || '').trim();
  if (!nq) return 0;
  if (id === q) return 120;
  if (name && name === nq) return 110;
  if (account && account === nq) return 100;
  if (name && (name.includes(nq) || nq.includes(name))) return 70;
  if (account && (account.includes(nq) || nq.includes(account))) return 60;
  return 0;
}

function headers(referer) {
  return {
    'User-Agent': UA,
    'Accept': 'application/json',
    ...(referer ? { Referer: referer } : {}),
  };
}

function extractPixivUserIds(text) {
  const s = String(text || '');
  const out = [];
  const re = /pixiv\.net\/(?:[a-z]{2}(?:-[a-z]+)?\/)?users\/(\d+)/gi;
  let m;
  while ((m = re.exec(s))) out.push(String(m[1]));
  return [...new Set(out)];
}

export class PixivClient {
  async searchUserIdByWeb(query) {
    const q = String(query || '').trim();
    if (!q) return null;

    const candidates = [];

    // 1) DuckDuckGo HTML fallback (no API key)
    try {
      const u = `https://duckduckgo.com/html/?q=${encodeURIComponent(`site:pixiv.net/users ${q}`)}`;
      const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
      if (r.ok) {
        const html = await r.text();
        candidates.push(...extractPixivUserIds(html));
      }
    } catch {}

    // 2) Pixiv tag page may contain linked user profile URLs
    try {
      const tu = `https://www.pixiv.net/tags/${encodeURIComponent(q)}`;
      const r2 = await fetch(tu, { headers: { 'User-Agent': UA, Referer: 'https://www.pixiv.net/' } });
      if (r2.ok) {
        const html2 = await r2.text();
        candidates.push(...extractPixivUserIds(html2));
      }
    } catch {}

    return candidates.length ? candidates[0] : null;
  }

  async searchIllustIds(keyword, { nsfw = false, pages = 3 } = {}) {
    const mode = nsfw ? 'all' : 'safe';
    const ids = [];
    for (let p = 1; p <= pages; p++) {
      const url = `https://www.pixiv.net/ajax/search/artworks/${encodeURIComponent(keyword)}?word=${encodeURIComponent(keyword)}&order=date_d&mode=${mode}&p=${p}&s_mode=s_tag&type=all`;
      const r = await fetch(url, { headers: headers(`https://www.pixiv.net/tags/${encodeURIComponent(keyword)}/artworks?s_mode=s_tag`) });
      if (!r.ok) continue;
      const j = await r.json();
      const list = j?.body?.illustManga?.data || j?.body?.illustManga?.illust?.data || [];
      for (const it of list) {
        const id = it?.id || it?.illustId;
        if (id) ids.push(String(id));
      }
    }
    return [...new Set(ids)];
  }

  async searchUsers(name) {
    const q = String(name || '').trim();
    if (!q) return [];

    const lower = q.toLowerCase();

    // Primary: user search endpoint (author lookup should prefer this path)
    const url = `https://www.pixiv.net/ajax/search/users/${encodeURIComponent(q)}?word=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: headers(`https://www.pixiv.net/search/users/${encodeURIComponent(q)}`) });
    if (r.ok) {
      const j = await r.json();
      const users = j?.body?.users || [];
      const out = users
        .map(u => ({
          id: String(u?.userId || u?.id || ''),
          name: String(u?.name || ''),
          account: String(u?.account || ''),
        }))
        .filter(u => u.id);

      if (out.length) {
        // Re-rank by lexical relevance first.
        const scored = out
          .map((u, i) => ({ ...u, _score: scoreUserCandidate(q, u), _idx: i }))
          .filter(u => u._score > 0)
          .sort((a, b) => (b._score - a._score) || (a._idx - b._idx));

        if (scored.length) {
          const top = scored[0];
          if (top._score >= 100) top.exact = true;
          return scored.map(({ _score, _idx, ...u }) => u);
        }

        // If strict lexical match fails (e.g. cross-language query like 中文名),
        // fall back to Pixiv API ranking instead of returning empty.
        return out;
      }
    }

    // Fallback: artwork search and infer author from result cards
    // (used only when user search returns empty)
    const aurl = `https://www.pixiv.net/ajax/search/artworks/${encodeURIComponent(q)}?word=${encodeURIComponent(q)}&order=date_d&mode=all&p=1&s_mode=s_tag&type=all`;
    const ar = await fetch(aurl, { headers: headers(`https://www.pixiv.net/tags/${encodeURIComponent(q)}/artworks?s_mode=s_tag`) });
    if (!ar.ok) return [];
    const aj = await ar.json();
    const list = aj?.body?.illustManga?.data || [];

    const map = new Map();
    for (const it of list) {
      const uid = String(it?.userId || it?.user_id || '');
      const uname = String(it?.userName || it?.user_name || '');
      if (!uid) continue;
      if (!map.has(uid)) map.set(uid, { id: uid, name: uname, account: '' });
    }

    const raw = [...map.values()];
    const arr = raw
      .map((u, i) => ({ ...u, _score: scoreUserCandidate(q, u), _idx: i }))
      .filter(u => u._score > 0)
      .sort((a, b) => (b._score - a._score) || (a._idx - b._idx))
      .map(({ _score, _idx, ...u }) => u);

    return arr.length ? arr : raw;
  }

  async userIllustIds(userId) {
    const url = `https://www.pixiv.net/ajax/user/${encodeURIComponent(userId)}/profile/all`;
    const r = await fetch(url, { headers: headers(`https://www.pixiv.net/users/${encodeURIComponent(userId)}`) });
    if (!r.ok) return [];
    const j = await r.json();
    const illusts = Object.keys(j?.body?.illusts || {});
    const manga = Object.keys(j?.body?.manga || {});
    const mixed = [...illusts, ...manga];
    return [...new Set(mixed.map(String))];
  }

  async rankIds(mode) {
    const url = `https://www.pixiv.net/ranking.php?mode=${encodeURIComponent(mode)}&content=illust&format=json`;
    const r = await fetch(url, { headers: headers(`https://www.pixiv.net/ranking.php?mode=${encodeURIComponent(mode)}`) });
    if (!r.ok) return [];
    const j = await r.json();
    const contents = Array.isArray(j?.contents) ? j.contents : [];
    const ids = [];
    for (const it of contents) {
      const id = it?.illust_id ?? it?.id;
      if (id) ids.push(String(id));
    }
    return [...new Set(ids)];
  }

  async illustMeta(id) {
    const detailUrl = `https://www.pixiv.net/ajax/illust/${encodeURIComponent(id)}`;
    const dr = await fetch(detailUrl, { headers: headers(`https://www.pixiv.net/artworks/${id}`) });
    if (!dr.ok) return null;
    const dj = await dr.json();
    const body = dj?.body || {};
    const xRestrict = Number(body?.xRestrict || 0);
    const bookmarkCount = Number(body?.bookmarkCount || 0);
    const createDate = String(body?.createDate || '');
    const width = Number(body?.width || 0);
    const height = Number(body?.height || 0);

    const pagesUrl = `https://www.pixiv.net/ajax/illust/${encodeURIComponent(id)}/pages`;
    const pr = await fetch(pagesUrl, { headers: headers(`https://www.pixiv.net/artworks/${id}`) });
    if (!pr.ok) return null;
    const pj = await pr.json();
    const original = pj?.body?.[0]?.urls?.original || null;
    return { id: String(id), xRestrict, bookmarkCount, createDate, width, height, original };
  }

  async downloadOriginal(meta) {
    if (!meta?.original) return null;
    const ext = (meta.original.split('?')[0].split('.').pop() || 'jpg').toLowerCase();
    const out = `/tmp/openclaw-qq-pixiv/${meta.id}_p0.${ext}`;
    const r = await fetch(meta.original, { headers: { 'User-Agent': UA, Referer: `https://www.pixiv.net/artworks/${meta.id}` } });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    const fs = await import('node:fs/promises');
    await fs.writeFile(out, buf);
    return out;
  }
}
