(() => {
  const DRIVE = 'https://www.googleapis.com/drive/v3/';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned';
  const TAG = 'lichnoe01';
  const stateKey = 'lichnoe:google:v1';
  const backupFolder = '01 ЛИЧНОЕ';
  const backupFields = 'id,parents,trashed,appProperties';
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
  let settings = readSettings();
  function readSettings() {
    try { return JSON.parse(localStorage.getItem(stateKey)) || {}; }
    catch { return {}; }
  }
  function currentSettings() {
    const current = readSettings();
    if (['clientId','account','folder'].some(key => current[key] !== settings[key])) {
      throw new Error('Настройки Google изменились в другой вкладке. Обновите панель.');
    }
    return current;
  }
  function writeSettings(next) {
    localStorage.setItem(stateKey, JSON.stringify(next));
    settings = next;
  }
  function update(patch) {
    writeSettings({...currentSettings(),...patch});
  }
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ready = () => Boolean(token && Date.now() < expiresAt);
  let api;
  let restoreTimeZone;
  let afterConnect;
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
      const error = new Error('Google ' + response.status + (body?.error?.message ? ': ' + body.error.message : ''));
      error.status = response.status;
      error.reason = body?.error?.errors?.[0]?.reason;
      throw error;
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
        const action = afterConnect;
        afterConnect = undefined;
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
            const current = currentSettings();
            update({account:profile.sub,timeZone:current.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'});
          } catch (error) {
            token = null;
            throw error;
          }
          return perform(action);
        });
      },
      error_callback:() => {
        afterConnect = undefined;
        connecting = false;
        failed = true;
        status = 'Окно Google закрыто или заблокировано.';
        api.refresh();
      }
    });
  }
  function warmUp() {
    if (settings.clientId && !client && !preparation && navigator.onLine) {
      preparation = prepare(settings.clientId).catch(error => {
        failed = true;
        status = error.message;
      }).finally(() => { preparation = null; api.refresh(); });
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
        .setTitle('Выберите папку «' + backupFolder + '»').setCallback(result => {
          if (result.action === google.picker.Action.PICKED) resolve(result.docs?.[0]);
          if (result.action === google.picker.Action.CANCEL) resolve(null);
          if (result.action === google.picker.Action.ERROR) reject(new Error('Google Picker не открыл папку.'));
        }).build().setVisible(true);
    });
    if (!folder) return false;
    if (folder.name?.trim() !== backupFolder || !/^[\w-]+$/.test(folder.id ?? '')) {
      throw new Error('Выберите папку с названием «' + backupFolder + '».');
    }
    if (settings.folder !== folder.id) {
      update({folder:folder.id,autoSync:false,pending:true,lastSync:undefined,backupId:undefined,
        backupVersion:undefined,creatingBackupId:undefined,lastBackup:undefined,upload:undefined});
    }
    return true;
  }
  async function findUsableBackup(validate) {
    if (!settings.folder || !/^[\w-]+$/.test(settings.folder)) throw new Error('Выберите папку «01 ЛИЧНОЕ».');
    const query = {
      q:"trashed = false and '" + settings.folder + "' in parents and appProperties has { key='panelBackup' and value='" + TAG + "' }",
      fields:'nextPageToken,files(id)',orderBy:'createdTime desc'
    };
    let skipped = false;
    do {
      const page = await (await request(DRIVE+'files'+calendarParams(query), {cache:'no-store'})).json();
      for (const file of page.files || []) {
        let response;
        try {
          response = await request(DRIVE+'files/'+encodeURIComponent(file.id)+'?alt=media', {cache:'no-store'});
        } catch (error) {
          if (error.status !== 404 && error.status !== 410 &&
              !(error.status === 403 && error.reason === 'insufficientFilePermissions')) throw error;
          skipped = true;
          continue;
        }
        const raw = await response.text();
        try {
          const copy = JSON.parse(raw);
          validate(copy, skipped);
          return {copy, skipped};
        } catch {
          skipped = true;
        }
      }
      query.pageToken = page.nextPageToken;
    } while (query.pageToken);
    throw new Error(skipped ? 'В папке нет доступной исправной копии. Можно выбрать скачанный файл вручную.' :
      'В этой папке пока нет резервной копии.');
  }
  async function isSavedSnapshot({id,hash}) {
    const response = await request(DRIVE+'files/'+encodeURIComponent(id)+'?fields='+backupFields, {}, [404]);
    if (response.status === 404) return false;
    const file = await response.json();
    return !file.trashed && file.parents?.includes(settings.folder) &&
      file.appProperties?.panelBackup === TAG && file.appProperties.snapshotHash === hash;
  }
  async function uploadSnapshot(metadata, contents) {
    const blob = new Blob([contents], {type:'application/json'});
    if (blob.size > 5_000_000) {
      const init = json('POST', metadata);
      init.headers['X-Upload-Content-Type'] = blob.type;
      init.headers['X-Upload-Content-Length'] = String(blob.size);
      const session = await request(UPLOAD+'?uploadType=resumable&fields=id', init, [409]);
      if (session.status === 409) return session;
      const location = session.headers.get('Location');
      if (!location || new URL(location).origin !== new URL(UPLOAD).origin) {
        throw new Error('Google не вернул адрес загрузки копии.');
      }
      return request(location, {method:'PUT',headers:{'Content-Type':blob.type},body:blob}, [409]);
    }
    const boundary = 'lichnoe_' + crypto.randomUUID();
    const body = '--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(metadata)
      +'\r\n--'+boundary+'\r\nContent-Type: application/json\r\n\r\n'+contents+'\r\n--'+boundary+'--';
    return request(UPLOAD+'?uploadType=multipart&fields=id',
      {method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body}, [409]);
  }
  async function backup(records) {
    if (!settings.folder || !/^[\w-]+$/.test(settings.folder)) throw new Error('Выберите рабочую папку «01 ЛИЧНОЕ».');
    const snapshot = {timeZone:settings.timeZone,data:records};
    const hash = await fingerprint(snapshot);
    if (settings.lastBackup?.hash === hash && await isSavedSnapshot(settings.lastBackup)) {
      return 'Копия на Диске актуальна.';
    }
    if (settings.upload?.hash !== hash) {
      const ids = await (await request(DRIVE+'files/generateIds?count=1&space=drive')).json();
      if (!ids.ids?.[0]) throw new Error('Google не выдал идентификатор для копии.');
      update({upload:{id:ids.ids[0],hash,exportedAt:new Date().toISOString()}});
    }
    const {id,exportedAt} = settings.upload;
    const date = exportedAt.slice(0, 19).replace('T',' ').replaceAll(':','-');
    const name = 'Личное — ' + date + ' UTC.json';
    const contents = JSON.stringify({format:'01-lichnoe-backup',version:2,exportedAt,...snapshot});
    const metadata = {id,name,parents:[settings.folder],mimeType:'application/json',appProperties:{panelBackup:TAG,snapshotHash:hash}};
    const saved = await uploadSnapshot(metadata, contents);
    if (saved.status === 409) {
      if (!await isSavedSnapshot({id,hash})) {
        update({upload:undefined});
        throw new Error('Google не подтвердил копию. Нажмите «Синхронизировать» ещё раз.');
      }
    } else if ((await saved.json()).id !== id) {
      throw new Error('Google не подтвердил идентификатор сохранённой копии.');
    }
    update({lastBackup:{id,hash},upload:undefined});
    return 'Копия сохранена на Диске.';
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
    const zone = settings.timeZone;
    const desired = calendarRows(events,zone);
    const remote = (await list(CAL, {privateExtendedProperty:'panel='+TAG,maxResults:'2500'},'items'))
      .filter(event => event.extendedProperties?.private?.panel === TAG);
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
      update({mirrored:[...known]});
    }
    for (const event of remote) {
      const key = event.extendedProperties?.private?.key;
      if (known.has(key) && !desired.has(key)) {
        await request(CAL+'/'+encodeURIComponent(event.id),{method:'DELETE'},[404,410]);
        known.delete(key);
      }
    }
    update({mirrored:[...known].filter(key => desired.has(key))});
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
    clearTimeout(timer);
    settings = currentSettings();
    const records = structuredClone(api.records());
    if (!api.hasLocalRecords()) {
      update({autoSync:true,pending:false});
      return 'В панели пока нет записей для отправки.';
    }
    const change = settings.change;
    update({pending:true,autoSync:true});
    let driveStatus;
    let calendarStatus;
    let hasError = false;
    try {
      driveStatus = await backup(records);
    } catch (error) {
      hasError = true;
      retryOnOnline = !navigator.onLine || error instanceof TypeError;
      driveStatus = 'Диск: ' + error.message;
    }
    try {
      await mirror(records.events);
      calendarStatus = 'Календарь обновлён.';
    } catch (error) {
      hasError = true;
      retryOnOnline ||= !navigator.onLine || error instanceof TypeError;
      calendarStatus = 'Календарь: ' + error.message;
    }
    const result = [driveStatus,calendarStatus]
      .map(message => /[.!?]$/.test(message) ? message : message + '.').join(' ');
    const changedWhileSyncing = change !== currentSettings().change;
    if (!hasError) update({lastSync:new Date().toISOString(),pending:changedWhileSyncing});
    if (changedWhileSyncing) schedule();
    if (hasError) throw new Error(result);
    return result;
  }
  function schedule() {
    clearTimeout(timer);
    if (!autoEnabled() || !ready()) return;
    timer = setTimeout(() => {
      if (busy) { schedule(); return; }
      run(sync);
    },5000);
  }
  function restoreNotice(skipped) {
    return skipped ? 'Свежая копия недоступна или повреждена. Открыта предыдущая исправная копия.' : '';
  }
  async function restoreLatest() {
    const check = api.validateBackup;
    const {copy,skipped} = await findUsableBackup(check ?? ((candidate, skipped) => api.offerRestore(candidate, restoreNotice(skipped))));
    if (check) api.offerRestore(copy, restoreNotice(skipped));
    restoreTimeZone = undefined;
    if (typeof copy.timeZone === 'string') {
      try { restoreTimeZone = new Intl.DateTimeFormat('ru', {timeZone:copy.timeZone}).resolvedOptions().timeZone; }
      catch { /* A legacy copy can be restored without timezone metadata. */ }
    }
    return 'Копия загружена. Подтвердите добавление записей.';
  }
  async function perform(action) {
    settings = currentSettings();
    if (action === 'folder') return await pickFolder() ? 'Папка сохранена.' : 'Выбор папки отменён.';
    if (!settings.folder && !await pickFolder()) return 'Выбор папки отменён.';
    return action === 'restore' ? restoreLatest() : sync();
  }
  function syncButton() {
    if (!settings.clientId) return '<button type="button" class="action" data-action="google">Настроить синхронизацию</button>';
    const waiting = busy || connecting || Boolean(preparation);
    return '<button type="button" class="action" data-google="sync"' + (waiting ? ' disabled' : '') +
      '>Синхронизировать</button>';
  }
  window.lichnoeGoogle = {
    init(handlers) {
      api = handlers;
      warmUp();
      document.addEventListener('visibilitychange', () => { if (!document.hidden) api.refresh(); });
      window.addEventListener('offline', () => api.refresh());
      window.addEventListener('online', () => {
        if ((settings.pending && autoEnabled() || retryOnOnline) && ready()) {
          if (busy) schedule();
          else run(() => perform('sync'));
        } else warmUp();
        api.refresh();
      });
    },
    open() { warmUp(); },
    changed() {
      if (!settings.clientId) return;
      try { update({change:crypto.randomUUID(),pending:true}); }
      catch { failed = true; status = 'Браузер не сохранил статус синхронизации.'; api.refresh(); return; }
      if (autoEnabled()) warmUp();
      schedule();
      api.refresh();
    },
    overview() {
      let message = settings.lastSync ? 'Последняя синхронизация: ' +
        new Intl.DateTimeFormat('ru', {dateStyle:'short', timeStyle:'short'}).format(new Date(settings.lastSync)) + '.' : '';
      if (busy || connecting) message = 'Подключение или синхронизация…';
      else if (!navigator.onLine && settings.clientId) message = 'Панель ждёт интернет.';
      else if (failed || (!settings.lastSync && status)) message = status;
      else if (settings.pending) message = 'Есть изменения для отправки.';
      return (message ? '<p>' + esc(message) + '</p>' : '') + syncButton();
    },
    clearRestore() { restoreTimeZone = undefined; },
    restored() {
      const timeZone = restoreTimeZone;
      restoreTimeZone = undefined;
      if (!settings.lastSync && timeZone) update({timeZone});
    },
    html() {
      const disabled = busy || connecting || preparation ? ' disabled' : '';
      if (!settings.clientId) return `<form data-google-config>
        <label>Идентификатор OAuth клиента<input name="clientId" required autocapitalize="none" spellcheck="false" placeholder="…apps.googleusercontent.com"></label>
        <label>Номер проекта Google Cloud<input name="projectNumber" required inputmode="numeric"></label>
        <label>Ключ Google Picker<input name="apiKey" required autocapitalize="none" spellcheck="false"></label>
        <button type="submit" class="action primary">Сохранить настройки</button><p role="alert" data-google-validation></p></form><p class="record" role="status">${esc(status)}</p>`;
      return `<p class="record" role="status">${esc(status || 'Записи хранятся в браузере. Google получает резервную копию и зеркало событий.')}</p>
      ${settings.timeZone ? '<p><small>Часовой пояс событий в Google: ' + esc(settings.timeZone) + '</small></p>' : ''}
      <div class="controls">${syncButton()}</div>
      <div class="controls">
        <button type="button" class="action" data-google="restore"${disabled}>Восстановить последнюю копию</button>
        ${settings.folder ? `<button type="button" data-google="folder"${disabled}>Изменить папку</button>` : ''}
        ${ready() ? `<button type="button" data-google="disconnect"${disabled}>Отключить Google</button>` : ''}
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
      const next = {clientId,projectNumber,apiKey,timeZone:settings.timeZone};
      try { currentSettings(); writeSettings(next); }
      catch {
        form.querySelector('[data-google-validation]').textContent = 'Браузер не сохранил настройки. Откройте панель в обычной вкладке Chrome.';
        return;
      }
      warmUp();
      status = 'Настройки сохранены.';
      api.refresh();
    },
    action(action) {
      if (busy || connecting || preparation) return;
      if (['sync','restore','folder'].includes(action)) {
        if (!navigator.onLine) {
          if (action === 'sync' && ready()) retryOnOnline = true;
          failed = true;
          status = 'Подключитесь к интернету.';
          api.refresh();
          return;
        }
        if (ready()) { run(() => perform(action)); return; }
        if (client) {
          afterConnect = action;
          connecting = true;
          failed = false;
          api.refresh();
          try { client.requestAccessToken({prompt:''}); }
          catch {
            afterConnect = undefined;
            connecting = false;
            failed = true;
            status = 'Не удалось открыть окно Google.';
            api.refresh();
          }
        } else {
          failed = false;
          warmUp();
          api.refresh();
        }
      } else if (action === 'disconnect' || action === 'reset') {
        token = null; client = null; clearTimeout(timer);
        retryOnOnline = false;
        failed = false;
        clearTimeout(expirationTimer);
        status = 'Google отключён.';
        if (action === 'reset') {
          run(async () => {
            currentSettings();
            writeSettings({timeZone:settings.timeZone});
            return 'Настройте подключение Google.';
          });
        } else {
          warmUp();
          api.refresh();
        }
      }
    }
  };
})();
