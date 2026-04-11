# Настройка suno-api для проекта Подари Трек

Этот файл описывает **нашу конкретную** настройку suno-api. Общая документация — в README.md репозитория.

---

## Переменные окружения (.env)

```env
# ─── Обязательные ────────────────────────────────────────────────────────────

# Полная cookie-строка из браузера на suno.com
# DevTools → Application → Cookies → suno.com → выделить все → скопировать как строку
SUNO_COOKIE=singular_device_id=...

# Антибот-токен Cloudflare (ротируемый, протухает через несколько часов)
# Как получить — см. раздел ниже
SUNO_PASSKEY_TOKEN=P1_eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...

# UUID тира пользователя — берётся из декодированного __session cookie (поле claims/user_id)
# Или из URL профиля suno.com
SUNO_USER_TIER=3eaebef3-ef46-446a-931c-3d50cd1514f1

# UUID сессии создания — из cookie __session
SUNO_CREATE_SESSION_TOKEN=e6ccdfd5-8aa0-476d-89cc-f7d09e0a7ab4

# ─── Браузер (для headless-режима) ───────────────────────────────────────────
BROWSER=chromium
BROWSER_HEADLESS=true
BROWSER_GHOST_CURSOR=false
BROWSER_LOCALE=en

# ─── 2Captcha (оставить пустым если не используешь) ──────────────────────────
TWOCAPTCHA_KEY=
```

---

## Как получить SUNO_PASSKEY_TOKEN

Это самый частая проблема — токен ротируется и протухает.

**Симптом протухшего токена:** генерация возвращает HTTP 422.

**Способ получения:**

1. Открой Chrome с залогиненным аккаунтом suno.com
2. Перейди на `https://suno.com/create`
3. Открой DevTools (F12) → вкладка **Console**
4. В поле описания напиши любой текст и нажми **Create**
5. В консоли найди строку вида:
   ```
   captcha verified P1_eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.haJwZAC...
   ```
6. Скопируй всё начиная с `P1_` (токен очень длинный — несколько КБ)
7. Вставь в `.env`:
   ```env
   SUNO_PASSKEY_TOKEN=P1_eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...
   ```

**После обновления токена — ОБЯЗАТЕЛЬНО пересобрать:**

```bash
npm run build
# И перезапустить сервис
sudo systemctl restart suno-api
# или вручную:
npm start
```

> **Почему нужна пересборка?** suno-api — это Next.js. Переменные окружения встраиваются в сборку. `npm start` запускает **предыдущий** билд. Без `npm run build` старый токен останется в сборке.

---

## Как получить SUNO_COOKIE

1. Зайди на `https://suno.com` через Chrome
2. Авторизуйся под нужным аккаунтом
3. DevTools → Application → Storage → Cookies → https://www.suno.com
4. Нажми правой кнопкой на любой cookie → "Copy all"
5. Вставь в `.env` как одну строку (без переносов)

Cookie содержит Clerk JWT (`__session`, `__session_*`) — он истекает примерно через месяц. Когда истечёт — `/api/get_limit` начнёт возвращать 401/403.

---

## Эндпоинты (используются ботом)

| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/api/generate` | Запустить генерацию по описанию (description mode) |
| `GET` | `/api/get?ids=id1,id2` | Получить статус/результат клипов |
| `GET` | `/api/get_limit` | Остаток кредитов |

### Пример запуска генерации

```bash
curl -X POST http://localhost:3000/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Создай душевную песню на русском. Повод: День рождения. Жанр: поп.",
    "make_instrumental": false,
    "wait_audio": false
  }'
```

Ответ — массив из 2 объектов с `id` и `status: "submitted"`.

### Polling статуса

```bash
curl "http://localhost:3000/api/get?ids=UUID1,UUID2"
```

Статусы: `submitted` → `queued` → `streaming` → `complete` (или `error`).  
`complete` + непустой `audio_url` = трек готов.

---

## Запуск на Linux

```bash
# Установка зависимостей
npm install

# Сборка (обязательно перед каждым запуском npm start)
npm run build

# Запуск
npm start
```

### Через systemd

```ini
# /etc/systemd/system/suno-api.service
[Unit]
Description=SUNO API Proxy
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/suno-api
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=10
EnvironmentFile=/home/ubuntu/suno-api/.env
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable suno-api
sudo systemctl start suno-api
journalctl -u suno-api -f   # логи в реальном времени
```

---

## Проверка работоспособности

```bash
# Должен вернуть JSON с credits_left
curl http://localhost:3000/api/get_limit

# Пример успешного ответа:
# {"credits_left":1532,"period":"month","monthly_limit":2500,"monthly_usage":963}
```

Если `credits_left` есть → сервис работает нормально.

---

## Частые проблемы

**`BUILD_ID` not found при старте:**
```
Error: ENOENT: no such file or directory, open '.next/BUILD_ID'
```
→ Не была выполнена сборка. Запусти `npm run build` перед `npm start`.

**HTTP 422 при генерации:**
→ Протух `SUNO_PASSKEY_TOKEN`. Обнови по инструкции выше и пересобери.

**HTTP 401/403 при любых запросах:**
→ Истекли cookie. Обнови `SUNO_COOKIE` из браузера.

**Сервис отвечает, но генерация виснет навсегда:**
→ Проверь логи: `journalctl -u suno-api -n 100`. Если цикл `Get audio status` без конца — SUNO перегружен, жди или попробуй позже.
