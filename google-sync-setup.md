# Подключение Google к панели 01 «Личное»

1. В [Google Cloud Console](https://console.cloud.google.com/) создайте проект «Панели» или выберите существующий. Запишите **номер проекта** из [настроек проекта](https://console.cloud.google.com/iam-admin/settings).
2. Включите [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com), [Google Picker API](https://console.cloud.google.com/apis/library/picker.googleapis.com) и [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com).
3. В [Google Auth Platform](https://console.cloud.google.com/auth/overview) настройте название приложения и адрес поддержки. Для личного аккаунта выберите **External**. Если приложение в режиме **Testing**, добавьте свой Google-аккаунт в **Audience → Test users**. В **Data Access** добавьте `openid`, `https://www.googleapis.com/auth/drive.file` и `https://www.googleapis.com/auth/calendar.events.owned`.
4. На странице [Clients](https://console.cloud.google.com/auth/clients) создайте клиент типа **Web application**. В **Authorized JavaScript origins** внесите ровно `https://htongrad.github.io`. Поле **Authorized redirect URIs** оставьте пустым. Скопируйте **Client ID**. Client secret панели не требуется.
5. **Настройте ключ для окна выбора папки.** Откройте [Credentials](https://console.cloud.google.com/apis/credentials) и проверьте, что сверху выбран тот же проект, где создан OAuth-клиент. Если ключ уже есть, нажмите его название в разделе **API Keys**. Иначе нажмите **Create credentials → API key**, затем откройте настройки созданного ключа.
   - В **Application restrictions → Websites** добавьте два адреса: `https://htongrad.github.io/*` и `https://docs.google.com/*`.
   - В **API restrictions** выберите **Restrict key**. В списке **Select API restrictions** отметьте **Google Picker API** и **Google Drive API**. **Google Calendar API** в этом списке оставьте неотмеченным.
   - Нажмите **Save** и скопируйте значение ключа. Если нужного API нет в списке, включите [Google Picker API](https://console.cloud.google.com/apis/library/picker.googleapis.com) или [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) в этом же проекте и обновите страницу ключа. [Настройка ключа в документации Google](https://developers.google.com/workspace/drive/picker/guides/web-picker-sample).
6. **Подключите Google в панели.** Откройте [«Личное»](https://htongrad.github.io/01-lichnoe/) в Chrome и нажмите **⋯ → Синхронизация Google**.
   - В поле **Идентификатор OAuth клиента** вставьте Client ID из пункта 4. Он заканчивается на `.apps.googleusercontent.com`.
   - В поле **Номер проекта Google Cloud** вставьте числовой **Project number** из [настроек проекта](https://console.cloud.google.com/iam-admin/settings).
   - В поле **Ключ Google Picker** вставьте ключ из пункта 5. Нажмите **Сохранить настройки**.
7. **Нажмите «Синхронизировать».** В окне Google выберите свой аккаунт и разрешите доступ к Диску и Календарю. Затем выберите папку **«01 ЛИЧНОЕ»**. Панель запомнит её и продолжит отправку. Если Google отказывает во входе для приложения в режиме **Testing**, проверьте свой аккаунт в [Audience → Test users](https://console.cloud.google.com/auth/audience).

## Ежедневное использование

1. Нажмите **«Синхронизировать»** в **Обзоре**, чтобы сохранить копию записей на Диске и обновить события в основном Google Календаре. Если Google попросит войти, подтвердите вход. Отправка продолжится сама.
2. При изменении записей на Диске появляется отдельный JSON-файл с датой и временем копии. Старые файлы сохраняются. При повторной отправке тех же записей панель использует актуальную копию.
3. Пока панель открыта и доступ Google действует, сохранённые изменения также отправляются автоматически. Если сеть пропала, отправка продолжится после её возвращения. При закрытой панели отправка ждёт следующего открытия и подключения.
4. В Обзоре видно время последней успешной синхронизации или сообщение о том, какая часть отправки требует повторения.

Панель запоминает часовой пояс устройства при первом подключении Google для событий с временем. Его можно посмотреть в **⋯ → Синхронизация Google**. Копия на Диске хранит этот пояс, поэтому при переносе на новый телефон панель подхватит его перед первой синхронизацией. Блок **«Сегодня»** следует дате устройства.

## Восстановление

На новом телефоне или после очистки данных браузера снова сохраните настройки Google. Откройте **⋯ → Синхронизация Google → Восстановить последнюю копию**. При необходимости подтвердите вход и выберите папку **«01 ЛИЧНОЕ»**. Затем нажмите **«Добавить записи из копии»**. Панель добавит отсутствующие записи и сохранит местные версии совпадающих записей.

Копию также можно скачать и открыть через **⋯ → Копии данных**. Для добавления записей из файла должно хватить места в хранилище браузера.

При ручном восстановлении недоступная или повреждённая свежая копия пропускается. Панель показывает предыдущую исправную копию для подтверждения.
