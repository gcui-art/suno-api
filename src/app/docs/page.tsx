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
Suno API currently mainly implements the following APIs:

\`\`\`bash
- \`/api/generate\`: Generate music
- \`/api/custom_generate\`: Generate music (Custom Mode, support setting lyrics, 
    music style, title, etc.)
- \`/api/get\`: Get music Info
- \`/api/get_limit\`: Get quota Info
\`\`\`
Feel free to explore the detailed API parameters and conduct tests on this page. 

> Please note: 
> 
> we have bound a free account with a daily usage limit. 
> You can deploy and bind your own account to complete the testing.
                        `}
                    </Markdown>
                </article>
            </Section>
            <Section className="my-10">
                <div className=' border p-4 rounded-2xl shadow-xl hover:shadow-none duration-200'>
                    <Swagger spec={spec} />
                </div>

            </Section>
        </>

    );
}
