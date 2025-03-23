// playwright.config.js
/** @type {import('@playwright/test').PlaywrightTestConfig} */
const config = {
  reporter: [['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL || 'http://kjelltillstrand.github.io/padeltournament', // fallback if not deployed
    headless: true,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  },
  timeout: 30000,
};
module.exports = config;
