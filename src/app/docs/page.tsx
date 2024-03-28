import React from 'react';
import Swagger from '../components/Swagger';
import spec from './swagger-suno-api.json'; // 直接导入JSON文件
import Section from '../components/Section';


export default function Docs() {
    return (
        <Section className="">
            <Swagger spec={spec} />
        </Section>
    );
}
