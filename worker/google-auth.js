const encoder = new TextEncoder();
const sessionAge = 7 * 86400;
const cookie = (name, value, age) =>
  `__Host-${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
const readCookie = (request, name) => request.headers.get('Cookie')?.split(/;\s*/)
  .find(value => value.startsWith('__Host-' + name + '='))?.split('=')[1];
const base64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), ch => ch.charCodeAt(0));
const random = () => base64(crypto.getRandomValues(new Uint8Array(32)));
const seconds = () => Math.floor(Date.now() / 1000);

async function signingKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign','verify']);
}
async function seal(data, secret) {
  const payload = base64(encoder.encode(JSON.stringify(data)));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(payload));
  return payload + '.' + base64(new Uint8Array(signature));
}
async function unseal(value, secret) {
  if (!value || value.length > 2048) return null;
  try {
    const parts = value.split('.');
    if (parts.length !== 2) return null;
    const [payload, signature] = parts;
    if (!await crypto.subtle.verify('HMAC', await signingKey(secret), decode(signature), encoder.encode(payload))) return null;
    const data = JSON.parse(new TextDecoder().decode(decode(payload)));
    return data.exp > seconds() ? data : null;
  } catch {
    return null;
  }
}

function redirect(location, cookies = []) {
  const headers = new Headers({Location:location, 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer'});
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(null, {status:303, headers});
}

export function ready(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.OWNER_GOOGLE_EMAIL &&
    env.SESSION_SECRET?.length >= 32 && env.APP_ORIGIN);
}

export async function signedInUser(request, env) {
  const data = await unseal(readCookie(request, 'panel-session'), env.SESSION_SECRET);
  return data?.kind === 'session' ? data.sub : null;
}

export async function authRoute(request, env, url) {
  if (url.pathname === '/auth/google' && request.method === 'GET') {
    const state = random();
    const verifier = random();
    const challenge = base64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
    const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    target.search = new URLSearchParams({
      client_id:env.GOOGLE_CLIENT_ID, redirect_uri:env.APP_ORIGIN + '/auth/google/callback',
      response_type:'code', scope:'openid email', state, code_challenge:challenge, code_challenge_method:'S256',
      prompt:'select_account'
    });
    const flow = await seal({kind:'flow', state, verifier, exp:seconds()+600}, env.SESSION_SECRET);
    return redirect(target.href, [cookie('panel-flow', flow, 600)]);
  }
  if (url.pathname === '/auth/google/callback' && request.method === 'GET') {
    const clear = cookie('panel-flow', '', 0);
    const flow = await unseal(readCookie(request, 'panel-flow'), env.SESSION_SECRET);
    const code = url.searchParams.get('code');
    if (flow?.kind !== 'flow' || !code || flow.state !== url.searchParams.get('state')) {
      return redirect('/?auth=failed', [clear]);
    }
    try {
      const token = await fetch('https://oauth2.googleapis.com/token', {
        method:'POST', redirect:'error', body:new URLSearchParams({
          client_id:env.GOOGLE_CLIENT_ID, client_secret:env.GOOGLE_CLIENT_SECRET, code,
          code_verifier:flow.verifier, grant_type:'authorization_code', redirect_uri:env.APP_ORIGIN + '/auth/google/callback'
        })
      });
      if (!token.ok) throw new Error();
      const {access_token} = await token.json();
      if (!access_token) throw new Error();
      const profile = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers:{Authorization:'Bearer ' + access_token}, redirect:'error'
      });
      if (!profile.ok) throw new Error();
      const {email, email_verified, sub} = await profile.json();
      if (email_verified !== true || email?.toLowerCase() !== env.OWNER_GOOGLE_EMAIL.trim().toLowerCase() ||
          typeof sub !== 'string' || !sub) return redirect('/?auth=denied', [clear]);
      const session = await seal({kind:'session', sub, exp:seconds()+sessionAge}, env.SESSION_SECRET);
      return redirect('/', [clear, cookie('panel-session', session, sessionAge)]);
    } catch {
      return redirect('/?auth=failed', [clear]);
    }
  }
  if (url.pathname === '/auth/signout' && request.method === 'POST' && request.headers.get('Origin') === url.origin) {
    return redirect('/', [cookie('panel-session', '', 0)]);
  }
  return null;
}

export function loginPage(status) {
  const message = status === 'denied' ? 'Этот аккаунт Google не имеет доступа к панели.'
    : status === 'failed' ? 'Не удалось войти. Попробуйте ещё раз.' : '';
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Вход — Личное</title><style>body{margin:0;background:#f3f6ec;color:#102319;font:1rem/1.5 system-ui,sans-serif}
  main{margin:12vh auto 0;width:min(88%,25rem)} a{display:inline-block;padding:.7rem 1rem;border-radius:.75rem;background:#10482f;color:white;font-weight:700}</style>
  <main><h1>Личное</h1>${message ? '<p role="alert">'+message+'</p>' : ''}<a href="/auth/google">Войти через Google</a></main></html>`;
}
