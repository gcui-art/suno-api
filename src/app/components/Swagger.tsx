'use client';
import 'swagger-ui-react/swagger-ui.css';
import dynamic from "next/dynamic";

type Props = {
  spec: Record<string, any>,
};

const SwaggerUI = dynamic(() => import('swagger-ui-react'), { ssr: false });

function Swagger({ spec }: Props) {
  return <SwaggerUI spec={spec} requestInterceptor={(req) => {
    // Remove cookies before sending requests
    req.credentials = 'omit';
    console.log(req);
    return req;
  }} />;
}

export default Swagger;