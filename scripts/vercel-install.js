const { execSync } = require('child_process');

if (process.env.VERCEL) {
  console.log('Installing Vercel-specific dependencies...');
  execSync('pnpm install @sparticuz/chromium-min', { stdio: 'inherit' });
} else {
  console.log('Not running on Vercel, skipping additional installs.');
}
