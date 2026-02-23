import WebSocket from 'ws';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

const plugin = {
  register(api) {
    const cfg = api.pluginConfig || {};
    const napcatWs = cfg.napcatWs || process.env.NAPCAT_WS;
    const napcatToken = cfg.napcatToken || process.env.NAPCAT_TOKEN || '';
    const botQQ = String(cfg.botQQ || process.env.BOT_QQ || '');
    const allowedUsers = cfg.allowedUsers || [];
    const adminUsers = (cfg.adminUsers || []).map(String);
    const httpPort = Number(cfg.port || 0);

    if (!napcatWs) {
      api.logger.warn('qq: missing napcatWs, plugin disabled');
      return;
    }

    const gwCfg = api.config?.gateway || {};
    const gwPort = gwCfg.port || 18789;
    const gwToken = gwCfg.auth?.token || process.env.OPENCLAW_TOKEN;
    const openclawApi = `http://127.0.0.1:${gwPort}/v1/responses`;

    const log = api.logger;

    // ── Sessions directory (for context reset) ──
    const openclawDir = path.dirname(api.config?.agents?.defaults?.workspace || path.join(process.env.HOME, '.openclaw', 'workspace'));
    const sessionsDir = path.join(openclawDir, 'agents', 'main', 'sessions');
    const RESET_COMMANDS = ['/reset', '/重置'];



    // ── Session output forwarder (push async assistant messages to QQ) ──
    // Problem this solves: background subagent/cron "announce" messages arrive later
    // in the OpenClaw session, but there is no incoming QQ message to trigger a reply.
    // We watch the session .jsonl files and forward new assistant text to the right QQ user.

    const sessionFileOffsets = new Map(); // sessionFile -> lastReadByte
    const forwardedSignatures = new Set(); // avoid duplicates across restarts/events
    const recentlySentTexts = new Map(); // sessionKey -> {text, atMs}
    const MAX_RECENT_MS = 15000;

    function qqTargetFromSessionKey(sessionKey) {
      // sessionKey examples:
      // - agent:main:openresponses-user:qq_1023182297
      // - agent:main:openresponses-user:qqg_587526665_1023182297
      const s = String(sessionKey || '');
      let m = s.match(/:qqg_(\d+)_(\d+)$/);
      if (m) return { isGroup: true, groupId: m[1], userId: m[2] };
      m = s.match(/:qq_(\d+)$/);
      if (m) return { isGroup: false, groupId: null, userId: m[1] };
      return null;
    }

    async function getSessionsIndex() {
      try {
        const sessionsFile = path.join(sessionsDir, 'sessions.json');
        const sessionsData = JSON.parse(await fs.readFile(sessionsFile, 'utf8'));
        return sessionsData;
      } catch {
        return {};
      }
    }

    async function sessionKeyForSessionFile(fileId) {
      // fileId = <uuid> from <uuid>.jsonl
      const sessionsData = await getSessionsIndex();
      for (const [k, v] of Object.entries(sessionsData)) {
        if (v && v.sessionId === fileId) return k;
      }
      return null;
    }

    function extractAssistantTextFromJsonlLine(obj) {
      if (!obj || obj.type !== 'message') return null;
      const msg = obj.message;
      if (!msg || msg.role !== 'assistant') return null;
      const parts = Array.isArray(msg.content) ? msg.content : [];
      const texts = [];
      for (const part of parts) {
        if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          texts.push(part.text.trim());
        }
      }
      if (!texts.length) return null;
      return { text: texts.join("\n\n"), textSignature: parts.find(p => p?.type === 'text')?.textSignature };
    }

    async function forwardNewAssistantOutput(sessionFile) {
      try {
        const st = await fs.stat(sessionFile).catch(() => null);
        if (!st) return;
        const prev = sessionFileOffsets.get(sessionFile) || 0;
        const end = st.size;
        if (end <= prev) return;

        // Read appended bytes
        const fh = await fs.open(sessionFile, 'r');
        try {
          const len = end - prev;
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, prev);
          sessionFileOffsets.set(sessionFile, end);
          const chunk = buf.toString('utf8');
          const lines = chunk.split(/\r?\n/).filter(Boolean);

          // Resolve which QQ user this session belongs to
          const fileId = path.basename(sessionFile).replace(/\.jsonl$/, '');
          const sessionKey = await sessionKeyForSessionFile(fileId);
          const target = qqTargetFromSessionKey(sessionKey);
          if (!target?.userId) return;

          for (const line of lines) {
            let obj;
            try { obj = JSON.parse(line); } catch { continue; }
            const extracted = extractAssistantTextFromJsonlLine(obj);
            if (!extracted) continue;

            const sig = extracted.textSignature || obj.id || crypto.createHash('sha1').update(extracted.text).digest('hex');
            const uniqueKey = `${fileId}:${sig}`;
            if (forwardedSignatures.has(uniqueKey)) continue;

            // Suppress echo of messages we already sent synchronously
            const recent = recentlySentTexts.get(sessionKey);
            const now = Date.now();
            if (recent && (now - recent.atMs) < MAX_RECENT_MS && recent.text === extracted.text) {
              forwardedSignatures.add(uniqueKey);
              continue;
            }

            forwardedSignatures.add(uniqueKey);
            if (target.isGroup) sendToQQ(target.groupId, extracted.text, true);
            else sendToQQ(target.userId, extracted.text, false);
          }
        } finally {
          await fh.close();
        }
      } catch (err) {
        log.error(`[Forwarder] error: ${err.message}`);
      }
    }

    let forwarderWatcher = null;

    async function startSessionForwarder() {
      if (forwarderWatcher) return;

      // Initialize offsets to current ends (so we only forward new messages)
      try {
        const files = await fs.readdir(sessionsDir).catch(() => []);
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          const fp = path.join(sessionsDir, f);
          const st = await fs.stat(fp).catch(() => null);
          if (st) sessionFileOffsets.set(fp, st.size);
        }
      } catch {}

      forwarderWatcher = fsSync.watch(sessionsDir, { persistent: true }, (eventType, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return;
        const fp = path.join(sessionsDir, filename);
        // Debounce-ish: schedule read soon
        setTimeout(() => forwardNewAssistantOutput(fp), 50);
      });

      log.info('[Forwarder] session .jsonl watcher started');
    }

    async function stopSessionForwarder() {
      if (forwarderWatcher) {
        try {
          if (typeof forwarderWatcher.close === 'function') forwarderWatcher.close();
          else if (typeof forwarderWatcher.return === 'function') forwarderWatcher.return();
        } catch {}
        forwarderWatcher = null;
      }
      sessionFileOffsets.clear();
      forwardedSignatures.clear();
      recentlySentTexts.clear();
      log.info('[Forwarder] stopped');
    }

    // ── Dedup ──
    const processedMsgIds = new Map();
    function isDuplicate(msgId) {
      if (!msgId) return false;
      const key = String(msgId);
      if (processedMsgIds.has(key)) return true;
      processedMsgIds.set(key, Date.now());
      if (processedMsgIds.size > 1000) {
        const cutoff = Date.now() - 600000;
        for (const [k, v] of processedMsgIds) {
          if (v < cutoff) processedMsgIds.delete(k);
        }
      }
      return false;
    }

    // ── Image handling ──
    const IMAGE_CACHE_DIR = '/tmp/openclaw-qq-images';
    const IMAGE_MAX_AGE_MS = 60 * 60 * 1000;

    async function downloadImage(imageUrl) {
      try {
        log.info(`[Image] downloading ${imageUrl.slice(0, 100)}`);
        const response = await fetch(imageUrl);
        if (!response.ok) return null;
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > 10 * 1024 * 1024) return null;
        await fs.mkdir(IMAGE_CACHE_DIR, { recursive: true });
        const ext = (buffer[0] === 0x89 && buffer[1] === 0x50) ? '.png'
          : (buffer[0] === 0x47 && buffer[1] === 0x49) ? '.gif' : '.jpg';
        const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
        const filepath = path.join(IMAGE_CACHE_DIR, filename);
        await fs.writeFile(filepath, buffer);
        log.info(`[Image] saved ${filename} (${(buffer.byteLength / 1024).toFixed(1)}KB)`);
        return filepath;
      } catch (err) {
        log.error(`[Image] download failed: ${err.message}`);
        return null;
      }
    }

    async function cleanupImageCache() {
      try {
        const files = await fs.readdir(IMAGE_CACHE_DIR).catch(() => []);
        const cutoff = Date.now() - IMAGE_MAX_AGE_MS;
        for (const file of files) {
          const filepath = path.join(IMAGE_CACHE_DIR, file);
          const stat = await fs.stat(filepath).catch(() => null);
          if (stat && stat.mtimeMs < cutoff) await fs.unlink(filepath).catch(() => {});
        }
      } catch {}
    }

    // ── Extract message content ──

    async function extractContent(message) {
      if (typeof message === 'string') return message;
      if (!Array.isArray(message)) return '';

      const textParts = [];
      const imagePrompts = [];

      for (const seg of message) {
        if (seg.type === 'text') {
          textParts.push(seg.data?.text ?? '');
        } else if (seg.type === 'image') {
          const url = seg.data?.url;
          if (url) {
            const localPath = await downloadImage(url);
            if (localPath) {
              imagePrompts.push(`[用户发送了一张图片]\n本地路径: ${localPath}\n请使用image工具分析这张图片并回复用户。`);
            } else {
              imagePrompts.push(`[用户发送了一张图片]\n图片URL: ${url}`);
            }
          }
        }
      }

      let result = textParts.join('').trim();
      if (imagePrompts.length > 0) {
        result = result ? `${result}\n\n${imagePrompts.join('\n\n')}` : imagePrompts.join('\n\n');
      }
      return result;
    }

    // ── Context reset ──

    async function resetSession(sessionId) {
      const sessionKey = `agent:main:openresponses-user:${sessionId.toLowerCase()}`;
      try {
        const sessionsFile = path.join(sessionsDir, 'sessions.json');
        const sessionsData = JSON.parse(await fs.readFile(sessionsFile, 'utf8'));
        const session = sessionsData[sessionKey];
        if (session?.sessionId) {
          const sessionFile = path.join(sessionsDir, `${session.sessionId}.jsonl`);
          await fs.rename(sessionFile, `${sessionFile}.reset.${Date.now()}`).catch(() => {});
          delete sessionsData[sessionKey];
          await fs.writeFile(sessionsFile, JSON.stringify(sessionsData, null, 2));
          log.info(`[Reset] session ${sessionKey} cleared`);
          return '上下文已重置，开始新的对话。';
        }
        log.info(`[Reset] no session found for ${sessionKey}`);
        return '当前没有活跃的对话上下文。';
      } catch (err) {
        log.error(`[Reset] error: ${err.message}`);
        return '重置失败，请稍后重试。';
      }
    }

    // ── OpenClaw API ──

    async function callOpenClaw(text, sessionId) {
      const headers = { 'Content-Type': 'application/json' };
      if (gwToken) headers['Authorization'] = `Bearer ${gwToken}`;

      log.info(`[OpenClaw ->] session=${sessionId} text=${text.slice(0, 100)}`);

      const res = await fetch(openclawApi, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'openclaw', input: text, user: sessionId, stream: false }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`HTTP ${res.status}: ${err.slice(0, 200)}`);
      }

      const data = await res.json();
      const texts = [];
      if (data.output && Array.isArray(data.output)) {
        for (const item of data.output) {
          if (item.type === 'message' && Array.isArray(item.content)) {
            for (const part of item.content) {
              if (part.type === 'output_text' && part.text) texts.push(part.text);
            }
          }
        }
      }
      const reply = texts.join('\n').trim() || null;
      if (reply) log.info(`[OpenClaw <-] len=${reply.length}`);
      return reply;
    }

    // ── NapCat WebSocket ──

    let napcat = null;
    let reconnectTimer = null;
    let stopped = false;
    let reconnectCount = 0;
    let lastDisconnectCode = null;

    // ── NapCat heartbeat / auto-reconnect ──
    // Problem: NapCat/adapter can get into a "half-open" state (TCP looks alive,
    // but events stop flowing). We proactively ping and reconnect on timeout.
    const PING_INTERVAL_MS = 30_000;
    const PONG_TIMEOUT_MS = 90_000;
    const INBOUND_IDLE_RECONNECT_MS = 5 * 60_000;

    let hbTimer = null;
    let lastPongAtMs = 0;
    let lastInboundAtMs = 0; // any WS message received (events or RPC)

    function stopHeartbeat() {
      if (hbTimer) clearInterval(hbTimer);
      hbTimer = null;
      lastPongAtMs = 0;
      lastInboundAtMs = 0;
    }

    function startHeartbeat() {
      stopHeartbeat();
      const now = Date.now();
      lastPongAtMs = now;
      lastInboundAtMs = now;

      hbTimer = setInterval(() => {
        if (stopped) return;
        if (!napcat) return;

        const rs = napcat.readyState;
        if (rs !== WebSocket.OPEN) return;

        // send ws-level ping
        try { napcat.ping(); } catch {}

        const t = Date.now();
        const noPong = (t - lastPongAtMs) > PONG_TIMEOUT_MS;
        const idle = (t - lastInboundAtMs) > INBOUND_IDLE_RECONNECT_MS;
        if (noPong || idle) {
          log.warn(`[NapCat] heartbeat timeout: noPong=${noPong} idle=${idle}; forcing reconnect`);
          try { napcat.terminate(); } catch {
            try { napcat.close(); } catch {}
          }
        }
      }, PING_INTERVAL_MS);

      // Avoid keeping Node alive just for this interval
      if (typeof hbTimer.unref === 'function') hbTimer.unref();
    }

    const pendingRpc = new Map(); // echo -> {resolve, reject, timer}

    function napcatSend(payload) {
      if (!napcat || napcat.readyState !== WebSocket.OPEN) {
        log.error('[NapCat] not connected, dropping message');
        return false;
      }
      napcat.send(JSON.stringify(payload));
      return true;
    }

    function napcatCall(action, params = {}, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        const echo = `rpc_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const timer = setTimeout(() => {
          pendingRpc.delete(echo);
          reject(new Error(`NapCat RPC timeout: ${action}`));
        }, timeoutMs);
        pendingRpc.set(echo, { resolve, reject, timer });
        const ok = napcatSend({ action, params, echo });
        if (!ok) {
          clearTimeout(timer);
          pendingRpc.delete(echo);
          reject(new Error('NapCat not connected'));
        }
      });
    }

    const lastSentMessageIdByContext = new Map(); // contextKey -> message_id
    const lastPixivSearchAtByContext = new Map(); // contextKey -> atMs (rate limit)

    const workspaceDir = api.config?.agents?.defaults?.workspace || path.join(process.env.HOME, '.openclaw', 'workspace');
    const HELP_FILE = path.join(workspaceDir, 'QQ_BOT_HELP.md');

    async function loadHelpText() {
      try {
        const txt = await fs.readFile(HELP_FILE, 'utf8');
        const out = String(txt || '').trim();
        return out || 'QQ_BOT_HELP.md 为空。';
      } catch {
        return (
          '暂无帮助文件 QQ_BOT_HELP.md。\n' +
          '管理员可以在 OpenClaw workspace 根目录创建 QQ_BOT_HELP.md。'
        );
      }
    }

    function contextKey(isGroup, groupId, userId) {
      return isGroup ? `group:${String(groupId)}` : `user:${String(userId)}`;
    }

    function makeTraceId(prefix = 't') {
      return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
    }

    function logJson(level, obj) {
      try {
        const line = JSON.stringify(obj);
        if (level === 'error') log.error(line);
        else if (level === 'warn') log.warn(line);
        else log.info(line);
      } catch (e) {
        log.warn('[trace] failed to stringify log object');
      }
    }

    function trace(stage, base, extra = {}, level = 'info') {
      const payload = {
        ts: new Date().toISOString(),
        subsystem: 'openclaw-qq',
        stage,
        ...base,
        ...extra,
      };
      logJson(level, payload);
    }

    // ── Send queue (per context) + global concurrency + adaptive delay ──
    const sendTailByContext = new Map(); // contextKey -> Promise
    const sendStatsByContext = new Map(); // contextKey -> {delayMs, ok, timeout, err}

    // Config center: use plugin config (cfg) as the source of truth
    const cfgSendQueue = cfg?.sendQueue || {};
    const GLOBAL_SEND_MAX_CONCURRENCY = Number(cfgSendQueue.maxConcurrency || 2);
    let globalSendActive = 0;
    const globalSendWaiters = [];

    async function acquireGlobalSendSlot() {
      if (globalSendActive < GLOBAL_SEND_MAX_CONCURRENCY) {
        globalSendActive += 1;
        return;
      }
      await new Promise((resolve) => globalSendWaiters.push(resolve));
      globalSendActive += 1;
    }

    function releaseGlobalSendSlot() {
      globalSendActive = Math.max(0, globalSendActive - 1);
      const next = globalSendWaiters.shift();
      if (next) next();
    }

    function getSendStats(ctxKey) {
      const k = String(ctxKey || '');
      if (!k) return { delayMs: 1200, ok: 0, timeout: 0, err: 0 };
      if (!sendStatsByContext.has(k)) {
        const start = Number(cfgSendQueue.delayStartMs || 1200);
        sendStatsByContext.set(k, { delayMs: start, ok: 0, timeout: 0, err: 0 });
      }
      return sendStatsByContext.get(k);
    }

    function adaptDelay(ctxKey, outcome) {
      const st = getSendStats(ctxKey);
      const min = Number(cfgSendQueue.delayMinMs || 600);
      const max = Number(cfgSendQueue.delayMaxMs || 3500);
      if (outcome === 'timeout') {
        st.timeout += 1;
        st.delayMs = Math.min(max, Math.round(st.delayMs * 1.35 + 150));
      } else if (outcome === 'err') {
        st.err += 1;
        st.delayMs = Math.min(max, Math.round(st.delayMs * 1.15 + 50));
      } else {
        st.ok += 1;
        // slowly relax if stable
        if (st.ok % 5 === 0) st.delayMs = Math.max(min, Math.round(st.delayMs * 0.92));
      }
    }

    function sleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    function deriveContextKey(isGroup, targetId) {
      return isGroup ? `group:${String(targetId)}` : `user:${String(targetId)}`;
    }

    function enqueueSend(ctxKey, fn, meta = {}) {
      const key = String(ctxKey || '');
      const prev = sendTailByContext.get(key) || Promise.resolve();
      const next = prev
        .catch(() => {})
        .then(async () => {
          await acquireGlobalSendSlot();
          const t0 = Date.now();
          try {
            const res = await fn();
            adaptDelay(key, 'ok');
            return res;
          } catch (e) {
            const msg = String(e?.message || e);
            if (/timeout/i.test(msg)) adaptDelay(key, 'timeout');
            else adaptDelay(key, 'err');
            log.error(`[SendQueue] failed ctx=${key} trace=${meta.traceId||''} meta=${JSON.stringify(meta)} err=${msg}`);
            throw e;
          } finally {
            const dt = Date.now() - t0;
            releaseGlobalSendSlot();
            // minor pacing to avoid bursting (uses adaptive delay)
            const st = getSendStats(key);
            await sleep(Math.min(500, Math.max(0, Math.round(st.delayMs * 0.15))));
            if (dt > 0 && meta?.label) {
              log.info(`[SendQueue] done ctx=${key} label=${meta.label} dt=${dt}ms delay=${getSendStats(key).delayMs}ms trace=${meta.traceId||''}`);
            }
          }
        });
      sendTailByContext.set(key, next);
      return next;
    }

    function buildSegments({ text, imageUrls, imagePaths, replyToMessageId } = {}) {
      const segs = [];
      if (replyToMessageId) {
        segs.push({ type: 'reply', data: { id: String(replyToMessageId) } });
      }
      if (text) {
        segs.push({ type: 'text', data: { text: String(text) } });
      }
      // Local paths first (preferred)
      if (Array.isArray(imagePaths)) {
        for (const p of imagePaths) {
          if (!p) continue;
          // NapCat/OneBot v11 typically accepts local file path via data.file
          segs.push({ type: 'image', data: { file: String(p) } });
        }
      }
      // URLs
      if (Array.isArray(imageUrls)) {
        for (const u of imageUrls) {
          if (!u) continue;
          // OneBot v11 image segment: NapCat accepts file=url in many setups
          segs.push({ type: 'image', data: { file: String(u) } });
        }
      }
      return segs;
    }

    async function sendToQQTrackedCore(target, text, isGroup = false, opts = {}) {
      const message = opts.segments || buildSegments({
        text,
        imageUrls: opts.imageUrls,
        imagePaths: opts.imagePaths,
        replyToMessageId: opts.replyToMessageId,
      });

      const action = isGroup ? 'send_group_msg' : 'send_private_msg';
      const params = isGroup
        ? { group_id: Number(target), message }
        : { user_id: Number(target), message };

      // Sending images can be slow; allow longer RPC wait.
      const rpc = await napcatCall(action, params, 60000);
      const mid = rpc?.data?.message_id;
      if (mid && opts.contextKey) lastSentMessageIdByContext.set(String(opts.contextKey), Number(mid));
      log.info(`[QQ -> ${isGroup ? 'group:' : ''}${target}] ${(text || '').slice(0, 100)}`);
      return rpc;
    }

    function sendToQQCore(target, text, isGroup = false, opts = {}) {
      const message = opts.segments || buildSegments({
        text,
        imageUrls: opts.imageUrls,
        imagePaths: opts.imagePaths,
        replyToMessageId: opts.replyToMessageId,
      });
      const payload = isGroup
        ? { action: 'send_group_msg', params: { group_id: Number(target), message } }
        : { action: 'send_private_msg', params: { user_id: Number(target), message } };
      const ok = napcatSend(payload);
      if (ok) log.info(`[QQ -> ${isGroup ? 'group:' : ''}${target}] ${(text || '').slice(0, 100)}`);
      return ok;
    }

    // Public send APIs now go through the send queue.
    async function sendToQQTracked(target, text, isGroup = false, opts = {}) {
      const ctxKey = opts.contextKey || deriveContextKey(isGroup, target);
      return enqueueSend(ctxKey, () => sendToQQTrackedCore(target, text, isGroup, { ...opts, contextKey: ctxKey }), {
        label: 'tracked',
        target,
        isGroup,
      });
    }

    function sendToQQ(target, text, isGroup = false, opts = {}) {
      const ctxKey = opts.contextKey || deriveContextKey(isGroup, target);
      // Fire-and-forget queue item
      enqueueSend(ctxKey, async () => {
        sendToQQCore(target, text, isGroup, opts);
      }, { label: 'send', target, isGroup });
    }

    async function sendPixivBundleWithExistingStableStrategy({ isGroup, groupId, userId, contextKey: ctxKey, text, imagePaths }) {
      const targetId = isGroup ? String(groupId) : String(userId);
      const MAX_IMAGES_PER_MSG = 1;
      const st = getSendStats(ctxKey || deriveContextKey(isGroup, targetId));
      const SEND_DELAY_MS = Math.max(800, Math.min(5000, st.delayMs));
      const TEXT_BEFORE_IMAGES_DELAY_MS = Math.max(300, Math.min(2500, Math.round(st.delayMs * 0.5)));

      if (text) {
        try {
          await sendToQQTracked(targetId, text, isGroup, {
            segments: [{ type: 'text', data: { text: String(text) } }],
            contextKey: ctxKey,
          });
        } catch (err) {
          const msg = String(err?.message || err);
          if (!/timeout/i.test(msg)) sendToQQ(targetId, text, isGroup);
        }
        await new Promise(r => setTimeout(r, TEXT_BEFORE_IMAGES_DELAY_MS));
      }

      const paths = Array.isArray(imagePaths) ? imagePaths : [];
      for (let i = 0; i < paths.length; i += MAX_IMAGES_PER_MSG) {
        const chunk = paths.slice(i, i + MAX_IMAGES_PER_MSG);
        const segs = [];
        for (const p of chunk) {
          try {
            const buf = await fs.readFile(String(p));
            if (buf.byteLength > 8 * 1024 * 1024) continue;
            segs.push({ type: 'image', data: { file: `base64://${buf.toString('base64')}` } });
          } catch {}
        }
        if (!segs.length) continue;

        try {
          await sendToQQTracked(targetId, '', isGroup, { segments: segs, contextKey: ctxKey });
        } catch (err) {
          const msg = String(err?.message || err);
          if (!/timeout/i.test(msg)) sendToQQ(targetId, '', isGroup, { segments: segs });
        }

        if (i + MAX_IMAGES_PER_MSG < paths.length) await new Promise(r => setTimeout(r, SEND_DELAY_MS));
      }

      // optional reconnect to avoid half-open
      try { napcat?.terminate?.(); } catch { try { napcat?.close?.(); } catch {} }
    }

    // Optional Pixiv module (graceful degrade)
    let pixivPlugin = null;
    import('./src/pixiv/index.js')
      .then((mod) => {
        pixivPlugin = mod?.createPixivPlugin?.({
          logger: log,
          sendBundle: sendPixivBundleWithExistingStableStrategy,
          pixivConfig: cfg?.pixiv || {},
        }) || null;
        if (pixivPlugin) log.info('[Pixiv] plugin loaded');
        else log.warn('[Pixiv] 插件未加载');
      })
      .catch((e) => {
        log.warn(`[Pixiv] 插件未加载: ${e.message}`);
        pixivPlugin = null;
      });

    function connectNapCat() {
      if (stopped) return;
      const url = napcatToken
        ? `${napcatWs}${napcatWs.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(napcatToken)}`
        : napcatWs;

      napcat = new WebSocket(url);

      napcat.on('open', () => {
        log.info('[NapCat] connected');
        startHeartbeat();
      });

      napcat.on('pong', () => {
        lastPongAtMs = Date.now();
      });

      napcat.on('message', async (raw) => {
        lastInboundAtMs = Date.now();
        let data;
        try { data = JSON.parse(raw); } catch { return; }

        // Handle RPC responses
        if (data.echo) {
          const pending = pendingRpc.get(String(data.echo));
          if (pending) {
            clearTimeout(pending.timer);
            pendingRpc.delete(String(data.echo));
            pending.resolve(data);
          }
          return;
        }
        if (data.post_type !== 'message') return;

        const msgId = data.message_id;
        if (isDuplicate(msgId)) return;

        const isGroup = data.message_type === 'group';

        const userId = String(data.user_id || '');

        // Filter: check allowlist for private chat OR group triggers
        if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) return;

        // Admin-only protection for sensitive requests:
        // if user asks to change allowlist/admin list, only adminUsers are allowed to proceed.
        // (This does not modify config by itself; it blocks future "please remove admin" social-engineering.)
        const isAdmin = adminUsers.length > 0 ? adminUsers.includes(userId) : false;

        // Group trigger support (opt-in): only respond when @mentioning the bot and group is allowed.
        // OneBot v11 group message includes group_id and message segments; @ mention is segment {type:'at', data:{qq:'<id>'}}.
        const groupId = isGroup ? String(data.group_id || '') : '';
        const allowedGroups = cfg.allowedGroups || [];
        if (isGroup) {
          // Require group allowlist
          if (allowedGroups.length > 0 && !allowedGroups.includes(groupId)) return;
          // Require botQQ to be set
          if (!botQQ) return;
          // Require @ mention in original segments
          const segs = Array.isArray(data.message) ? data.message : [];
          const mentioned = segs.some((seg) => seg?.type === 'at' && String(seg?.data?.qq) === botQQ);
          if (!mentioned) return;
        }

        let text = await extractContent(data.message);
        if (!text) return;

        log.info(`[<- ${isGroup ? `group:${groupId} user:${userId}` : `user:${userId}`}] ${text.slice(0, 100)}`);

        // IMPORTANT: keep group + private sessions separate to avoid cross-posting.
        const sessionId = isGroup ? `qqg_${groupId}_${userId}` : `qq_${userId}`;

        // Context reset
        if (RESET_COMMANDS.includes(text.trim().toLowerCase())) {
          const msg = await resetSession(sessionId);
          const ctx = contextKey(isGroup, groupId, userId);
          if (isGroup) await sendToQQTracked(groupId, msg, true, { contextKey: ctx }).catch(() => sendToQQ(groupId, msg, true));
          else await sendToQQTracked(userId, msg, false, { contextKey: ctx }).catch(() => sendToQQ(userId, msg));
          return;
        }

        // Admin shortcut: recall last bot message in this context
        // Triggers (Chinese): "撤回我刚发的上一条" / "撤回上一条" ; (English): /recall_last
        const trimmed = text.trim();
        const wantsRecallLast = /^\/recall_last$/i.test(trimmed) || /撤回(我刚发的)?上一条/.test(trimmed);
        if (isAdmin && wantsRecallLast) {
          const ctx = contextKey(isGroup, groupId, userId);
          const lastId = lastSentMessageIdByContext.get(ctx);
          if (!lastId) {
            if (isGroup) sendToQQ(groupId, '没有可撤回的上一条（未记录message_id）。', true);
            else sendToQQ(userId, '没有可撤回的上一条（未记录message_id）。');
            return;
          }
          try {
            await napcatCall('delete_msg', { message_id: Number(lastId) }, 15000);
          } catch (err) {
            const msg = `撤回失败：${err.message}`;
            if (isGroup) sendToQQ(groupId, msg, true);
            else sendToQQ(userId, msg);
          }
          return;
        }

        // Built-in command: /help or hyw (send QQ_BOT_HELP.md)
        const cmd = text.trim();
        if (/^\/help$/i.test(cmd) || /^hyw$/i.test(cmd)) {
          const traceId = makeTraceId('help');
          trace('help', { traceId, contextKey: contextKey(isGroup, groupId, userId), isGroup, groupId, userId }, { cmd: cmd });

          const help = await loadHelpText();
          const ctx = contextKey(isGroup, groupId, userId);
          if (isGroup) await sendToQQTracked(groupId, help, true, { contextKey: ctx }).catch(() => sendToQQ(groupId, help, true));
          else await sendToQQTracked(userId, help, false, { contextKey: ctx }).catch(() => sendToQQ(userId, help));
          return;
        }

        // Built-in command namespace: /pixiv ... (aliases: /p, p)
        // Normalize full-width slash and zero-width chars to avoid false negatives.
        const cmdNorm = cmd
          .replace(/[／]/g, '/')
          .replace(/[\u200B-\u200D\uFEFF]/g, '')
          .trim();
        const pixivDirect = /^\/(?:pixiv|p)(?:\s+|$)/i.test(cmdNorm) || /^p(?:\s+|$)/i.test(cmdNorm);
        const pixivMatch = cmdNorm.match(/(?:^|\s)(\/pixiv|\/p|p)\s*(.*)$/i);
        if (pixivDirect && pixivMatch) {
          const traceId = makeTraceId('pixiv');
          if (!pixivPlugin) {
            const msg = 'Pixiv 插件未加载';
            if (isGroup) sendToQQ(groupId, msg, true);
            else sendToQQ(userId, msg);
            return;
          }
          const alias = pixivMatch[1].toLowerCase();
          const rest = (pixivMatch[2] || '').trim();
          const normalizedCmd = rest ? `/pixiv ${rest}` : '/pixiv 5 オリジナル';
          log.info(`[PixivCmd] matched alias=${alias} normalized=${normalizedCmd}`);
          trace('pixiv.cmd', { traceId, contextKey: contextKey(isGroup, groupId, userId), isGroup, groupId, userId }, { normalizedCmd });
          try {
            const out = await pixivPlugin.handleCommand({
              cmd: normalizedCmd,
              traceId,
              isGroup,
              groupId,
              userId,
              contextKey: contextKey(isGroup, groupId, userId),
            });
            if (!out?.ok && out?.message) {
              if (isGroup) sendToQQ(groupId, out.message, true);
              else sendToQQ(userId, out.message);
            }
          } catch (e) {
            const msg = `pixiv命令异常: ${e.message}`;
            if (isGroup) sendToQQ(groupId, msg, true);
            else sendToQQ(userId, msg);
          }
          return;
        }


        // Built-in command: /config get|set (admin only)
        if (/^\/config(\s|$)/i.test(cmd)) {
          if (!adminUsers.has(String(userId))) {
            const msg = '无权限：仅管理员可用 /config';
            if (isGroup) sendToQQ(groupId, msg, true);
            else sendToQQ(userId, msg);
            return;
          }
          const parts = cmd.split(/\s+/).filter(Boolean);
          const sub = (parts[1] || 'get').toLowerCase();
          if (sub === 'get') {
            const eff = {
              sendQueue: {
                maxConcurrency: GLOBAL_SEND_MAX_CONCURRENCY,
                delayStartMs: Number(cfgSendQueue.delayStartMs || 1200),
                delayMinMs: Number(cfgSendQueue.delayMinMs || 600),
                delayMaxMs: Number(cfgSendQueue.delayMaxMs || 3500),
              },
              pixiv: cfg?.pixiv || {},
            };
            const msg = 'config:\n' + JSON.stringify(eff, null, 2);
            if (isGroup) await sendToQQTracked(groupId, msg, true, { contextKey: contextKey(isGroup, groupId, userId) }).catch(() => sendToQQ(groupId, msg, true));
            else await sendToQQTracked(userId, msg, false, { contextKey: contextKey(isGroup, groupId, userId) }).catch(() => sendToQQ(userId, msg));
            return;
          }
          if (sub === 'set') {
            const kv = parts.slice(2).join(' ').trim();
            const m = kv.match(/^([a-zA-Z0-9_.-]+)\s*=\s*(.+)$/);
            if (!m) {
              const msg = '用法：/config set sendQueue.delayMaxMs=3500 或 /config set pixiv.searchPages=8';
              if (isGroup) sendToQQ(groupId, msg, true);
              else sendToQQ(userId, msg);
              return;
            }

            const key = m[1];
            const rawVal = m[2];
            const allowedPrefixes = ['sendQueue.', 'pixiv.'];
            if (!allowedPrefixes.some(p => key.startsWith(p))) {
              const msg = `不允许修改该 key：${key}（仅允许 sendQueue.* / pixiv.*）`;
              if (isGroup) sendToQQ(groupId, msg, true);
              else sendToQQ(userId, msg);
              return;
            }

            // Parse value types
            let val;
            if (/^(true|false)$/i.test(rawVal)) val = /^true$/i.test(rawVal);
            else if (/^-?\d+(?:\.\d+)?$/.test(rawVal)) val = Number(rawVal);
            else val = String(rawVal);

            // Load and patch ~/.openclaw/openclaw.json (same root as workspace's parent)
            const cfgPath = path.join(openclawDir, 'openclaw.json');
            try {
              const txt = await fs.readFile(cfgPath, 'utf8');
              const j = JSON.parse(txt);
              j.plugins = j.plugins || {};
              j.plugins.entries = j.plugins.entries || {};
              j.plugins.entries['openclaw-qq'] = j.plugins.entries['openclaw-qq'] || {};
              j.plugins.entries['openclaw-qq'].config = j.plugins.entries['openclaw-qq'].config || {};

              const root = j.plugins.entries['openclaw-qq'].config;
              const partsKey = key.split('.');
              let cur = root;
              for (let i = 0; i < partsKey.length - 1; i++) {
                const k = partsKey[i];
                cur[k] = cur[k] || {};
                cur = cur[k];
              }
              cur[partsKey[partsKey.length - 1]] = val;

              await fs.writeFile(cfgPath, JSON.stringify(j, null, 2) + '\n', 'utf8');

              const msg = `已写入配置：${key}=${JSON.stringify(val)}\n正在重启生效...`;
              if (isGroup) sendToQQ(groupId, msg, true);
              else sendToQQ(userId, msg);

              // Ask gateway to reload config + restart (SIGUSR1)
              try { process.kill(process.pid, 'SIGUSR1'); } catch {}
            } catch (e) {
              const msg = `写配置失败：${e.message}`;
              if (isGroup) sendToQQ(groupId, msg, true);
              else sendToQQ(userId, msg);
            }
            return;
          }
          const msg = '用法：/config get | /config set key=value';
          if (isGroup) sendToQQ(groupId, msg, true);
          else sendToQQ(userId, msg);
          return;
        }

        // Built-in command: /diag (runtime diagnostics)
        if (/^\/diag$/i.test(cmd)) {
          const ctx = contextKey(isGroup, groupId, userId);
          const st = getSendStats(ctx);
          const qDepth = sendTailByContext.has(ctx) ? 1 : 0;
          const info = [
            `diag:`,
            `- napcat: ${napcat && napcat.readyState === WebSocket.OPEN ? 'OPEN' : (napcat ? 'NOT_OPEN' : 'NONE')}`,
            `- lastPongAgoMs: ${lastPongAtMs ? (Date.now() - lastPongAtMs) : 'n/a'}`,
            `- lastInboundAgoMs: ${lastInboundAtMs ? (Date.now() - lastInboundAtMs) : 'n/a'}`,
            `- reconnectCount: ${reconnectCount}`,
            `- lastDisconnectCode: ${lastDisconnectCode ?? 'n/a'}`,
            `- sendDelayMs: ${st.delayMs}`,
            `- sendStats(ok/timeout/err): ${st.ok}/${st.timeout}/${st.err}`,
          ].join('\n');
          if (isGroup) await sendToQQTracked(groupId, info, true, { contextKey: ctx }).catch(() => sendToQQ(groupId, info, true));
          else await sendToQQTracked(userId, info, false, { contextKey: ctx }).catch(() => sendToQQ(userId, info));
          return;
        }
        // Guardrail: admin-only allowlist/admin changes
        // If a non-admin tries to request allowlist/admin modifications, deny early.
        const lower = text.toLowerCase();
        const wantsAccessChange = /allowedusers|allowlist|白名单|管理员|admin/.test(lower);
        const wantsPrivilegeChange = /权限|授权|提权|最高权限|root|owner|superuser|admin(?:istrator)?|grant|promote|elevate/.test(lower);
        const wantsModify = /add|append|allow|permit|include|加入|添加|新增|remove|delete|drop|ban|unban|删|移除|禁用|拉黑|解禁|设为|设置/.test(lower);
        if ((wantsAccessChange || wantsPrivilegeChange) && wantsModify && !isAdmin) {
          sendToQQ(userId, '权限不足：权限/白名单/管理员相关操作仅管理员可执行。');
          return;
        }

        // Call OpenClaw
        try {
          const reply = await callOpenClaw(text, sessionId);
          if (reply) {
            // Mark as recently-sent to suppress duplicate forwarding via the session watcher
            const sessionKey = `agent:main:openresponses-user:${sessionId.toLowerCase()}`;
            recentlySentTexts.set(sessionKey, { text: reply, atMs: Date.now() });
            const ctx = contextKey(isGroup, groupId, userId);
            if (isGroup) await sendToQQTracked(groupId, reply, true, { contextKey: ctx }).catch(() => sendToQQ(groupId, reply, true));
            else await sendToQQTracked(userId, reply, false, { contextKey: ctx }).catch(() => sendToQQ(userId, reply));
          }
        } catch (err) {
          log.error(`[OpenClaw] error: ${err.message}`);
          sendToQQ(userId, '服务暂时不可用，请稍后再试。');
        }

        cleanupImageCache();
      });

      napcat.on('close', (code) => {
        stopHeartbeat();
        reconnectCount += 1;
        lastDisconnectCode = code;
        log.info(`[NapCat] disconnected (${code})`);
        if (!stopped) {
          reconnectTimer = setTimeout(connectNapCat, 5000);
        }
      });

      napcat.on('error', (err) => {
        log.error(`[NapCat] error: ${err.message}`);
      });
    }

    // ── Optional HTTP server for proactive messaging ──

    let httpServer = null;

    function readBody(req) {
      return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
      });
    }

    // ── Service registration ──

    api.registerService({
      id: 'qq-napcat',
      async start() {
        stopped = false;
        connectNapCat();
        await startSessionForwarder();

        if (httpPort > 0) {
          httpServer = http.createServer(async (req, res) => {
            const urlObj = new URL(req.url, `http://localhost:${httpPort}`);
            const pathname = urlObj.pathname;

            // /pixiv_search: search pixiv (safe-only by default) and send original-quality images
            // POST /pixiv_search { userId|groupId, queryType, count<=10, safeOnly?:true }
            if (req.method === 'POST' && pathname === '/pixiv_search') {
              try {
                if (!pixivPlugin) {
                  res.writeHead(503, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'Pixiv 插件未加载' }));
                  return;
                }

                const body = await readBody(req);
                const parsed = body ? JSON.parse(body) : {};
                const userId = urlObj.searchParams.get('userId') || parsed.userId;
                const groupId = urlObj.searchParams.get('groupId') || parsed.groupId;
                const isGroup = !!groupId;
                const ctxKey = contextKey(isGroup, String(groupId || ''), String(userId || ''));

                const traceId = makeTraceId('pixiv_http');
                trace('pixiv.http', { traceId, contextKey: ctxKey, isGroup, groupId, userId }, { route: '/pixiv_search' });
                const out = await pixivPlugin.handleHttpSearch({ ...parsed, traceId });
                if (!out?.ok) {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ ok: false, error: out?.message || 'pixiv search failed' }));
                  return;
                }

                await sendPixivBundleWithExistingStableStrategy({
                  isGroup,
                  groupId,
                  userId,
                  contextKey: ctxKey,
                  text: out.header,
                  imagePaths: out.imagePaths,
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, pickedIds: out.pickedIds || [], imageCount: (out.imagePaths || []).length }));
              } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
              }
              return;
            }

            if (req.method === 'POST' && pathname === '/pixiv_rank') {
              try {
                if (!pixivPlugin) {
                  res.writeHead(503, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'Pixiv 插件未加载' }));
                  return;
                }

                const body = await readBody(req);
                const parsed = body ? JSON.parse(body) : {};
                parsed.mode = String(parsed.mode || 'daily').toLowerCase();
                parsed.type = 'rank';

                const userId = urlObj.searchParams.get('userId') || parsed.userId;
                const groupId = urlObj.searchParams.get('groupId') || parsed.groupId;
                const isGroup = !!groupId;
                const ctxKey = contextKey(isGroup, String(groupId || ''), String(userId || ''));

                const traceId = makeTraceId('pixiv_http');
                trace('pixiv.http', { traceId, contextKey: ctxKey, isGroup, groupId, userId }, { route: '/pixiv_search' });
                const out = await pixivPlugin.handleHttpSearch({ ...parsed, traceId });
                if (!out?.ok) {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ ok: false, error: out?.message || 'pixiv rank failed' }));
                  return;
                }

                await sendPixivBundleWithExistingStableStrategy({
                  isGroup,
                  groupId,
                  userId,
                  contextKey: ctxKey,
                  text: out.header,
                  imagePaths: out.imagePaths,
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, pickedIds: out.pickedIds || [], imageCount: (out.imagePaths || []).length }));
              } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
              }
              return;
            }

            // /send: proactive send (expects {text, userId|groupId}; also supports query overrides)
            if (req.method === 'POST' && pathname === '/send') {
              try {
                const body = await readBody(req);
                const parsed = body ? JSON.parse(body) : {};
                const text = parsed.text ?? parsed.message ?? '';
                const userId = urlObj.searchParams.get('userId') || parsed.userId;
                const groupId = urlObj.searchParams.get('groupId') || parsed.groupId;

                // NOTE: NapCat runs on a different host (often Windows) and cannot read
                // Linux/WSL file paths directly. So for outbound local images, we convert
                // to OneBot11 base64:// payloads.

                const segmentsIn = Array.isArray(parsed.segments) ? parsed.segments : null;
                const imageUrls = Array.isArray(parsed.imageUrls) ? parsed.imageUrls : null;
                const imagePaths = Array.isArray(parsed.imagePaths) ? parsed.imagePaths : null;
                const replyToMessageId = parsed.replyToMessageId ?? parsed.replyTo ?? null;

                // Build final segments. If caller provided `segments`, trust them.
                // Otherwise, compose from text + imagePaths/imageUrls.
                let segments = segmentsIn;
                if (!segments) {
                  segments = [];
                  if (replyToMessageId) segments.push({ type: 'reply', data: { id: String(replyToMessageId) } });
                  if (text) segments.push({ type: 'text', data: { text: String(text) } });

                  if (Array.isArray(imagePaths)) {
                    for (const p of imagePaths) {
                      if (!p) continue;
                      try {
                        const buf = await fs.readFile(String(p));
                        if (buf.byteLength > 8 * 1024 * 1024) throw new Error('file too large (>8MB)');
                        segments.push({ type: 'image', data: { file: `base64://${buf.toString('base64')}` } });
                      } catch (e) {
                        log.error(`[Image] outbound read failed: ${String(p)}: ${e.message}`);
                      }
                    }
                  }

                  if (Array.isArray(imageUrls)) {
                    for (const u of imageUrls) {
                      if (!u) continue;
                      segments.push({ type: 'image', data: { file: String(u) } });
                    }
                  }
                }

                if ((!userId && !groupId) || (!text && (!segments || segments.length === 0) && !imageUrls && !imagePaths)) {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'need (userId or groupId) and (text or segments or imageUrls or imagePaths)' }));
                  return;
                }

                // If there are many images in one message, NapCat may time out waiting for
                // onMsgInfoListUpdate callbacks even though the send succeeds. To reduce pressure,
                // we split into smaller batches.
                const MAX_IMAGES_PER_MSG = 1;
                const SEND_DELAY_MS = 1500;
                const TEXT_BEFORE_IMAGES_DELAY_MS = 600;
                const RESTART_NAPCAT_AFTER_IMAGE_SEND = true;

                function countImages(segs) {
                  return (Array.isArray(segs) ? segs : []).filter(s => s?.type === 'image').length;
                }

                function splitIntoBatches(segs) {
                  const batches = [];
                  const prefix = [];
                  const images = [];

                  for (const s of (Array.isArray(segs) ? segs : [])) {
                    if (s?.type === 'image') images.push(s);
                    else prefix.push(s);
                  }

                  if (images.length <= MAX_IMAGES_PER_MSG) return [segs];

                  for (let i = 0; i < images.length; i += MAX_IMAGES_PER_MSG) {
                    const chunk = images.slice(i, i + MAX_IMAGES_PER_MSG);
                    // only include prefix (text/reply) in the first batch to avoid spam
                    batches.push(i === 0 ? [...prefix, ...chunk] : [...chunk]);
                  }
                  return batches;
                }

                async function sendBatches(isGroup, targetId, ctxKey) {
                  const segsAll = Array.isArray(segments) ? segments : [];
                  const hasImages = countImages(segsAll) > 0;

                  // Strategy: send text-only first (to avoid first image carrying extra load)
                  if (hasImages && text) {
                    const textOnly = segsAll.filter(s => s?.type !== 'image');
                    if (textOnly.length > 0) {
                      try {
                        await sendToQQTracked(String(targetId), String(text), isGroup, { segments: textOnly, replyToMessageId, contextKey: ctxKey });
                      } catch (err) {
                        const msg = String(err?.message || err);
                        log.error(`[QQ/send] ${isGroup ? 'group' : 'user'} text-first error: ${msg}`);
                        if (!/timeout/i.test(msg)) {
                          sendToQQ(String(targetId), String(text), isGroup, { segments: textOnly, replyToMessageId });
                        }
                      }
                      await new Promise(r => setTimeout(r, TEXT_BEFORE_IMAGES_DELAY_MS));
                    }
                  }

                  // Now send images in small batches
                  const batches = splitIntoBatches(segsAll);
                  for (let i = 0; i < batches.length; i++) {
                    const segs = batches[i];
                    // If we already sent text-first, drop non-image parts from all image batches
                    const onlyImages = hasImages && text ? (Array.isArray(segs) ? segs.filter(s => s?.type === 'image') : segs) : segs;
                    if (!onlyImages || (Array.isArray(onlyImages) && onlyImages.length === 0)) continue;

                    try {
                      await sendToQQTracked(String(targetId), String(text), isGroup, { segments: onlyImages, replyToMessageId, contextKey: ctxKey });
                    } catch (err) {
                      const msg = String(err?.message || err);
                      log.error(`[QQ/send] ${isGroup ? 'group' : 'user'} send error (batch ${i + 1}/${batches.length}): ${msg}`);
                      if (!/timeout/i.test(msg)) {
                        sendToQQ(String(targetId), String(text), isGroup, { segments: onlyImages, replyToMessageId });
                      }
                    }
                    if (i < batches.length - 1) await new Promise(r => setTimeout(r, SEND_DELAY_MS));
                  }

                  // Strategy: after image sends, restart NapCat WS to avoid half-open stuck state
                  if (hasImages && RESTART_NAPCAT_AFTER_IMAGE_SEND) {
                    log.warn('[NapCat] restarting WS after image send (requested strategy)');
                    try { napcat?.terminate?.(); } catch { try { napcat?.close?.(); } catch {} }
                  }
                }

                if (groupId) {
                  const ctx = contextKey(true, String(groupId), null);
                  await sendBatches(true, String(groupId), ctx);
                } else {
                  const ctx = contextKey(false, null, String(userId));
                  await sendBatches(false, String(userId), ctx);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
              } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
              }
              return;
            }

            // /recall: recall a message by message_id (admin-only; requires userId in adminUsers)
            // POST /recall?userId=2317891476 {"messageId":123}
            if (req.method === 'POST' && pathname === '/recall') {
              try {
                const body = await readBody(req);
                const parsed = body ? JSON.parse(body) : {};
                const requester = String(urlObj.searchParams.get('userId') || parsed.userId || '');
                const messageId = urlObj.searchParams.get('messageId') || parsed.messageId;

                if (!requester || !(adminUsers.length > 0 ? adminUsers.includes(requester) : false)) {
                  res.writeHead(403, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'admin only' }));
                  return;
                }
                if (!messageId) {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'messageId required' }));
                  return;
                }

                const rpc = await napcatCall('delete_msg', { message_id: Number(messageId) }, 15000);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, rpc }));
              } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
              }
              return;
            }

            // /members: get group member list (admin-only)
            // GET /members?userId=2317891476&groupId=587526665
            if (req.method === 'GET' && pathname === '/members') {
              try {
                const requester = String(urlObj.searchParams.get('userId') || '');
                const groupId = String(urlObj.searchParams.get('groupId') || '');

                if (!requester || !(adminUsers.length > 0 ? adminUsers.includes(requester) : false)) {
                  res.writeHead(403, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'admin only' }));
                  return;
                }
                if (!groupId) {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'groupId required' }));
                  return;
                }

                const rpc = await napcatCall('get_group_member_list', { group_id: Number(groupId) }, 20000);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, rpc }));
              } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
              }
              return;
            }

            // /cron: accepts cron webhook payloads and forwards to QQ
            // Use: delivery.mode=webhook to http://127.0.0.1:<port>/cron?userId=1023182297
            if (req.method === 'POST' && pathname === '/cron') {
              try {
                const body = await readBody(req);
                let parsed = {};
                try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = { raw: body }; }

                const userId = urlObj.searchParams.get('userId') || parsed.userId;
                const groupId = urlObj.searchParams.get('groupId') || parsed.groupId;

                // Try to extract a human message from common webhook shapes
                const candidate =
                  parsed.text ||
                  parsed.message ||
                  parsed.summary ||
                  parsed.result?.text ||
                  parsed.run?.result?.text ||
                  parsed.run?.outputText ||
                  parsed.outputText ||
                  parsed.payload?.message ||
                  parsed.payload?.text ||
                  null;

                const text = (candidate && String(candidate).trim())
                  ? String(candidate).trim()
                  : `Cron webhook received:\n${JSON.stringify(parsed, null, 2).slice(0, 3500)}`;

                if ((!userId && !groupId) || !text) {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'need userId/groupId (query or body)' }));
                  return;
                }

                if (groupId) {
                  const ctx = contextKey(true, String(groupId), null);
                  await sendToQQTracked(String(groupId), text, true, { contextKey: ctx }).catch(() => sendToQQ(String(groupId), text, true));
                } else {
                  const ctx = contextKey(false, null, String(userId));
                  await sendToQQTracked(String(userId), text, false, { contextKey: ctx }).catch(() => sendToQQ(String(userId), text, false));
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
              } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
              }
              return;
            }

            res.writeHead(404);
            res.end('not found');
          });

          await new Promise((resolve) => {
            httpServer.on('error', (err) => {
              log.error(`[HTTP] error: ${err.message}`);
              resolve();
            });
            httpServer.listen(httpPort, '127.0.0.1', () => {
              log.info(`[HTTP] proactive send endpoint on 127.0.0.1:${httpPort}/send`);
              resolve();
            });
          });
        }

        log.info(`openclaw-qq plugin started`);
        log.info(`  NapCat WS: ${napcatWs}`);
        log.info(`  OpenClaw:  ${openclawApi}`);
        log.info(`  Bot QQ:    ${botQQ || '(not set)'}`);
        log.info(`  Users:     ${allowedUsers.length > 0 ? allowedUsers.join(', ') : '(all)'}`);
        log.info(`  Groups:    send-only via /send endpoint`);
      },

      async stop() {
        stopped = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        await stopSessionForwarder();
        if (napcat) napcat.close();
        if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
        log.info('openclaw-qq plugin stopped');
      },
    });
  },
};

export default plugin;
