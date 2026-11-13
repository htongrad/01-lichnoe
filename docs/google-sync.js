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
  let client;
  let busy = false;
  let auto = false;
  let connecting = false;
  let timer;
  let status = '';
  let settings = {};
  try { settings = JSON.parse(localStorage.getItem(stateKey)) || {}; } catch {}
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
    if (response.status === 401) { token = null; auto = false; }
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
    api.refresh();
    try { status = await task(); }
    catch (error) { status = error.message || 'Операция не завершена.'; }
    finally { busy = false; api.refresh(); }
  }
  async function prepare() {
    if (!window.google?.accounts?.oauth2) await script('https://accounts.google.com/gsi/client');
    client = google.accounts.oauth2.initTokenClient({
      client_id:settings.clientId, scope:'openid ' + DRIVE_SCOPE + ' ' + CAL_SCOPE,
      callback: result => {
        connecting = false;
        if (result.error || !google.accounts.oauth2.hasGrantedAllScopes(result, 'openid', DRIVE_SCOPE, CAL_SCOPE)) {
          status = 'Для синхронизации разрешите доступ к Диску и Календарю.'; api.refresh(); return;
        }
        token = result.access_token;
        expiresAt = Date.now() + Number(result.expires_in) * 1000 - 30000;
        run(async () => {
          try {
            const profile = await (await request('https://openidconnect.googleapis.com/v1/userinfo')).json();
            if (!profile.sub) { token = null; throw new Error('Не удалось определить аккаунт Google.'); }
            if (settings.account && settings.account !== profile.sub) {
              token = null; throw new Error('Выберите тот же аккаунт Google, который подключали ранее.');
            }
            settings.account = profile.sub;
            persist();
            return 'Google подключён.';
          } catch (error) {
            token = null;
            throw error;
          }
        });
      },
      error_callback:() => { connecting = false; status = 'Окно Google закрыто или заблокировано.'; api.refresh(); }
    });
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
  async function sync() {
    const records = structuredClone(api.records());
    await backup(records);
    try { await mirror(records.events); }
    catch (error) { throw new Error('Копия на Диске сохранена. Календарь: '+error.message); }
    auto = true;
    if (JSON.stringify(records) !== JSON.stringify(api.records())) schedule();
    return 'Копия сохранена. Календарь обновлён.';
  }
  function schedule() {
    clearTimeout(timer);
    if (!auto || !ready()) return;
    timer = setTimeout(() => {
      if (busy) { schedule(); return; }
      run(sync);
    },1500);
  }
  window.lichnoeGoogle = {
    init(handlers) { api = handlers; },
    schedule,
    clearRestore() { restoreFile = null; },
    restored() {
      if (!restoreFile) return;
      settings.backupId = restoreFile.id;
      settings.backupVersion = restoreFile.version;
      restoreFile = null;
      persist();
    },
    html() {
      const disabled = busy || connecting ? ' disabled' : '';
      if (!settings.clientId) return `<form data-google-config>
        <label>Идентификатор OAuth клиента<input name="clientId" required placeholder="…apps.googleusercontent.com"></label>
        <label>Номер проекта Google Cloud<input name="projectNumber" required inputmode="numeric"></label>
        <label>Ключ Google Picker<input name="apiKey" required></label>
        <button type="submit" class="action primary">Сохранить настройки</button></form><p class="record" role="status">${esc(status)}</p>`;
      return `<p class="record" role="status">${esc(status || 'Записи хранятся в браузере. Google получает резервную копию и зеркало событий.')}</p>
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
      const clientId = String(fields.get('clientId')).trim();
      const projectNumber = String(fields.get('projectNumber')).trim();
      const apiKey = String(fields.get('apiKey')).trim();
      if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId) || !/^\d+$/.test(projectNumber) || !apiKey) {
        status = 'Проверьте данные проекта Google Cloud.'; api.refresh(); return;
      }
      settings = {clientId,projectNumber,apiKey};
      persist();
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
          catch { connecting = false; status = 'Не удалось открыть окно Google.'; api.refresh(); }
        }
        else run(async () => { await prepare(); return 'Google готов. Нажмите «Подключить Google» ещё раз.'; });
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
        token = null; auto = false; client = null; clearTimeout(timer);
        if (action === 'reset') { settings = {}; persist(); }
        status = 'Google отключён.';
        api.refresh();
      }
    }
  };
})();
