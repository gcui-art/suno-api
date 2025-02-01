/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    config.module.rules.push({
      test: /\.(ttf|html)$/i,
      type: 'asset/resource'
    });
    return config;
  },
  experimental: {
    serverComponentsExternalPackages: ['@sparticuz/chromium'],
    serverMinification: false // the server minification unfortunately breaks the selector class names
  }
};

export default nextConfig;
