import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(root, '.env');
const env = {};
try {
  for (const line of (await readFile(envPath, 'utf8')).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !m[1].startsWith('#')) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) env[key] = value;
}
const port = Number(env.PORT || 8787);
const hosted = env.RENDER === 'true' || Boolean(env.RENDER_EXTERNAL_URL);
const publicBaseUrl = String(env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
if (hosted && (!publicBaseUrl || new URL(publicBaseUrl).protocol !== 'https:')) throw new Error('クラウド公開URL（HTTPS）が必要です。');
const expectedOrigin = publicBaseUrl ? new URL(publicBaseUrl).origin : `http://127.0.0.1:${port}`;
const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(root, '.data');
const statePath = path.join(dataDir, 'state.json');
const tokenPath = path.join(dataDir, 'token.json');
const appPassword = env.APP_PASSWORD || '';
const authRequired = hosted;
const localCsrfToken = randomBytes(32).toString('hex');
if (hosted && appPassword.length < 16) throw new Error('クラウド用APP_PASSWORDは16文字以上にしてください。');
env.FREEE_REDIRECT_URI = hosted
  ? `${publicBaseUrl}/oauth/callback`
  : (env.FREEE_REDIRECT_URI || `http://127.0.0.1:${port}/oauth/callback`);
let token = null;
let localOAuthState = null;
const pendingDeals = new Set();
const sessions = new Map();
const loginFailures = new Map();
const MAX_LOGIN_FAILURES = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

async function readState() {
  try { return JSON.parse(await readFile(statePath, 'utf8')); }
  catch { return { deals: {}, lastSync: null, errors: [], settings: {} }; }
}
async function saveState(state) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}
async function readToken() {
  try { token = JSON.parse(await readFile(tokenPath, 'utf8')); }
  catch { token = null; }
}
async function saveToken(value) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(tokenPath, JSON.stringify(value), { mode: 0o600 });
  token = value;
}
function send(res, status, body, type = 'application/json; charset=utf-8') {
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow'
  };
  if (hosted) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  res.writeHead(status, headers);
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
function safeEqual(left, right) {
  const a = createHash('sha256').update(String(left)).digest();
  const b = createHash('sha256').update(String(right)).digest();
  return timingSafeEqual(a, b);
}
function sessionFrom(req) {
  const cookie = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('311banchi_session='));
  if (!cookie) return null;
  const id = cookie.slice('311banchi_session='.length);
  const session = sessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  return { id, session };
}
function hasSession(req) { return Boolean(sessionFrom(req)); }
function validCsrf(req) {
  const found = sessionFrom(req);
  const expectedToken = authRequired ? found?.session.csrfToken : localCsrfToken;
  return Boolean(expectedToken && req.headers.origin === expectedOrigin && req.headers['x-csrf-token'] === expectedToken);
}
const loginHtml = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>311BANCHI ログイン</title><style>body{font-family:system-ui,sans-serif;background:#f3f4f6;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:white;padding:28px;border-radius:16px;box-shadow:0 8px 32px #0002;width:min(360px,calc(100% - 48px))}h1{font-size:20px}input,button{box-sizing:border-box;width:100%;padding:12px;margin-top:12px;border-radius:8px;font-size:16px}input{border:1px solid #bbb}button{background:#167d45;color:white;border:0;font-weight:bold;cursor:pointer}#message{color:#b42318;min-height:1.5em}</style><main class="card"><h1>311BANCHI 請求管理</h1><p>設定したパスワードを入力してください。</p><form id="login"><input id="password" type="password" autocomplete="current-password" required autofocus><button>ログイン</button></form><p id="message" role="alert"></p></main><script>document.getElementById('login').addEventListener('submit',async e=>{e.preventDefault();const message=document.getElementById('message');message.textContent='';try{const r=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('password').value})});const d=await r.json();if(!r.ok)throw new Error(d.error||'ログインできませんでした。');location.replace('/');}catch(err){message.textContent=err.message;}});</script></html>`;
async function bodyJson(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1_000_000) throw new Error('リクエストが大きすぎます');
  }
  return data ? JSON.parse(data) : {};
}
function needsEnv() {
  return ['FREEE_CLIENT_ID', 'FREEE_CLIENT_SECRET', 'FREEE_REDIRECT_URI']
    .filter(k => !env[k] || env[k].startsWith('ここに'));
}
async function accessToken() {
  if (!token) await readToken();
  if (!token) throw new Error('freeeと未接続です。「freeeに接続」を押してください。');
  if (Date.now() < token.expiresAt - 60_000) return token.access_token;
  const response = await fetch('https://accounts.secure.freee.co.jp/public_api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: env.FREEE_CLIENT_ID, client_secret: env.FREEE_CLIENT_SECRET, refresh_token: token.refresh_token })
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error_description || 'freeeの認証更新に失敗しました');
  await saveToken({ ...value, expiresAt: Date.now() + Number(value.expires_in || 3600) * 1000 });
  return token.access_token;
}
async function freeeApi(url, options = {}) {
  const bearer = await accessToken();
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.errors?.flatMap(e => e.messages || []).join(' / ') || value.message || `freee API エラー (${response.status})`);
  return value;
}
async function createDeal(record) {
  const state = await readState();
  const settings = state.settings || {};
  const invoiceNumber = String(record?.invoiceNumber || '');
  const alreadyCreated = state.deals?.[invoiceNumber];
  if (alreadyCreated) return alreadyCreated;
  if (!settings.companyId || !settings.accountItemId || !settings.taxCode) throw new Error('先にfreee設定で事業所・勘定科目・税区分を保存してください。');
  if (!record?.invoiceNumber || !record?.invoiceDate || !Array.isArray(record.items) || !record.items.length) throw new Error('請求書番号・請求日・明細が必要です');
  let offset = 0;
  while (offset < 10000) {
    const query = new URLSearchParams({ company_id: settings.companyId, limit: '100', offset: String(offset) });
    const existing = await freeeApi(`https://api.freee.co.jp/api/1/deals?${query}`);
    const deals = existing.deals || [];
    if (deals.some(x => String(x.deal?.ref_number || x.ref_number || '') === invoiceNumber)) throw new Error('同じ請求書番号の取引がfreeeにあります。二重登録を防ぐため停止しました。');
    if (deals.length < 100) break;
    offset += deals.length;
  }
  const payload = {
    company_id: Number(settings.companyId), issue_date: record.invoiceDate, due_date: record.deadline || '', type: 'income',
    ref_number: String(record.invoiceNumber), details: record.items.map(item => ({
      account_item_id: Number(settings.accountItemId), tax_code: Number(settings.taxCode),
      amount: Math.round(Number(item.qty || 0) * Number(item.unit || 0)),
      description: String(item.description || record.subject || '').slice(0, 255)
    }))
  };
  const result = await freeeApi('https://api.freee.co.jp/api/1/deals', { method: 'POST', body: JSON.stringify(payload) });
  const deal = result.deal || result;
  state.deals[String(record.invoiceNumber)] = { id: deal.id, invoiceNumber: String(record.invoiceNumber), paymentStatus: deal.status === 'settled' ? '入金済' : '未入金', updatedAt: new Date().toISOString() };
  await saveState(state);
  return state.deals[String(record.invoiceNumber)];
}
async function syncDeals(invoiceNumbers = []) {
  const state = await readState();
  if (!state.settings?.companyId) throw new Error('freee設定を保存してください。');
  state.deals ||= {};
  const requested = [...new Set(invoiceNumbers.map(value => String(value || '').trim()).filter(value => /^[-A-Za-z0-9_]{1,100}$/.test(value)))];
  const missingNumbers = requested.filter(number => !state.deals[number]);
  if (missingNumbers.length) {
    const matches = new Map();
    let offset = 0;
    while (offset < 10000 && missingNumbers.some(number => !matches.has(number))) {
      const query = new URLSearchParams({ company_id: state.settings.companyId, limit: '100', offset: String(offset) });
      const result = await freeeApi(`https://api.freee.co.jp/api/1/deals?${query}`);
      const page = result.deals || [];
      for (const item of page) {
        const deal = item.deal || item;
        const ref = String(deal.ref_number || '');
        if (!missingNumbers.includes(ref)) continue;
        const previous = matches.get(ref);
        if (previous === undefined) matches.set(ref, deal);
        else matches.set(ref, null);
      }
      if (page.length < 100) break;
      offset += page.length;
    }
    for (const number of missingNumbers) {
      const deal = matches.get(number);
      if (!deal?.id) continue;
      state.deals[number] = {
        id: Number(deal.id), invoiceNumber: number,
        paymentStatus: deal.status === 'settled' ? '入金済' : '未入金',
        updatedAt: new Date().toISOString()
      };
    }
  }
  const entries = Object.values(state.deals);
  for (const entry of entries) {
    try {
      const query = new URLSearchParams({ company_id: state.settings.companyId });
      const result = await freeeApi(`https://api.freee.co.jp/api/1/deals/${encodeURIComponent(entry.id)}?${query}`);
      const deal = result.deal || result;
      entry.paymentStatus = deal.status === 'settled' ? '入金済' : '未入金';
      entry.updatedAt = new Date().toISOString();
      entry.error = null;
    } catch (error) { entry.error = error.message; }
  }
  state.lastSync = new Date().toISOString();
  await saveState(state);
  return state;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, expectedOrigin);
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/auth/login') {
      if (!authRequired) return send(res, 404, { error: 'Not found' });
      if (req.headers.origin !== expectedOrigin) return send(res, 403, { error: 'ログイン要求を確認できませんでした。ページを開き直してください。' });
      const ip = req.socket.remoteAddress || 'unknown';
      const failure = loginFailures.get(ip);
      if (failure && Date.now() - failure.firstAt < LOGIN_WINDOW_MS && failure.count >= MAX_LOGIN_FAILURES) return send(res, 429, { error: 'ログイン試行が多すぎます。15分後にもう一度お試しください。' });
      const values = await bodyJson(req);
      if (!safeEqual(values.password || '', appPassword)) {
        const current = failure && Date.now() - failure.firstAt < LOGIN_WINDOW_MS ? failure : { firstAt: Date.now(), count: 0 };
        current.count++;
        loginFailures.set(ip, current);
        return send(res, 401, { error: 'パスワードが違います。もう一度お試しください。' });
      }
      loginFailures.delete(ip);
      const id = randomBytes(32).toString('hex');
      sessions.set(id, { expiresAt: Date.now() + SESSION_TTL_MS, csrfToken: randomBytes(32).toString('hex'), oauthState: null });
      const secure = hosted ? '; Secure' : '';
      res.setHeader('Set-Cookie', `311banchi_session=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
      return send(res, 200, { ok: true });
    }
    if (authRequired && req.method === 'GET' && url.pathname === '/' && !hasSession(req)) return send(res, 200, loginHtml, 'text/html; charset=utf-8');
    if (authRequired && !hasSession(req)) return send(res, 401, { error: 'ログインしてください。' });
    if (req.method === 'GET' && url.pathname === '/api/session') {
      return send(res, 200, { csrfToken: authRequired ? sessionFrom(req).session.csrfToken : localCsrfToken });
    }
    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      if (!authRequired) return send(res, 404, { error: 'Not found' });
      if (!validCsrf(req)) return send(res, 403, { error: 'この画面からの操作として確認できませんでした。' });
      const found = sessionFrom(req);
      sessions.delete(found.id);
      res.setHeader('Set-Cookie', '311banchi_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (hosted ? '; Secure' : ''));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const state = await readState();
      return send(res, 200, { configured: needsEnv().length === 0, missing: needsEnv(), connected: Boolean(token), settingsReady: Boolean(state.settings?.companyId && state.settings?.accountItemId && state.settings?.taxCode), lastSync: state.lastSync });
    }
    if (req.method === 'GET' && url.pathname === '/api/masters') {
      const companiesResponse = await freeeApi('https://api.freee.co.jp/api/1/companies');
      const companies = companiesResponse.companies || [];
      const selectedCompanyId = url.searchParams.get('company_id') || (await readState()).settings?.companyId || '';
      if (!selectedCompanyId) return send(res, 200, { companies, accountItems: [], taxes: [] });
      const q = new URLSearchParams({ company_id: selectedCompanyId, limit: '100' });
      const [accountsResponse, taxesResponse] = await Promise.all([
        freeeApi(`https://api.freee.co.jp/api/1/account_items?${q}`),
        freeeApi(`https://api.freee.co.jp/api/1/taxes/companies/${encodeURIComponent(selectedCompanyId)}`)
      ]);
      return send(res, 200, { companies, accountItems: accountsResponse.account_items || [], taxes: taxesResponse.taxes || [] });
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      if (!validCsrf(req)) return send(res, 403, { error: 'この画面からの操作として確認できませんでした。アプリを再読み込みしてください。' });
      const values = await bodyJson(req);
      if (![values.companyId, values.accountItemId, values.taxCode].every(v => /^\d+$/.test(String(v || '')))) return send(res, 400, { error: '事業所・勘定科目・税区分を選択してください。' });
      const state = await readState();
      state.settings = { companyId: String(values.companyId), accountItemId: String(values.accountItemId), taxCode: String(values.taxCode) };
      await saveState(state);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/auth/freee') {
      if (needsEnv().length) return send(res, 400, { error: `.envの設定が必要です: ${needsEnv().join(', ')}` });
      const state = randomBytes(24).toString('hex');
      if (authRequired) sessionFrom(req).session.oauthState = state;
      else localOAuthState = state;
      const authorize = new URL('https://accounts.secure.freee.co.jp/public_api/authorize');
      authorize.search = new URLSearchParams({ client_id: env.FREEE_CLIENT_ID, redirect_uri: env.FREEE_REDIRECT_URI, response_type: 'code', scope: 'read write', state }).toString();
      res.writeHead(302, { Location: authorize.toString() }); return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/oauth/callback') {
      const expectedState = authRequired ? sessionFrom(req).session.oauthState : localOAuthState;
      if (!expectedState || url.searchParams.get('state') !== expectedState || !url.searchParams.get('code')) return send(res, 400, 'freee認証を確認できませんでした。画面を閉じてやり直してください。', 'text/plain; charset=utf-8');
      if (authRequired) sessionFrom(req).session.oauthState = null;
      else localOAuthState = null;
      const response = await fetch('https://accounts.secure.freee.co.jp/public_api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: env.FREEE_CLIENT_ID, client_secret: env.FREEE_CLIENT_SECRET, code: url.searchParams.get('code'), redirect_uri: env.FREEE_REDIRECT_URI }) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error_description || 'freee認証に失敗しました');
      await saveToken({ ...value, expiresAt: Date.now() + Number(value.expires_in || 3600) * 1000 });
      return send(res, 200, '<meta charset="utf-8"><p>freeeに接続しました。この画面を閉じ、311BANCHIの画面に戻ってください。</p>', 'text/html; charset=utf-8');
    }
    if (req.method === 'POST' && url.pathname === '/api/create-deal') {
      if (!validCsrf(req)) return send(res, 403, { error: 'この画面からの操作として確認できませんでした。アプリを再読み込みしてください。' });
      if (needsEnv().length) return send(res, 400, { error: `設定が不足しています: ${needsEnv().join(', ')}` });
      const record = await bodyJson(req);
      const invoiceNumber = String(record?.invoiceNumber || '');
      if (pendingDeals.has(invoiceNumber)) return send(res, 409, { error: 'この請求書は登録処理中です。少し待って一覧を更新してください。' });
      pendingDeals.add(invoiceNumber);
      try { return send(res, 201, await createDeal(record)); }
      finally { pendingDeals.delete(invoiceNumber); }
    }
    if (req.method === 'POST' && url.pathname === '/api/sync') {
      if (!validCsrf(req)) return send(res, 403, { error: 'この画面からの操作として確認できませんでした。アプリを再読み込みしてください。' });
      const values = await bodyJson(req);
      return send(res, 200, await syncDeals(Array.isArray(values.invoiceNumbers) ? values.invoiceNumbers : []));
    }
    if (req.method === 'GET' && url.pathname === '/api/sync') return send(res, 200, await readState());
    if (req.method === 'GET' && url.pathname === '/api/freee-sync-backup') {
      const state = await readState();
      const deals = Object.fromEntries(Object.entries(state.deals || {}).map(([key, item]) => [key, {
        id: item.id, invoiceNumber: item.invoiceNumber, paymentStatus: item.paymentStatus, updatedAt: item.updatedAt
      }]));
      res.setHeader('Content-Disposition', 'attachment; filename="311BANCHI_freee_sync_backup.json"');
      return send(res, 200, { version: 1, exportedAt: new Date().toISOString(), settings: state.settings || {}, deals });
    }
    if (req.method === 'POST' && url.pathname === '/api/freee-sync-restore') {
      if (!validCsrf(req)) return send(res, 403, { error: 'この画面からの操作として確認できませんでした。アプリを再読み込みしてください。' });
      const backup = await bodyJson(req);
      if (backup.version !== 1 || !backup.settings || !['companyId', 'accountItemId', 'taxCode'].every(key => /^\d+$/.test(String(backup.settings[key] || ''))) || !backup.deals || typeof backup.deals !== 'object' || Array.isArray(backup.deals)) {
        return send(res, 400, { error: 'freee同期情報バックアップの形式を確認できません。' });
      }
      const keys = Object.keys(backup.deals);
      if (keys.length > 10000 || keys.some(key => {
        const item = backup.deals[key];
        return !item || !/^\d+$/.test(String(item.id || '')) || String(item.invoiceNumber || '') !== key;
      })) return send(res, 400, { error: '請求書番号またはfreee取引IDを確認できません。' });
      const current = await readState();
      if (Object.keys(current.deals || {}).length || current.settings?.companyId) return send(res, 409, { error: 'このクラウド側にはすでにfreee同期情報があります。上書きせず停止しました。' });
      current.settings = { companyId: String(backup.settings.companyId), accountItemId: String(backup.settings.accountItemId), taxCode: String(backup.settings.taxCode) };
      current.deals = Object.fromEntries(keys.map(key => [key, {
        id: Number(backup.deals[key].id), invoiceNumber: key,
        paymentStatus: backup.deals[key].paymentStatus === '入金済' ? '入金済' : '未入金',
        updatedAt: backup.deals[key].updatedAt || new Date().toISOString()
      }]));
      current.lastSync = null;
      current.errors = [];
      await saveState(current);
      return send(res, 200, { ok: true, importedDeals: keys.length });
    }
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, await readFile(path.join(root, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    return send(res, 404, { error: 'Not found' });
  } catch (error) { return send(res, 500, { error: error.message }); }
});

await mkdir(dataDir, { recursive: true });
await readToken();
server.listen(port, hosted ? '0.0.0.0' : '127.0.0.1', () => console.log(`311BANCHI freee連携: ${hosted ? publicBaseUrl : `http://127.0.0.1:${port}`}`));
setInterval(() => { if (token && !needsEnv().length) syncDeals().catch(error => console.error('同期エラー:', error.message)); }, 5 * 60 * 1000);

