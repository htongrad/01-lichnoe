(() => {
  const DRIVE = 'https://www.googleapis.com/drive/v3/';
  const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned';
  const TAG = 'lichnoe01';
  const stateKey = 'lichnoe:google:v1';
  const backupName = 'Личное — резервная копия.json';
  let token;
  let expiresAt = 0;
  let expirationTimer;
  let failed = false;
  let client;
  let preparation;
  let retryOnOnline = false;
  let busy = false;
  let connecting = false;
  let timer;
  let status = '';
  let settings = {};
  try { settings = JSON.parse(localStorage.getItem(stateKey)) || {}; } catch {}
  // Earlier versions did not record whether local edits had reached Google.
  if (settings.backupId && !Object.hasOwn(settings, 'pending')) settings.pending = true;
  const persist = () => localStorage.setItem(stateKey, JSON.stringify(settings));
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ready = () => Boolean(token && Date.now() < expiresAt);
  let api;
  let restoreFile;
  const calendarParams = extra => '?' + new URLSearchParams(extra);
  function script(src) {
    return new Promise((resolve,reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error('Не удалось загрузить сервис Google.'));
      document.head.append(el);
    });
  }
  async function request(url, options = {}, allowed = []) {
    if (!ready()) throw new Error('Доступ Google истёк. Подключитесь снова.');
    const response = await fetch(url, {...options, headers:{Authorization:'Bearer ' + token,...options.headers}});
    if (response.status === 401) token = null;
    if (!response.ok && !allowed.includes(response.status)) {
      const body = await response.json().catch(() => null);
      throw new Error('Google ' + response.status + (body?.error?.message ? ': ' + body.error.message : ''));
    }
    return response;
  }
  const json = (method, body) => ({method, headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  async function list(url, params, field) {
    const rows = [];
    let pageToken;
    do {
      const query = {...params, ...(pageToken ? {pageToken} : {})};
      const result = await (await request(url + calendarParams(query))).json();
      rows.push(...(result[field] || []));
      pageToken = result.nextPageToken;
    } while (pageToken);
    return rows;
  }
  async function run(task) {
    if (busy) return;
    busy = true;
    failed = false;
    api.refresh();
    try { status = await task(); }
    catch (error) { failed = true; status = error.message || 'Операция не завершена.'; }
    finally { busy = false; api.refresh(); }
  }
  async function prepare(clientId) {
    if (!window.google?.accounts?.oauth2) await script('https://accounts.google.com/gsi/client');
    if (clientId !== settings.clientId) return;
    client = google.accounts.oauth2.initTokenClient({
      client_id:clientId, scope:'openid ' + DRIVE_SCOPE + ' ' + CAL_SCOPE,
      callback: result => {
        connecting = false;
        if (result.error || !google.accounts.oauth2.hasGrantedAllScopes(result, 'openid', DRIVE_SCOPE, CAL_SCOPE)) {
          failed = true;
          status = 'Для синхронизации разрешите доступ к Диску и Календарю.'; api.refresh(); return;
        }
        token = result.access_token;
        expiresAt = Date.now() + Number(result.expires_in) * 1000 - 30000;
        clearTimeout(expirationTimer);
        expirationTimer = setTimeout(() => { if (!ready()) api.refresh(); }, Math.max(0, expiresAt - Date.now()));
        run(async () => {
          try {
            const profile = await (await request('https://openidconnect.googleapis.com/v1/userinfo')).json();
            if (!profile.sub) { token = null; throw new Error('Не удалось определить аккаунт Google.'); }
            if (settings.account && settings.account !== profile.sub) {
              token = null; throw new Error('Выберите тот же аккаунт Google, который подключали ранее.');
            }
            settings.account = profile.sub;
            persist();
          } catch (error) {
            token = null;
            throw error;
          }
          if (autoEnabled() && settings.pending !== false) return sync();
          if (autoEnabled()) return 'Google подключён. Нет изменений для отправки.';
          return settings.folder ? 'Google подключён. Нажмите «Синхронизировать» для первого запуска.'
            : 'Google подключён. Выберите папку «01 ЛИЧНОЕ».';
        });
      },
      error_callback:() => { connecting = false; failed = true; status = 'Окно Google закрыто или заблокировано.'; api.refresh(); }
    });
  }
  function warmUp() {
    if (settings.clientId && !client && !preparation && navigator.onLine) {
      preparation = prepare(settings.clientId).finally(() => { preparation = null; });
      preparation.catch(() => {});
    }
    return preparation;
  }
  async function pickFolder() {
    if (!window.google?.picker) {
      if (!window.gapi) await script('https://apis.google.com/js/api.js');
      await new Promise((resolve,reject) => gapi.load('picker',{callback:resolve,onerror:reject,timeout:15000,ontimeout:reject}));
    }
    const folder = await new Promise((resolve,reject) => {
      const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
        .setIncludeFolders(true).setSelectFolderEnabled(true);
      new google.picker.PickerBuilder().addView(view).setOAuthToken(token)
        .setAppId(settings.projectNumber).setDeveloperKey(settings.apiKey).setOrigin(location.origin)
        .setTitle('Выберите папку «01 ЛИЧНОЕ»').setCallback(result => {
          if (result.action === google.picker.Action.PICKED) resolve(result.docs?.[0]);
          if (result.action === google.picker.Action.CANCEL) resolve(null);
          if (result.action === google.picker.Action.ERROR) reject(new Error('Google Picker не открыл папку.'));
        }).build().setVisible(true);
    });
    if (!folder) return 'Выбор папки отменён.';
    if (folder.name?.trim() !== '01 ЛИЧНОЕ') throw new Error('Выберите папку с названием «01 ЛИЧНОЕ».');
    if (settings.folder !== folder.id) {
      settings.autoSync = false;
      settings.pending = true;
      delete settings.lastSync;
      delete settings.backupId;
      delete settings.backupVersion;
    }
    settings.folder = folder.id;
    persist();
    return 'Папка «01 ЛИЧНОЕ» выбрана.';
  }
  async function findBackup() {
    if (!settings.folder || !/^[\w-]+$/.test(settings.folder)) throw new Error('Сначала выберите папку «01 ЛИЧНОЕ».');
    const rows = await list(DRIVE + 'files', {
      q:"trashed = false and '" + settings.folder + "' in parents and appProperties has { key='panelBackup' and value='" + TAG + "' }",
      fields:'nextPageToken,files(id,modifiedTime,version)',orderBy:'modifiedTime desc'
    },'files');
    return rows[0];
  }
  async function backup(records) {
    const existing = await findBackup();
    if (!existing && settings.backupId) {
      throw new Error('Сохранённая копия недоступна. Проверьте папку и доступ к файлу на Диске.');
    }
    const file = {format:'lichnoe-backup',version:1,exportedAt:new Date().toISOString(),data:records};
    if (existing && (settings.backupId !== existing.id || settings.backupVersion !== existing.version)) {
      throw new Error('На Диске есть копия, которой этот браузер не управлял. Сначала восстановите её, чтобы сохранить записи.');
    }
    let saved;
    const url = 'https://www.googleapis.com/upload/drive/v3/files';
    if (existing) {
      saved = await request(url + '/' + encodeURIComponent(existing.id) + '?uploadType=media&fields=id,version', json('PATCH',file));
    } else {
      const boundary = 'lichnoe_' + crypto.randomUUID();
      const metadata = {name:backupName,parents:[settings.folder],mimeType:'application/json',appProperties:{panelBackup:TAG}};
      const body = '--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(metadata)
        +'\r\n--'+boundary+'\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify(file)+'\r\n--'+boundary+'--';
      saved = await request(url + '?uploadType=multipart&fields=id,version', {method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body});
    }
    const info = await saved.json();
    settings.backupId = info.id;
    settings.backupVersion = info.version;
    persist();
  }
  const plus = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days*86400000).toISOString().slice(0,10);
  const compact = date => date.replaceAll('-','');
  const freq = {daily:'DAILY',weekdays:'WEEKLY;BYDAY=MO,TU,WE,TH,FR',weekly:'WEEKLY',monthly:'MONTHLY',yearly:'YEARLY'};
  function payload(event, zone) {
    return {summary:event.title,start:event.allDay ? {date:event.date} : {dateTime:event.date+'T'+event.start+':00',timeZone:zone},
      end:event.allDay ? {date:plus(event.date,1)} : {dateTime:event.date+'T'+event.end+':00',timeZone:zone}};
  }
  function calendarRows(events, zone) {
    const rows = new Map();
    for (const event of events) {
      const recurring = event.repeat !== 'none';
      let start = event.date;
      if (event.repeat === 'weekdays') {
        while ([0,6].includes(new Date(start+'T00:00:00Z').getUTCDay())) start = plus(start,1);
      }
      if (!api.occurs(event,start)) continue;
      const item = payload({...event,date:start},zone);
      if (recurring) {
        let rule = 'RRULE:FREQ=' + freq[event.repeat];
        const stop = event.stopBefore ? plus(event.stopBefore,-1) : '';
        const until = event.ending === 'date' ? event.until : '';
        const limit = [stop,until].filter(Boolean).sort()[0];
        if (event.ending === 'count') {
          const beforeLimit = limit ? api.countThrough(event,limit) : event.count;
          rule += ';COUNT=' + Math.min(beforeLimit,event.count);
        } else if (limit) {
          rule += ';COUNT=' + api.countThrough(event,limit);
        }
        const slots = Object.keys(event.exceptions).filter(slot => api.occurs(event,slot));
        item.recurrence = [rule];
        if (slots.length) {
          item.recurrence.push(event.allDay ? 'EXDATE;VALUE=DATE:'+slots.map(compact).join(',')
            : 'EXDATE;TZID='+zone+':'+slots.map(slot => compact(slot)+'T'+event.start.replace(':','')+'00').join(','));
        }
        for (const slot of slots) {
          const changed = event.exceptions[slot];
          if (changed) rows.set(event.id+':'+slot,payload(changed,zone));
        }
      }
      rows.set(event.id,item);
    }
    return rows;
  }
  async function fingerprint(body) {
    const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body)));
    return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
  }
  async function mirror(events) {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const desired = calendarRows(events,zone);
    const remote = await list(CAL, {privateExtendedProperty:'panel='+TAG,maxResults:'2500'},'items');
    const known = new Set(settings.mirrored || []);
    for (const event of remote) if (desired.has(event.extendedProperties?.private?.key)) known.add(event.extendedProperties.private.key);
    for (const [key,body] of desired) {
      const current = remote.find(event=>event.extendedProperties?.private?.key === key);
      const hash = await fingerprint(body);
      const marker = {panel:TAG,key,hash};
      const entry = {...body,extendedProperties:{private:marker}};
      if (!current) {
        await request(CAL,json('POST',entry));
      } else if (current.extendedProperties.private.hash !== hash) {
        await request(CAL+'/'+encodeURIComponent(current.id),json('PATCH',{...entry,recurrence:entry.recurrence || []}));
      }
      known.add(key);
      settings.mirrored = [...known];
      persist();
    }
    for (const event of remote) {
      const key = event.extendedProperties?.private?.key;
      if (known.has(key) && !desired.has(key)) {
        await request(CAL+'/'+encodeURIComponent(event.id),{method:'DELETE'},[404,410]);
        known.delete(key);
      }
    }
    settings.mirrored = [...known].filter(key => desired.has(key));
    persist();
  }
  const autoEnabled = () => Boolean(settings.folder && (settings.autoSync ?? settings.backupId));
  function sync() {
    if (!navigator.locks) return sendChanges();
    return navigator.locks.request(stateKey, {ifAvailable:true}, lock => {
      if (!lock) throw new Error('Синхронизация идёт в другом окне. Повторите после её завершения.');
      return sendChanges();
    });
  }
  async function sendChanges() {
    retryOnOnline = !navigator.onLine;
    if (retryOnOnline) return 'Нет интернета. Панель повторит синхронизацию после подключения.';
    const records = structuredClone(api.records());
    const change = settings.change;
    settings.pending = true;
    persist();
    let copied = false;
    try {
      await backup(records);
      copied = true;
      await mirror(records.events);
    } catch (error) {
      retryOnOnline = !navigator.onLine || error instanceof TypeError;
      if (copied) throw new Error('Копия на Диске сохранена. Календарь: '+error.message);
      throw error;
    }
    settings.autoSync = true;
    settings.lastSync = new Date().toISOString();
    settings.pending = change !== settings.change;
    persist();
    if (settings.pending) schedule();
    return 'Копия сохранена. Календарь обновлён.';
  }
  function schedule() {
    clearTimeout(timer);
    if (!autoEnabled() || !ready()) return;
    timer = setTimeout(() => {
      if (busy) { schedule(); return; }
      run(sync);
    },1500);
  }
  window.lichnoeGoogle = {
    init(handlers) {
      api = handlers;
      if (settings.pending && autoEnabled()) warmUp();
      document.addEventListener('visibilitychange', () => { if (!document.hidden) api.refresh(); });
      window.addEventListener('offline', () => api.refresh());
      window.addEventListener('online', () => {
        if ((settings.pending || retryOnOnline) && (autoEnabled() || retryOnOnline) && ready()) {
          if (busy) schedule();
          else run(sync);
        } else if (settings.pending && autoEnabled()) warmUp();
        api.refresh();
      });
    },
    open() { warmUp(); },
    changed() {
      if (!settings.clientId) return;
      settings.change = crypto.randomUUID();
      settings.pending = true;
      try { persist(); }
      catch { failed = true; status = 'Браузер не сохранил статус синхронизации.'; api.refresh(); return; }
      if (autoEnabled()) warmUp();
      schedule();
      api.refresh();
    },
    overview() {
      if (!settings.account || !settings.folder) return '';
      const last = settings.lastSync ? 'Последняя синхронизация: ' +
        new Intl.DateTimeFormat('ru', {dateStyle:'short', timeStyle:'short'}).format(new Date(settings.lastSync)) + '.' : '';
      if (!settings.pending && !busy && !connecting && !failed) {
        return last ? '<p>' + esc(last) + '</p>' : '';
      }
      let message = 'Есть изменения для отправки.';
      let action = '';
      if (busy || connecting) message = 'Подключение или синхронизация…';
      else if (!navigator.onLine) message = 'Есть изменения для отправки. Панель ждёт интернет.';
      else if (!autoEnabled()) action = '<button type="button" class="action" data-action="google">Открыть синхронизацию</button>';
      else if (!ready()) action = '<button type="button" class="action" data-google="connect">Подключить Google</button>';
      else if (failed || retryOnOnline) action = '<button type="button" class="action" data-google="sync">Повторить</button>';
      if (failed && status) message += ' ' + status;
      return '<p>' + esc(message) + '</p>' + action;
    },
    clearRestore() { restoreFile = null; },
    restored() {
      if (!restoreFile) return;
      settings.backupId = restoreFile.id;
      settings.backupVersion = restoreFile.version;
      restoreFile = null;
      persist();
    },
    html() {
      const disconnected = autoEnabled() && !ready() && !busy && !connecting;
      const disabled = busy || connecting ? ' disabled' : '';
      if (!settings.clientId) return `<form data-google-config>
        <label>Идентификатор OAuth клиента<input name="clientId" required autocapitalize="none" spellcheck="false" placeholder="…apps.googleusercontent.com"></label>
        <label>Номер проекта Google Cloud<input name="projectNumber" required inputmode="numeric"></label>
        <label>Ключ Google Picker<input name="apiKey" required autocapitalize="none" spellcheck="false"></label>
        <button type="submit" class="action primary">Сохранить настройки</button><p role="alert" data-google-validation></p></form><p class="record" role="status">${esc(status)}</p>`;
      return `<p class="record" role="status">${esc(status || 'Записи хранятся в браузере. Google получает резервную копию и зеркало событий.')}</p>
      ${disconnected ? '<p>Подключите Google, чтобы синхронизировать изменения. Папка сохранена.</p>' : ''}
      <div class="controls">${ready()
        ? `<button type="button" class="action" data-google="folder"${disabled}>${settings.folder?'Изменить папку':'Выбрать папку на Диске'}</button>
        <button type="button" class="action primary" data-google="sync"${disabled}>Синхронизировать</button>
        <button type="button" class="action" data-google="restore"${disabled}>Восстановить с Диска</button>
        <button type="button" data-google="disconnect"${disabled}>Отключить</button>`
        : `<button type="button" class="action primary" data-google="connect"${disabled}>Подключить Google</button>`}
        <button type="button" data-google="reset"${disabled}>Изменить настройки</button></div>`;
    },
    configure(form) {
      const fields = new FormData(form);
      const copied = name => String(fields.get(name) ?? '')
        .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '').trim();
      const clientId = copied('clientId').replace(/^https?:\/\//i, '');
      const projectNumber = copied('projectNumber').replace(/\s/gu, '');
      const apiKey = copied('apiKey');
      const invalid = [
        ['clientId', /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId),
          'Вставьте Client ID из Google Auth Platform → Clients. Он заканчивается на .apps.googleusercontent.com.'],
        ['projectNumber', /^\d+$/.test(projectNumber),
          'Вставьте Project number из настроек проекта Google Cloud. Это число, например 123456789012, а не Project ID.'],
        ['apiKey', /^[A-Za-z0-9_-]+$/.test(apiKey),
          'Вставьте значение API key из Credentials. Используйте кнопку копирования ключа.']
      ].find(([,valid]) => !valid);
      if (invalid) {
        const [name,,message] = invalid;
        const input = form.elements.namedItem(name);
        const hint = form.querySelector('[data-google-validation]');
        hint.textContent = message;
        input.focus();
        return;
      }
      const next = {clientId,projectNumber,apiKey};
      try { localStorage.setItem(stateKey, JSON.stringify(next)); }
      catch {
        form.querySelector('[data-google-validation]').textContent = 'Браузер не сохранил настройки. Откройте панель в обычной вкладке Chrome.';
        return;
      }
      settings = next;
      warmUp();
      status = 'Настройки сохранены.';
      api.refresh();
    },
    action(action) {
      if (busy || connecting) return;
      if (action === 'connect') {
        if (client) {
          connecting = true;
          api.refresh();
          try { client.requestAccessToken({prompt:''}); }
          catch { connecting = false; failed = true; status = 'Не удалось открыть окно Google.'; api.refresh(); }
        }
        else run(async () => {
          const loading = warmUp();
          if (!loading) throw new Error('Проверьте подключение к интернету.');
          await loading;
          return 'Google готов. Нажмите «Подключить Google» ещё раз.';
        });
      } else if (action === 'folder') run(pickFolder);
      else if (action === 'sync') run(sync);
      else if (action === 'restore') run(async () => {
        const file = await findBackup();
        if (!file) throw new Error('В этой папке пока нет резервной копии.');
        const copy = await (await request(DRIVE+'files/'+encodeURIComponent(file.id)+'?alt=media')).json();
        api.offerRestore(copy);
        restoreFile = file;
        return 'Копия загружена. Подтвердите добавление записей.';
      });
      else if (action === 'disconnect' || action === 'reset') {
        token = null; client = null; clearTimeout(timer);
        if (action === 'reset') { settings = {}; persist(); }
        failed = false;
        clearTimeout(expirationTimer);
        status = 'Google отключён.';
        api.refresh();
      }
    }
  };
})();
