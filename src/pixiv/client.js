const UA = 'Mozilla/5.0';

function headers(referer) {
  return {
    'User-Agent': UA,
    'Accept': 'application/json',
    ...(referer ? { Referer: referer } : {}),
  };
}

export class PixivClient {
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
        // Rule:
        // 1) exact match first (name/account/id)
        // 2) otherwise keep API rank order (first result)
        const exact = out.find(u =>
          u.id === q ||
          u.name.trim().toLowerCase() === lower ||
          u.account.trim().toLowerCase() === lower
        );
        if (exact) {
          exact.exact = true;
          return [exact, ...out.filter(u => u.id !== exact.id)];
        }
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

    const arr = [...map.values()];
    arr.sort((a, b) => {
      const ae = String(a.name || '').toLowerCase() === lower ? 1 : 0;
      const be = String(b.name || '').toLowerCase() === lower ? 1 : 0;
      return be - ae;
    });
    return arr;
  }

  async userIllustIds(userId) {
    const url = `https://www.pixiv.net/ajax/user/${encodeURIComponent(userId)}/profile/all`;
    const r = await fetch(url, { headers: headers(`https://www.pixiv.net/users/${encodeURIComponent(userId)}`) });
    if (!r.ok) return [];
    const j = await r.json();
    const illusts = Object.keys(j?.body?.illusts || {});
    return [...new Set(illusts.map(String))];
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
