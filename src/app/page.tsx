import Section from "./components/Section";
import Markdown from 'react-markdown';


export default function Home() {

  const markdown = `

---
## Introduction

Suno.ai v3 is an amazing AI music service. Although the official API is not yet available, we couldn't wait to integrate its capabilities somewhere.

We discovered that some users have similar needs, so we decided to open-source this project, hoping you'll like it.

## Features

- Perfectly implements the creation API from \`app.suno.ai\`
- Supports \`Custom Mode\`
- One-click deployment to Vercel
- In addition to the standard API, it also adapts to the API Schema of Agent platforms like GPTs and Coze, so you can use it as a tool/plugin/Action for LLMs and integrate it into any AI Agent.
- Permissive open-source license, allowing you to freely integrate and modify.

## Getting Started

### 1. Obtain the cookie of your app.suno.ai account

### 2. Clone and deploy this project

### 3. Configure suno-api

### 4. Run suno api

### 5. Create more freely

`;
  return (
    <>
      <Section className="">
        <div className="flex flex-col m-auto py-20 text-center items-center justify-center gap-4 my-8
        lg:px-20 px-4
        bg-indigo-900/90 rounded-2xl border shadow-2xl hover:shadow-none duration-200">
          <span className=" px-5 py-1 text-xs font-light border rounded-full 
          border-white/20 uppercase text-white/50">
            Unofficial
          </span>
          <h1 className="font-bold text-7xl flex text-white/90">
            Suno AI API
          </h1>
          <p className="text-white/80 text-lg">
            `Suno-api` is an open-source project that enables you to set up your own Suno AI API.
          </p>
        </div>

      </Section>
      <Section className="my-10">
        <article className="prose lg:prose-lg max-w-3xl">
          <Markdown>
            {markdown}
          </Markdown>
        </article>
      </Section>


    </>
  );
}
