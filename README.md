# Suno AI API

![suno-api banner](https://github.com/gcui-art/suno-api/blob/main/public/suno-banner.png)

[English](./README.md) | [简体中文](./README_CN.md)

Use API to call the music generation AI of Suno.ai and easily integrate it into agents like GPTs.

👉 We update quickly, please Star us.

## Introduction

Suno.ai v3 is an amazing AI music service. Although the official API is not yet available, we couldn't wait to integrate its capabilities somewhere.

We discovered that some users have similar needs, so we decided to open-source this project, hoping you'll like it.

## Demo

We have deployed an example bound to a free Suno account, so it has daily usage limits, but you can see how it runs:
[suno.gcui.art](https://suno.gcui.art)

## Features

- Perfectly implements the creation API from app.suno.ai
- Supports Custom Mode
- One-click deployment to Vercel
- In addition to the standard API, it also adapts to the API Schema of Agent platforms like GPTs and Coze, so you can use it as a tool/plugin/Action for LLMs and integrate it into any AI Agent.
- Permissive open-source license, allowing you to freely integrate and modify.

## Getting Started

### 1. Obtain the cookie of your app.suno.ai account

1. Head over to [app.suno.ai](https://app.suno.ai) using your browser.
2. Open up the browser console: hit `F12` or access the `Developer Tools`.
3. Navigate to the `Network tab`.
4. Give the page a quick refresh.
5. Identify the request that includes the keyword `client?_clerk_js_version`.
6. Click on it and switch over to the `Header` tab.
7. Locate the `Cookie` section, hover your mouse over it, and copy the value of the Cookie.

![get cookie](https://github.com/gcui-art/suno-api/blob/main/public/get-cookie-demo.gif)

### 2. Clone and deploy this project

You can choose your preferred deployment method:

#### Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fgcui-art%2Fsuno-api&env=SUNO_COOKIE&project-name=suno-api&repository-name=suno-api)

#### Run locally

```bash
git clone https://github.com/gcui-art/suno-api.git
cd suno-api
npm install
```

Alternatively, you can use [Docker Compose](https://docs.docker.com/compose/)

```bash
docker compose build && docker compose up
```

### 3. Configure suno-api

- If deployed to Vercel, please add an environment variable `SUNO_COOKIE` in the Vercel dashboard, with the value of the cookie obtained in the first step.

- If you’re running this locally, be sure to add the following to your `.env` file:

```bash
SUNO_COOKIE=<your-cookie>
```

### 4. Run suno api

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

### 5. Use Suno API

You can check out the detailed API documentation at :
[suno.gcui.art/docs](https://suno.gcui.art/docs)

## API Reference

Suno API currently mainly implements the following APIs:

```bash
- `/api/generate`: Generate music
- `/api/custom_generate`: Generate music (Custom Mode, support setting lyrics, music style, title, etc.)
- `/api/get`: Get music Info
- `/api/get_limit`: Get quota Info
```

For more detailed documentation, please check out the demo site:
[suno.gcui.art/docs](https://suno.gcui.art/docs)

## Integration with Custom Agents

You can integrate Suno AI as a tool/plugin/action into your AI agent.

### Integration with GPTs

[coming soon...]

### Integration with Coze

[coming soon...]

### Integration with LangChain

[coming soon...]

## Contribution Guidelines

Fork the project and submit a pull request.

## License

LGPL-3.0 or later

## Contact Us

- Contact us: <support@gcui.art>

## Related Links

- Project repository: [github.com/gcui-art/suno-api](https://github.com/gcui-art/suno-api)
- Suno.ai official website: [suno.ai](https://suno.ai)
- Demo: [suno.gcui.art](https://suno.gcui.art)

## Statement

suno-api is an unofficial open source project, intended for learning and research purposes only.
