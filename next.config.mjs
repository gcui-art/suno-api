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
    serverMinification: false, // the server minification unfortunately breaks the selector class names
    instrumentationHook: true, // 启用服务器启动钩子，用于初始化定时任务
    serverComponentsExternalPackages: ['sql.js'], // 不打包 sql.js，保留为 Node.js 原生模块（含 WASM）
  },
};  

export default nextConfig;
