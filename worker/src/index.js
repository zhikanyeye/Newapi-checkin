const json = (data, status = 200, env) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

const now = () => new Date().toISOString();
const text = async (request) => request.json().catch(() => null);

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function tokenFrom(request) {
  const value = request.headers.get('authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

async function requireRunner(request, env) {
  return tokenFrom(request) && tokenFrom(request) === env.RUNNER_TOKEN;
}

async function requireSession(request, env) {
  const token = tokenFrom(request);
  if (!token) return false;
  const hash = await sha256(token);
  const row = await env.Check.prepare('SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(hash, now()).first();
  return Boolean(row);
}

async function encrypt(value, env) {
  if (!env.DATA_ENCRYPTION_KEY) throw new Error('缺少 DATA_ENCRYPTION_KEY Secret');
  const keyBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.DATA_ENCRYPTION_KEY)));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
  return `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(encrypted)))}`;
}

async function decrypt(value, env) {
  if (!env.DATA_ENCRYPTION_KEY) throw new Error('缺少 DATA_ENCRYPTION_KEY Secret');
  const [ivText, dataText] = value.split('.');
  const keyBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.DATA_ENCRYPTION_KEY)));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const iv = Uint8Array.from(atob(ivText), (char) => char.charCodeAt(0));
  const data = Uint8Array.from(atob(dataText), (char) => char.charCodeAt(0));
  const result = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(result);
}

function accountView(row) {
  return {
    id: row.id, name: row.name, url: row.url, enabled: Boolean(row.enabled),
    failure_count: row.failure_count, last_status: row.last_status,
    last_message: row.last_message, last_checkin_at: row.last_checkin_at,
  };
}

async function handler(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'GET' && path === '/api/health') {
    const missing = [];
    if (!env.Check) missing.push('Check');
    if (!env.DASHBOARD_PASSWORD) missing.push('DASHBOARD_PASSWORD');
    if (!env.RUNNER_TOKEN) missing.push('RUNNER_TOKEN');
    if (!env.DATA_ENCRYPTION_KEY) missing.push('DATA_ENCRYPTION_KEY');
    if (missing.length) {
      return json({ ok: false, service: 'newapi-checkin-worker', missing, time: now() }, 503, env);
    }
    await env.Check.prepare('SELECT 1').first();
    return json({ ok: true, service: 'newapi-checkin-worker', database: 'connected', time: now() }, 200, env);
  }

  if (method === 'POST' && path === '/api/auth/login') {
    const body = await text(request);
    if (!env.Check || !env.DASHBOARD_PASSWORD) return json({ error: 'Worker 尚未完成 Check 和 DASHBOARD_PASSWORD 绑定' }, 503, env);
    if (!body?.password || body.password !== env.DASHBOARD_PASSWORD) return json({ error: '访问口令错误' }, 401, env);
    const token = crypto.randomUUID();
    const expires = new Date(Date.now() + Number(env.SESSION_TTL_SECONDS || 86400) * 1000).toISOString();
    await env.Check.prepare('INSERT INTO sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)')
      .bind(await sha256(token), expires, now()).run();
    return json({ token, expires_at: expires }, 200, env);
  }

  if (path.startsWith('/api/runner/')) {
    if (!(await requireRunner(request, env))) return json({ error: 'Runner 未授权' }, 401, env);
    if (method === 'GET' && path === '/api/runner/config') {
      const rows = await env.Check.prepare('SELECT id, name, url, secret FROM accounts WHERE enabled = 1 ORDER BY id').all();
      const accounts = [];
      for (const row of rows.results) accounts.push({ ...JSON.parse(await decrypt(row.secret, env)), name: row.name, account_id: row.id });
      return json({ accounts }, 200, env);
    }
    if (method === 'POST' && path === '/api/runner/report') {
      const body = await text(request);
      if (!body || !Array.isArray(body.results)) return json({ error: '结果格式错误' }, 400);
      const createdAt = now();
      const run = await env.Check.prepare('INSERT INTO runs (execution_time, total, success_count, fail_count, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(body.execution_time || createdAt, body.total || body.results.length, body.success_count || 0, body.fail_count || 0, createdAt).run();
      for (const result of body.results) {
        const account = result.account_id
          ? await env.Check.prepare('SELECT id, failure_count FROM accounts WHERE id = ?').bind(result.account_id).first()
          : await env.Check.prepare('SELECT id, failure_count FROM accounts WHERE name = ?').bind(result.name || '').first();
        await env.Check.prepare('INSERT INTO run_results (run_id, account_id, name, success, message, quota_awarded, checkin_count, session_expired, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(run.meta.last_row_id, account?.id || null, result.name || '未知账号', result.success ? 1 : 0, result.message || '', result.quota_awarded || null, result.checkin_count || null, result.session_expired ? 1 : 0, createdAt).run();
        if (account) {
          const failureCount = result.success ? 0 : (account.failure_count || 0) + 1;
          await env.Check.prepare('UPDATE accounts SET failure_count = ?, last_status = ?, last_message = ?, last_checkin_at = ?, updated_at = ? WHERE id = ?')
            .bind(failureCount, result.success ? 'success' : 'failed', result.message || '', createdAt, createdAt, account.id).run();
        }
      }
      return json({ ok: true, run_id: run.meta.last_row_id }, 201, env);
    }
  }

  if (!(await requireSession(request, env))) return json({ error: '登录已过期' }, 401, env);
  if (method === 'GET' && path === '/api/dashboard/summary') {
    const latest = await env.Check.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').first();
    const accounts = await env.Check.prepare('SELECT * FROM accounts ORDER BY id').all();
    return json({ latest, accounts: accounts.results.map(accountView) }, 200, env);
  }
  if (method === 'GET' && path === '/api/dashboard/runs') {
    const rows = await env.Check.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 30').all();
    return json({ runs: rows.results }, 200, env);
  }
  if (method === 'GET' && path.startsWith('/api/dashboard/runs/')) {
    const id = path.split('/').pop();
    const run = await env.Check.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first();
    const results = await env.Check.prepare('SELECT * FROM run_results WHERE run_id = ? ORDER BY id').bind(id).all();
    return json({ run, results: results.results }, 200, env);
  }
  if (method === 'GET' && path === '/api/dashboard/accounts') {
    const rows = await env.Check.prepare('SELECT * FROM accounts ORDER BY id').all();
    return json({ accounts: rows.results.map(accountView) }, 200, env);
  }
  if (method === 'POST' && path === '/api/dashboard/accounts') {
    const body = await text(request);
    if (!body?.name || !body?.url || !body?.session || !/^https?:\/\//.test(body.url)) return json({ error: '请填写有效的名称、URL 和 Session' }, 400, env);
    const createdAt = now();
    const secret = await encrypt(JSON.stringify({ url: body.url, session: body.session, user_id: body.user_id || undefined, cf_clearance: body.cf_clearance || undefined }), env);
    await env.Check.prepare('INSERT INTO accounts (name, url, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(body.name, new URL(body.url).origin, secret, createdAt, createdAt).run();
    return json({ ok: true }, 201, env);
  }
  if (method === 'PATCH' && path.startsWith('/api/dashboard/accounts/')) {
    const id = path.split('/').pop();
    const body = await text(request);
    if (!body || typeof body.enabled !== 'boolean') return json({ error: 'enabled 必须是布尔值' }, 400, env);
    await env.Check.prepare('UPDATE accounts SET enabled = ?, updated_at = ? WHERE id = ?').bind(body.enabled ? 1 : 0, now(), id).run();
    return json({ ok: true }, 200, env);
  }
  return json({ error: 'Not found' }, 404, env);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) return await handler(request, env);
      if (env.ASSETS) {
        const assetUrl = new URL(request.url);
        if (assetUrl.pathname === '/' || assetUrl.pathname === '/dashboard.html') assetUrl.pathname = '/index.html';
        return env.ASSETS.fetch(new Request(assetUrl, request));
      }
      return json({ error: '静态资源绑定未配置' }, 500, env);
    } catch (error) {
      return json({ error: error.message || 'Internal error' }, 500, env);
    }
  },
};
