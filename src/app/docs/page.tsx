import React from 'react';
import Swagger from '../components/Swagger';
import spec from './swagger-suno-api.json'; // 直接导入JSON文件
import Section from '../components/Section';
import Markdown from 'react-markdown';


export default function Docs() {
    return (
        <>
            <Section className="my-10">
                <article className="prose lg:prose-lg max-w-3xl pt-10">
                    <h1 className=' text-center text-indigo-900'>
                        API Docs
                    </h1>
                    <Markdown>
                        {`                     
---
\`gcui-art/suno-api\` currently mainly implements the following APIs:

\`\`\`bash
- \`/api/generate\`: Generate music
- \`/v1/chat/completions\`: Generate music - Call the generate API in a format 
  that works with OpenAI’s API.
- \`/api/custom_generate\`: Generate music (Custom Mode, support setting lyrics, 
  music style, title, etc.)
- \`/api/generate_lyrics\`: Generate lyrics based on prompt
- \`/api/get\`: Get music information based on the id. Use “,” to separate multiple 
    ids.  If no IDs are provided, all music will be returned.
- \`/api/get_limit\`: Get quota Info
- \`/api/extend_audio\`: Extend audio length
- \`/api/generate_stems\`: Make stem tracks (separate audio and music track)
- \`/api/get_aligned_lyrics\`: Get list of timestamps for each word in the lyrics
- \`/api/clip\`:  Get clip information based on ID passed as query parameter \`id\`
- \`/api/concat\`: Generate the whole song from extensions
\`\`\`

Feel free to explore the detailed API parameters and conduct tests on this page.
                        `}
                    </Markdown>
                </article>
            </Section>
            <Section className="my-10">
                <article className='prose lg:prose-lg max-w-3xl py-10'>
                    <h2 className='text-center'>
                        Details of the API and testing it online
                    </h2>
                    <p className='text-red-800 italic'>
                        This is just a demo, bound to a test account. Please do not use it frequently, so that more people can test online.
                    </p>
                </article>

                <div className=' border p-4 rounded-2xl shadow-xl hover:shadow-none duration-200'>
                    <Swagger spec={spec} />
                </div>

            </Section>
        </>

    );
}
