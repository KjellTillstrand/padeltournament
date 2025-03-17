// playwright.config.js
/** @type {import('@playwright/test').PlaywrightTestConfig} */
const config = {
    timeout: 30000,
    use: {
      headless: true,
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
    },
  };
  module.exports = config;
  