import {authRoute, loginPage, ready, signedInUser} from './google-auth.js';
const appHtml = "__PANEL_HTML__";
const privateHeaders = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN'};
const json = (value, status = 200) => Response.json(value, {status, headers:privateHeaders});
const empty = {events:[], notes:[]};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!ready(env) || url.origin !== env.APP_ORIGIN) return json({error:'Вход через Google ещё не настроен.'}, 503);
    if (url.pathname.startsWith('/auth/')) {
      return await authRoute(request, env, url) ?? json({error:'Страница не найдена.'}, 404);
    }
    const user = await signedInUser(request, env);
    if (!user && url.pathname === '/' && request.method === 'GET') {
      return new Response(loginPage(url.searchParams.get('auth')), {headers:{...privateHeaders,'Content-Type':'text/html; charset=utf-8'}});
    }
    if (!user) return json({error:'Войдите через Google.'}, 401);
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(appHtml, {headers:{...privateHeaders,'Content-Type':'text/html; charset=utf-8'}});
    }
    if (url.pathname !== '/api/records') return json({error:'Страница не найдена.'}, 404);
    try {
      if (request.method === 'GET') {
        const row = await env.DB.prepare('SELECT payload, revision FROM panel_records WHERE owner = ?').bind(user).first();
        return json(row ? {data:JSON.parse(row.payload), revision:row.revision} : {data:empty, revision:0});
      }
      if (request.method !== 'PUT') return json({error:'Недопустимый метод.'}, 405);
      if (request.headers.get('Origin') !== url.origin || request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') {
        return json({error:'Запрос отклонён.'}, 403);
      }
      const body = await request.text();
      if (new TextEncoder().encode(body).length > 750000) return json({error:'Слишком много данных для одного сохранения.'}, 413);
      let input;
      try { input = JSON.parse(body); } catch { return json({error:'Некорректные данные.'}, 400); }
      const {data, revision} = input ?? {};
      if (!Number.isSafeInteger(revision) || revision < 0 ||
          !Array.isArray(data?.events) || !Array.isArray(data?.notes)) {
        return json({error:'Некорректные данные.'}, 400);
      }
      const payload = JSON.stringify(data);
      const result = revision === 0
        ? await env.DB.prepare('INSERT OR IGNORE INTO panel_records (owner, payload, revision) VALUES (?, ?, 1)').bind(user, payload).run()
        : await env.DB.prepare('UPDATE panel_records SET payload = ?, revision = revision + 1 WHERE owner = ? AND revision = ?').bind(payload, user, revision).run();
      if (result.meta.changes !== 1) return json({error:'Записи изменились в другом окне. Обновите панель и повторите действие.'}, 409);
      return json({revision:revision + 1});
    } catch {
      return json({error:'Хранилище временно недоступно.'}, 503);
    }
  }
};
