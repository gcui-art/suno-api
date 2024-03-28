import React from 'react';
import Swagger from './Swagger';
import spec from './swagger-suno-api.json'; // 直接导入JSON文件


export default async function Docs() {
    // const spec = await getApiDocs();
    return (
        <main className="flex min-h-screen flex-col items-center p-24 bg-white">
            
            <Swagger spec={spec} />
        </main>
    );
}
