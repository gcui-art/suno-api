<div align="center">
  <h1 align="center"">
      Suno AI API
  </h1>
  <p>Используйте API для генерации музыки через Suno.ai и с лёгкостью интегрируйте его в агенты, такие как GPT.</p>
  <p>👉 Мы обновляемся быстро, пожалуйста, поставьте звёздочку.</p>
</div>
<p align="center">
  <a target="_blank" href="./README.md">English</a> 
  | <a target="_blank" href="./README_CN.md">简体中文</a>
  | <a target="_blank" href="./README_RU.md">русский</a> 
  | <a target="_blank" href="https://suno.gcui.ai">Демо</a> 
  | <a target="_blank" href="https://suno.gcui.ai/docs">Документация</a> 
  | <a target="_blank" href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fgcui-art%2Fsuno-api&env=SUNO_COOKIE,TWOCAPTCHA_KEY,BROWSER,BROWSER_GHOST_CURSOR,BROWSER_LOCALE,BROWSER_HEADLESS&project-name=suno-api&repository-name=suno-api">Развёртывание на Vercel</a> 
</p>
<p align="center">
  <a href="https://www.producthunt.com/products/gcui-art-suno-api-open-source-sunoai-api/reviews?utm_source=badge-product_review&utm_medium=badge&utm_souce=badge-gcui&#0045;art&#0045;suno&#0045;api&#0045;open&#0045;source&#0045;sunoai&#0045;api" target="_blank"><img src="https://api.producthunt.com/widgets/embed-image/v1/product_review.svg?product_id=577408&theme=light" alt="gcui&#0045;art&#0047;suno&#0045;api&#0058;Open&#0045;source&#0032;SunoAI&#0032;API - Use&#0032;API&#0032;to&#0032;call&#0032;the&#0032;music&#0032;generation&#0032;AI&#0032;of&#0032;suno&#0046;ai&#0046; | Product Hunt" style="width: 250px; height: 54px;" width="250" height="54" /></a>
</p>

> 🔥 Check out my new project: [Linkly-ai-cli: A document search engine CLI, built for AI Agents.](https://github.com/LinklyAI/linkly-ai-cli)

![Баннер suno-api](https://github.com/gcui-art/suno-api/blob/main/public/suno-banner.png)

## Вступление

Suno — потрясающий сервис для ИИ-музыки. Несмотря на отстутствие официального API, мы не могли дождаться, чтобы интегрировать его возможности где-нибудь.

Мы узнали, что у других пользователей есть схожие потребности, поэтому решили выложить этот проект в открытый доступ, надеясь, что он вам понравится.

Данная реализация использует платный сервис [2Captcha](https://2captcha.com/about) (a.k.a. ruCaptcha) для автоматического решения капч hCaptcha и не использует какие-либо готовые реализации API Suno с закрытым исходным кодом.

## Демо

Мы опубликовали пример, привязанный к бесплатному аккаунту, так что имеются дневные лимиты, но вы всё равно можете посмотреть, как оно работает:
[suno.gcui.ai](https://suno.gcui.ai)

## Функции

- Идеально реализует API suno.ai.
- Автоматическое поддержание сессии аккаунта.
- Автоматическое решение капч через [ruCaptcha](https://rucaptcha.com/about) и [Playwright](https://playwright.dev) с патчами [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches).
- Совместим с форматом API OpenAI `/v1/chat/completions`.
- Поддержка пользовательского текста песни.
- Развёртывание в один клик через [Vercel](#развёртывание-на-vercel) и [Docker](#docker).
- В дополнение к стандартному API, он также адаптируется к схеме API агентских платформ, таких как GPT и Coze, поэтому вы можете использовать его как инструмент/плагин/действие для LLM и интегрировать его в любой AI-агент.
- Разрешительная лицензия с открытым исходным кодом, позволяющая свободно интегрировать и модифицировать.

## Начало работы

### 1. Получите куки вашего аккаунта Suno

1. Зайдите на [suno.com/create](https://suno.com/create).
2. Откройте консоль браузера: нажмите `F12` или откройте инструменты разработчика.
3. Перейдите на вкладку `Сеть` (`Network`).
4. Перезагрузите страницу.
5. Найдите запрос, адрес которого содержит `client?__clerk_api_version`.
6. Нажмите на него и перейдите на вкладку `Заголовки` (`Header`).
7. Найдите заголовок `Cookie`, нажмите ПКМ по нему и скопируйте его значение.

![Видеоинструкция о том, как получить куки](https://github.com/gcui-art/suno-api/blob/main/public/get-cookie-demo.gif)

### 2. Зарегистрируйтесь на 2Captcha и пополните баланс
[2Captcha](https://2captcha.com/ru/about) — это платный сервис для решения капч, использующий реальных работников для этого и обладающий высокой точностью. Он необходим из-за того, что Suno постоянно запрашивает решение hCaptcha, что невозможно за бесплатно каким-либо автоматическим способом.

[Создайте](https://2captcha.com/ru/auth/register?userType=customer) новый аккаунт, [пополните](https://2captcha.com/ru/pay) баланс и [получите свой API-ключ](https://2captcha.com/ru/enterpage#recognition).

> [!NOTE]
> Если вы находитесь в России или Беларуси, используйте интерфейс [ruCaptcha](https://rucaptcha.com) вместо 2Captcha. Это абсолютно тот же сервис, но данный интерфейс поддерживает платежи из этих стран.

> [!TIP]
> Если вы хотите получать как можно меньше капч, рекомендуется использовать macOS. Системы на macOS обычно получают меньше капч, чем Linux и Windows — это связано с их непопулярностью в сфере веб-скрейпинга. Запуск suno-api на Windows и Linux будет работать, но в некоторых случаях вы можете получить довольно большое количество капч.

### 3. Скачайте и запустите проект

Вы можете выбрать свой предпочитаемый способ запуска:

#### Развёртывание на Vercel

[![Развёртывание на Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fgcui-art%2Fsuno-api&env=SUNO_COOKIE,TWOCAPTCHA_KEY,BROWSER,BROWSER_GHOST_CURSOR,BROWSER_LOCALE,BROWSER_HEADLESS&project-name=suno-api&repository-name=suno-api)

#### Локально

```bash
git clone https://github.com/gcui-art/suno-api.git
cd suno-api
npm install
```
#### Docker
>[!IMPORTANT]
> Аппаратное видеоускорение браузера будет отключено в Docker. Если у вас медленный процессор, рекомендуется [развернуть локально](#локально).
Также можно использовать [Docker Compose](https://docs.docker.com/compose/), однако перед запуском выполните шаг ниже.

```bash
docker compose build && docker compose up
```

### 4. Настройте suno-api

- Если вы используете Vercel, настройте переменные среды в панели управления Vercel.

- Если вы установили suno-api локально, добавьте следующее в ваш `.env`-файл:
#### Environment variables
- `SUNO_COOKIE` — заголовок `Cookie`, который вы скопировали ещё в первом шаге.
- `TWOCAPTCHA_KEY` — ваш API-ключ 2Captcha из второго шага.
- `BROWSER` — название браузера, который будет использоваться для решения капч. Поддерживаются только `chromium` и `firefox`.
- `BROWSER_GHOST_CURSOR` — использовать ли ghost-cursor-playwright для симуляции плавных движений мышкой. Обратите внимание, что это, похоже, никак не влияет на появление капч, так что вы можете спокойно установить значение `false`. 
- `BROWSER_LOCALE` — язык браузера. Рекомендуется использовать либо `en`, либо `ru`, т. к. данные языки имеют больше всего работников на 2Captcha. [Список поддерживаемых языков](https://2captcha.com/ru/2captcha-api#language)
- `BROWSER_HEADLESS` — запускать ли браузер без отдельного окна. Скорее всего, вам надо установить значение `true`.
```bash
SUNO_COOKIE=<…>
TWOCAPTCHA_KEY=<…>
BROWSER=chromium
BROWSER_GHOST_CURSOR=false
BROWSER_LOCALE=en
BROWSER_HEADLESS=true
```

### 5. Запустите suno-api

- Если вы используете Vercel:
  - Нажмите на кнопку `Deploy` в панели Vercel и дождитесь успеха.
  - Посетите API `https://<присовенный-домен-vercel>/api/get_limit` для тестирования.
- Если вы установили проект локально:
  - Выполните `npm run dev`.
  - Посетите API `http://localhost:3000/api/get_limit` для тестирования.
- Если вернулся следующий результат:

```json
{
  "credits_left": 50,
  "period": "day",
  "monthly_limit": 50,
  "monthly_usage": 50
}
```

то программа работает корректно.

### 6. Используйте Suno API

Вы можете посмотреть документацию suno-api здесь:
[suno.gcui.ai/docs](https://suno.gcui.ai/docs)

## Справочник по API

На данный момент suno-api реализует следующие API:

```bash
- `/api/generate`: Сгенерировать музыку
- `/v1/chat/completions`: Сгенерировать музыку - Вызов API в формате OpenAI.
- `/api/custom_generate`: Сгенерировать музыку (Custom Mode, поддержка ручного текста песни, стиля музыки, названия и т. д.)
- `/api/generate_lyrics`: Сгенерировать текст песни на основе промпта
- `/api/get`: Получить информацию песни по ID. Перечисляйте несколько ID через запятую.
    Если ID не предоставлен, то отобразятся все песни.
- `/api/get_limit`: Получить лимиты на сегодня
- `/api/extend_audio`: Расширить длину песни
- `/api/generate_stems`: Создать стем-треки (отдельную звуковую и музыкальную дорожку)
- `/api/get_aligned_lyrics`: Получить список временных меток для каждого слова в тексте песни
- `/api/clip`: Получить информацию о клипе на основе идентификатора, переданного в качестве параметра запроса `id`.
- `/api/concat`: Сгенерировать всю песню из расширений
```

Вы также можете указать куки в заголовок `Cookie` вашего запроса, переопределяя дефолтные куки в переменной среды `SUNO_COOKIE`. Это удобно, например, когда вы хотите использовать несколько бесплатных аккаунтов одновременно.

Для более подробной документации посетите демо-сайт:
[suno.gcui.ai/docs](https://suno.gcui.ai/docs)

## Пример кода интеграции API

### Python

```python
import time
import requests

# замените на URL-адрес вашего suno-api
base_url = 'http://localhost:3000'


def custom_generate_audio(payload):
    url = f"{base_url}/api/custom_generate"
    response = requests.post(url, json=payload, headers={'Content-Type': 'application/json'})
    return response.json()


def extend_audio(payload):
    url = f"{base_url}/api/extend_audio"
    response = requests.post(url, json=payload, headers={'Content-Type': 'application/json'})
    return response.json()

def generate_audio_by_prompt(payload):
    url = f"{base_url}/api/generate"
    response = requests.post(url, json=payload, headers={'Content-Type': 'application/json'})
    return response.json()


def get_audio_information(audio_ids):
    url = f"{base_url}/api/get?ids={audio_ids}"
    response = requests.get(url)
    return response.json()


def get_quota_information():
    url = f"{base_url}/api/get_limit"
    response = requests.get(url)
    return response.json()

def get_clip(clip_id):
    url = f"{base_url}/api/clip?id={clip_id}"
    response = requests.get(url)
    return response.json()

def generate_whole_song(clip_id):
    payload = {"clip_id": clip_id}
    url = f"{base_url}/api/concat"
    response = requests.post(url, json=payload)
    return response.json()


if __name__ == '__main__':
    data = generate_audio_by_prompt({
        "prompt": "Популярная хэви-метал песня о войне, исполненная глубоким мужским голосом, медленно и мелодично. В тексте изображена печаль людей после войны.",
        "make_instrumental": False,
        "wait_audio": False
    })

    ids = f"{data[0]['id']},{data[1]['id']}"
    print(f"ids: {ids}")

    for _ in range(60):
        data = get_audio_information(ids)
        if data[0]["status"] == 'streaming':
            print(f"{data[0]['id']} ==> {data[0]['audio_url']}")
            print(f"{data[1]['id']} ==> {data[1]['audio_url']}")
            break
        # sleep 5s
        time.sleep(5)

```

### JavaScript

```js
const axios = require("axios");

// замените на URL-адрес вашего suno-api
const baseUrl = "http://localhost:3000";

async function customGenerateAudio(payload) {
  const url = `${baseUrl}/api/custom_generate`;
  const response = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
  });
  return response.data;
}

async function generateAudioByPrompt(payload) {
  const url = `${baseUrl}/api/generate`;
  const response = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
  });
  return response.data;
}

async function extendAudio(payload) {
  const url = `${baseUrl}/api/extend_audio`;
  const response = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
  });
  return response.data;
}

async function getAudioInformation(audioIds) {
  const url = `${baseUrl}/api/get?ids=${audioIds}`;
  const response = await axios.get(url);
  return response.data;
}

async function getQuotaInformation() {
  const url = `${baseUrl}/api/get_limit`;
  const response = await axios.get(url);
  return response.data;
}

async function getClipInformation(clipId) {
  const url = `${baseUrl}/api/clip?id=${clipId}`;
  const response = await axios.get(url);
  return response.data;
}

async function main() {
  const data = await generateAudioByPrompt({
    prompt:
      "Популярная хэви-метал песня о войне, исполненная глубоким мужским голосом, медленно и мелодично. В тексте изображена печаль людей после войны.",
    make_instrumental: false,
    wait_audio: false,
  });

  const ids = `${data[0].id},${data[1].id}`;
  console.log(`ids: ${ids}`);

  for (let i = 0; i < 60; i++) {
    const data = await getAudioInformation(ids);
    if (data[0].status === "streaming") {
      console.log(`${data[0].id} ==> ${data[0].audio_url}`);
      console.log(`${data[1].id} ==> ${data[1].audio_url}`);
      break;
    }
    // sleep 5s
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

main();
```

## Интеграция с пользовательскими агентами

Вы можете интегрировать Suno AI как инструмент/плагин/действие в ваш ИИ-агент.

### Интеграция с GPT

[скоро...]

### Интеграция с Coze

[скоро...]

### Интеграция с LangChain

[скоро...]

## Вклад в развитие

Вы можете поддержать этот проект четырьмя способами:

1. Fork и публикация pull request'ов: мы приветствуем любые PR, которые улучшают данный проект. Вы также можете помочь простым переводом этого README на ваш язык.
2. Создавайте [issue](https://github.com/gcui-art/suno-api/issues): мы ценим разумные предложения и сообщения об ошибках.
3. Пожертвование: если этот проект помог вам, угостите нас кофе, воспользовавшись кнопкой «Sponsor» в верхней части проекта. Спасибо! ☕
4. Распространяйте информацию: порекомендуйте этот проект другим, поставьте звезду в репо или добавьте обратную ссылку после использования проекта.

## Вопросы, предложения, проблемы или ошибки?

Мы используем [Issues на GitHub](https://github.com/gcui-art/suno-api/issues) для обратной связи. Не стестняйтесь создавать issue, мы оперативно решим вашу проблему.

## Лицензия

Лицензия данного проекта — LGPL-3.0 или более поздняя версия. Для большей информации см. [LICENSE](LICENSE).

## Полезные ссылки

- Репозиторий проекта: [github.com/gcui-art/suno-api](https://github.com/gcui-art/suno-api)
- Официальный сайт Suno.ai: [suno.ai](https://suno.ai)
- Демо: [suno.gcui.ai](https://suno.gcui.ai)
- [Readpo](https://readpo.com?utm_source=github&utm_medium=suno-api): ReadPo — это помощник для чтения и письма, работающий на основе искусственного интеллекта. Собирайте, курируйте и создавайте контент с молниеносной скоростью.
- Album AI: [Автоматическое создание метаданных изображения и общение с альбомом. RAG + Альбом.](https://github.com/gcui-art/album-ai)

## Заявление

suno-api — это неофициальный проект с открытым исходным кодом, предназначенный только для учебных и исследовательских целей.