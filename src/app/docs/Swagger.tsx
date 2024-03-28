'use client';
import SwaggerUI from 'swagger-ui-react';
import 'swagger-ui-react/swagger-ui.css';

type Props = {
  spec: Record<string, any>,
};

function Swagger({ spec }: Props) {
  return <SwaggerUI spec={spec}  />;
}

export default Swagger;