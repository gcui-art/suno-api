<div align="center">
  <h1 align="center">
      Suno AI API
  </h1>
  <p>Use API to call the music generation AI of Suno.ai and easily integrate it into agents like GPTs.</p>
  <p>👉 We update quickly, please star.</p>
</div>
<p align="center">
  <a target="_blank" href="./README.md">English</a> 
  | <a target="_blank" href="./README_CN.md">简体中文</a> 
  | <a target="_blank" href="./README_RU.md">русский</a> 
  | <a target="_blank" href="https://suno.gcui.ai">Demo</a> 
  | <a target="_blank" href="https://suno.gcui.ai/docs">Docs</a> 
  | <a target="_blank" href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fgcui-art%2Fsuno-api&env=SUNO_COOKIE,TWOCAPTCHA_KEY,BROWSER,BROWSER_GHOST_CURSOR,BROWSER_LOCALE,BROWSER_HEADLESS&project-name=suno-api&repository-name=suno-api">Deploy with Vercel</a> 
</p>
<p align="center">
  <a href="https://www.producthunt.com/products/gcui-art-suno-api-open-source-sunoai-api/reviews?utm_source=badge-product_review&utm_medium=badge&utm_souce=badge-gcui&#0045;art&#0045;suno&#0045;api&#0045;open&#0045;source&#0045;sunoai&#0045;api" target="_blank"><img src="https://api.producthunt.com/widgets/embed-image/v1/product_review.svg?product_id=577408&theme=light" alt="gcui&#0045;art&#0047;suno&#0045;api&#0058;Open&#0045;source&#0032;SunoAI&#0032;API - Use&#0032;API&#0032;to&#0032;call&#0032;the&#0032;music&#0032;generation&#0032;AI&#0032;of&#0032;suno&#0046;ai&#0046; | Product Hunt" style="width: 250px; height: 54px;" width="250" height="54" /></a>
</p>

> 🔥 Check out my new project: [ReadPo - 10x Speed Up Your Reading and Writing](https://readpo.com?utm_source=github&utm_medium=suno-ai)

![suno-api banner](https://github.com/gcui-art/suno-api/blob/main/public/suno-banner.png)

## Introduction

Suno is an amazing AI music service. Although the official API is not yet available, we couldn't wait to integrate its capabilities somewhere.

We discovered that some users have similar needs, so we decided to open-source this project, hoping you'll like it.

This implementation uses the paid [2Captcha](https://2captcha.com/about) service (a.k.a. ruCaptcha) to solve the hCaptcha challenges automatically and does not use any already made closed-source paid Suno API implementations.

## Demo

We have deployed an example bound to a free Suno account, so it has daily usage limits, but you can see how it runs:
[suno.gcui.ai](https://suno.gcui.ai)

## Features

- Perfectly implements the creation API from suno.ai.
- Automatically keep the account active.
- Solve CAPTCHAs automatically using [2Captcha](https://2captcha.com) and [Playwright](https://playwright.dev) with [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches).
- Compatible with the format of OpenAI’s `/v1/chat/completions` API.
- Supports Custom Mode.
- One-click deployment to [Vercel](#deploy-to-vercel) & [Docker](#docker).
- In addition to the standard API, it also adapts to the API Schema of Agent platforms like GPTs and Coze, so you can use it as a tool/plugin/Action for LLMs and integrate it into any AI Agent.
- Permissive open-source license, allowing you to freely integrate and modify.

## Getting Started

### 1. Obtain the cookie of your Suno account

1. Head over to [suno.com/create](https://suno.com/create) using your browser.
2. Open up the browser console: hit `F12` or access the `Developer Tools`.
3. Navigate to the `Network` tab.
4. Give the page a quick refresh.
5. Identify the latest request that includes the keyword `?__clerk_api_version`.
6. Click on it and switch over to the `Header` tab.
7. Locate the `Cookie` section, hover your mouse over it, and copy the value of the Cookie.

![get cookie](https://github.com/gcui-art/suno-api/blob/main/public/get-cookie-demo.gif)

### 2. Register on 2Captcha and top up your balance
[2Captcha](https://2captcha.com/about) is a paid CAPTCHA solving service that uses real workers to solve the CAPTCHA and has high accuracy. It is needed because of Suno constantly requesting hCaptcha solving that currently isn't possible for free by any means.

[Create](https://2captcha.com/auth/register?userType=customer) a new 2Captcha account, [top up](https://2captcha.com/pay) your balance and [get your API key](https://2captcha.com/enterpage#recognition).

> [!NOTE]
> If you are located in Russia or Belarus, use the [ruCaptcha](https://rucaptcha.com) interface instead of 2Captcha. It's the same service, but it supports payments from those countries.

> [!TIP]
> If you want as few CAPTCHAs as possible, it is recommended to use a macOS system. macOS systems usually get fewer CAPTCHAs than Linux and Windows—this is due to its unpopularity in the web scraping industry. Running suno-api on Windows and Linux will work, but in some cases, you could get a pretty large number of CAPTCHAs.

### 3. Clone and deploy this project

You can choose your preferred deployment method:

#### Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fgcui-art%2Fsuno-api&env=SUNO_COOKIE,TWOCAPTCHA_KEY,BROWSER,BROWSER_GHOST_CURSOR,BROWSER_LOCALE,BROWSER_HEADLESS&project-name=suno-api&repository-name=suno-api)

#### Run locally

```bash
git clone https://github.com/gcui-art/suno-api.git
cd suno-api
npm install
```
#### Docker
>[!IMPORTANT]
> GPU acceleration will be disabled in Docker. If you have a slow CPU, it is recommended to [deploy locally](#run-locally).

Alternatively, you can use [Docker Compose](https://docs.docker.com/compose/). However, follow the step below before running.

```bash
docker compose build && docker compose up
```

### 4. Configure suno-api

- If deployed to Vercel, please add the environment variables in the Vercel dashboard.

- If you’re running this locally, be sure to add the following to your `.env` file:
#### Environment variables
- `SUNO_COOKIE` — the `Cookie` header you obtained in the first step.
- `TWOCAPTCHA_KEY` — your 2Captcha API key from the second step.
- `BROWSER` — the name of the browser that is going to be used to solve the CAPTCHA. Only `chromium` and `firefox` supported.
- `BROWSER_GHOST_CURSOR` — use ghost-cursor-playwright to simulate smooth mouse movements. Please note that it doesn't seem to make any difference in the rate of CAPTCHAs, so you can set it to `false`. Retained for future testing.
- `BROWSER_LOCALE` — the language of the browser. Using either `en` or `ru` is recommended, since those have the most workers on 2Captcha. [List of supported languages](https://2captcha.com/2captcha-api#language)
- `BROWSER_HEADLESS` — run the browser without the window. You probably want to set this to `true`.
```bash
SUNO_COOKIE=<…>
TWOCAPTCHA_KEY=<…>
BROWSER=chromium
BROWSER_GHOST_CURSOR=false
BROWSER_LOCALE=en
BROWSER_HEADLESS=true
```

### 5. Run suno-api

- If you’ve deployed to Vercel:
  - Please click on Deploy in the Vercel dashboard and wait for the deployment to be successful.
  - Visit the `https://<vercel-assigned-domain>/api/get_limit` API for testing.
- If running locally:
  - Run `npm run dev`.
  - Visit the `http://localhost:3000/api/get_limit` API for testing.
- If the following result is returned:

```json
{
  "credits_left": 50,
  "period": "day",
  "monthly_limit": 50,
  "monthly_usage": 50
}
```

it means the program is running normally.

### 6. Use Suno API

You can check out the detailed API documentation at :
[suno.gcui.ai/docs](https://suno.gcui.ai/docs)

## API Reference

Suno API currently mainly implements the following APIs:

```bash
- `/api/generate`: Generate music
- `/v1/chat/completions`: Generate music - Call the generate API in a format that works with OpenAI’s API.
- `/api/custom_generate`: Generate music (Custom Mode, support setting lyrics, music style, title, etc.)
- `/api/generate_lyrics`: Generate lyrics based on prompt
- `/api/get`: Get music information based on the id. Use “,” to separate multiple ids.
    If no IDs are provided, all music will be returned.
- `/api/get_limit`: Get quota Info
- `/api/extend_audio`: Extend audio length
- `/api/generate_stems`: Make stem tracks (separate audio and music track)
- `/api/get_aligned_lyrics`: Get list of timestamps for each word in the lyrics
- `/api/clip`: Get clip information based on ID passed as query parameter `id`
- `/api/concat`: Generate the whole song from extensions
```

You can also specify the cookies in the `Cookie` header of your request, overriding the default cookies in the `SUNO_COOKIE` environment variable. This comes in handy when, for example, you want to use multiple free accounts at the same time.

For more detailed documentation, please check out the demo site:
[suno.gcui.ai/docs](https://suno.gcui.ai/docs)

## API Integration Code Examples

### Python

```python
import time
import requests

# replace with your suno-api URL
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
        "prompt": "A popular heavy metal song about war, sung by a deep-voiced male singer, slowly and melodiously. The lyrics depict the sorrow of people after the war.",
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

// replace your vercel domain
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
      "A popular heavy metal song about war, sung by a deep-voiced male singer, slowly and melodiously. The lyrics depict the sorrow of people after the war.",
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

## Integration with Custom Agents

You can integrate Suno AI as a tool/plugin/action into your AI agent.

### Integration with GPTs

[coming soon...]

### Integration with Coze

[coming soon...]

### Integration with LangChain

[coming soon...]

## Contributing

There are four ways you can support this project:

1. Fork and Submit Pull Requests: We welcome any PRs that enhance the functionality, APIs, response time and availability. You can also help us just by translating this README into your language—any help for this project is welcome!
2. Open Issues: We appreciate reasonable suggestions and bug reports.
3. Donate: If this project has helped you, consider buying us a coffee using the Sponsor button at the top of the project. Cheers! ☕
4. Spread the Word: Recommend this project to others, star the repo, or add a backlink after using the project.

## Questions, Suggestions, Issues, or Bugs?

We use [GitHub Issues](https://github.com/gcui-art/suno-api/issues) to manage feedback. Feel free to open an issue, and we'll address it promptly.

## License

The license of this project is LGPL-3.0 or later. See [LICENSE](LICENSE) for more information.

## Related Links

- Project repository: [github.com/gcui-art/suno-api](https://github.com/gcui-art/suno-api)
- Suno.ai official website: [suno.ai](https://suno.ai)
- Demo: [suno.gcui.ai](https://suno.gcui.ai)
- [Readpo](https://readpo.com?utm_source=github&utm_medium=suno-api): ReadPo is an AI-powered reading and writing assistant. Collect, curate, and create content at lightning speed.
- Album AI: [Auto generate image metadata and chat with the album. RAG + Album.](https://github.com/gcui-art/album-ai)

## Statement

suno-api is an unofficial open source project, intended for learning and research purposes only.
