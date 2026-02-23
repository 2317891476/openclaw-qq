export function parsePixivCommand(cmdText) {
  const parts = String(cmdText || '')
    .replace(/[／]/g, '/')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(t => String(t).trim());
  // parts[0] is /pixiv
  const args = parts.slice(1);

  // /pixiv last | /pixiv rerun [count]
  if ((args[0] || '').toLowerCase() === 'last') {
    return { type: 'last' };
  }
  if ((args[0] || '').toLowerCase() === 'rerun') {
    const count = /^\d+$/.test(args[1] || '') ? Number(args[1]) : null;
    return { type: 'rerun', count };
  }

  // /pixiv fav add|list|send [count]|remove <id>|tag <id> <tags...>
  if ((args[0] || '').toLowerCase() === 'fav') {
    const sub = String(args[1] || 'list').toLowerCase();
    if (sub === 'add') return { type: 'favAdd' };
    if (sub === 'list') {
      const tag = (() => {
        const i = args.findIndex(x => x === '--tag');
        return i >= 0 ? String(args[i + 1] || '').trim() : '';
      })();
      return { type: 'favList', tag: tag || null };
    }
    if (sub === 'send') {
      const count = /^\d+$/.test(args[2] || '') ? Number(args[2]) : 5;
      const i = args.findIndex(x => x === '--tag');
      const tag = i >= 0 ? String(args[i + 1] || '').trim() : '';
      return { type: 'favSend', count: Math.max(1, Math.min(20, count)), tag: tag || null };
    }
    if (sub === 'remove' || sub === 'rm' || sub === 'del') {
      return { type: 'favRemove', id: String(args[2] || '').trim() };
    }
    if (sub === 'tag') {
      const id = String(args[2] || '').trim();
      const tags = args.slice(3).join(' ').split(/[，,\s]+/).map(x => String(x).trim()).filter(Boolean);
      return { type: 'favTag', id, tags };
    }
    return { type: 'favList' };
  }

  // /pixiv verbose on|off
  if ((args[0] || '').toLowerCase() === 'verbose') {
    const mode = String(args[1] || '').toLowerCase();
    return { type: 'verbose', enabled: mode === 'on' ? true : mode === 'off' ? false : null };
  }

  // /pixiv preset save <name> <template...>
  // /pixiv preset run <name> [count]
  // /pixiv preset list
  // /pixiv preset delete <name>
  if ((args[0] || '').toLowerCase() === 'preset') {
    const sub = (args[1] || 'list').toLowerCase();
    if (sub === 'save') {
      const name = String(args[2] || '').trim();
      const template = args.slice(3).join(' ').trim();
      return { type: 'presetSave', name, template };
    }
    if (sub === 'run') {
      const name = String(args[2] || '').trim();
      const count = /^\d+$/.test(args[3] || '') ? Number(args[3]) : null;
      return { type: 'presetRun', name, count };
    }
    if (sub === 'delete' || sub === 'del' || sub === 'rm') {
      const name = String(args[2] || '').trim();
      return { type: 'presetDelete', name };
    }
    return { type: 'presetList' };
  }

  const nsfw = args.includes('--nsfw');
  const noHq = args.includes('--nohq') || args.includes('--no-hq');
  const countFirst = args.includes('--count_first') || args.includes('--count-first');
  const qualityFirst = args.includes('--quality_first') || args.includes('--quality-first');

  // Search filters:
  // --min_bookmark=1000 / --min_bookmark 1000
  // --ratio=9:16 / --ratio 9:16
  // --mode=users|bookmark|hybrid / --mode hybrid
  let minBookmark = null;
  let ratio = null;
  let qualityMode = null;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (/^--min_bookmark=\d+$/i.test(t)) {
      minBookmark = Number(t.split('=')[1]);
      continue;
    }
    if (/^--min_bookmark$/i.test(t) && /^\d+$/.test(args[i + 1] || '')) {
      minBookmark = Number(args[i + 1]);
      continue;
    }
    if (/^--ratio=\d+:\d+$/i.test(t)) {
      ratio = t.split('=')[1];
      continue;
    }
    if (/^--ratio$/i.test(t) && /^\d+:\d+$/.test(args[i + 1] || '')) {
      ratio = args[i + 1];
      continue;
    }
    if (/^--mode=(users|bookmark|hybrid)$/i.test(t)) {
      qualityMode = t.split('=')[1].toLowerCase();
      continue;
    }
    if (/^--mode$/i.test(t) && /^(users|bookmark|hybrid)$/i.test(args[i + 1] || '')) {
      qualityMode = String(args[i + 1]).toLowerCase();
      continue;
    }
  }

  // Author time-window controls:
  // --years=3 / --years 3  => random within recent N years
  // --alltime              => random across all author works
  let years = null;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (/^--years=\d+$/i.test(t)) {
      years = Number(t.split('=')[1]);
      continue;
    }
    if (/^--years$/i.test(t) && /^\d+$/.test(args[i + 1] || '')) {
      years = Number(args[i + 1]);
      continue;
    }
  }
  const alltime = args.includes('--alltime');

  const cleaned = args.filter((x, i) => {
    if (['--nsfw', '--nohq', '--no-hq', '--alltime', '--count_first', '--count-first', '--quality_first', '--quality-first'].includes(x)) return false;
    if (/^--years=\d+$/i.test(x)) return false;
    if (/^--years$/i.test(x) && /^\d+$/.test(args[i + 1] || '')) return false;
    if (i > 0 && /^\d+$/.test(x) && /^--years$/i.test(args[i - 1] || '')) return false;

    if (/^--min_bookmark=\d+$/i.test(x)) return false;
    if (/^--min_bookmark$/i.test(x) && /^\d+$/.test(args[i + 1] || '')) return false;
    if (i > 0 && /^\d+$/.test(x) && /^--min_bookmark$/i.test(args[i - 1] || '')) return false;

    if (/^--ratio=\d+:\d+$/i.test(x)) return false;
    if (/^--ratio$/i.test(x) && /^\d+:\d+$/.test(args[i + 1] || '')) return false;
    if (i > 0 && /^\d+:\d+$/.test(x) && /^--ratio$/i.test(args[i - 1] || '')) return false;

    if (/^--mode=(users|bookmark|hybrid)$/i.test(x)) return false;
    if (/^--mode$/i.test(x) && /^(users|bookmark|hybrid)$/i.test(args[i + 1] || '')) return false;
    if (i > 0 && /^(users|bookmark|hybrid)$/i.test(x) && /^--mode$/i.test(args[i - 1] || '')) return false;

    return true;
  });

  // /pixiv author <uid|name> [count] [--years N|--years=N] [--alltime]
  // /pixiv author pick <uid>
  // e.g. /pixiv author ASK 8 --years 3
  if ((cleaned[0] || '').toLowerCase() === 'author') {
    // subcommand: pick
    if ((cleaned[1] || '').toLowerCase() === 'pick') {
      const uid = String(cleaned[2] || '').trim();
      if (!/^\d+$/.test(uid)) {
        return { type: 'authorPick', nsfw, noHq, uid: '', count: 0, years: null, alltime: false };
      }
      const yearsClamped = Number.isFinite(years) ? Math.max(1, Math.min(20, years)) : null;
      return { type: 'authorPick', nsfw, noHq, uid, count: clamp(cleaned[3], 5, 1, 20), years: yearsClamped, alltime };
    }

    const rawAuthorArgs = args.slice(1);
    const kept = [];
    let count = 5;

    for (let i = 0; i < rawAuthorArgs.length; i++) {
      const t = String(rawAuthorArgs[i] || '');
      if (!t) continue;
      if (t === '--nsfw' || t === '--nohq' || t === '--no-hq' || t === '--alltime') continue;
      if (/^--years=\d+$/i.test(t)) continue;
      if (/^--years$/i.test(t)) {
        if (/^\d+$/.test(rawAuthorArgs[i + 1] || '')) i += 1;
        continue;
      }
      kept.push(t);
    }

    // Optional trailing count
    if (kept.length > 1 && /^\d+$/.test(kept[kept.length - 1])) {
      count = clamp(kept[kept.length - 1], 5, 1, 20);
      kept.pop();
    }

    const yearsClamped = Number.isFinite(years) ? Math.max(1, Math.min(20, years)) : null;
    return {
      type: 'author',
      nsfw,
      noHq,
      count,
      author: kept.join(' ').trim(),
      years: yearsClamped,
      alltime,
    };
  }

  // /pixiv rank <count> <daily|weekly|monthly|all>
  if ((cleaned[0] || '').toLowerCase() === 'rank') {
    const count = clamp(cleaned[1], 5, 1, 20);
    const mode = (cleaned[2] || 'daily').toLowerCase();
    return { type: 'rank', nsfw, noHq, count, mode: ['daily', 'weekly', 'monthly', 'all'].includes(mode) ? mode : 'daily' };
  }

  // /pixiv [count|range] [keyword...]
  let count = 5;
  let range = null;
  let idx = 0;
  if (/^\d+$/.test(cleaned[0] || '')) {
    count = clamp(cleaned[0], 5, 1, 20);
    idx = 1;
  } else if (/^\d+-\d+$/.test(cleaned[0] || '')) {
    const [a, b] = cleaned[0].split('-').map(n => Number(n));
    range = { start: Math.max(1, a), end: Math.max(a, b) };
    idx = 1;
  }

  const keyword = cleaned.slice(idx).join(' ').trim() || 'オリジナル';
  return {
    type: 'search',
    nsfw,
    noHq,
    count,
    range,
    keyword,
    minBookmark: Number.isFinite(minBookmark) ? Math.max(0, minBookmark) : null,
    ratio: ratio || null,
    qualityMode: qualityMode || null,
    countFirst,
    qualityFirst,
  };
}

function clamp(v, d, min, max) {
  let n = Number(v);
  if (!Number.isFinite(n)) n = d;
  if (n < min) n = min;
  if (n > max) n = max;
  return n;
}
