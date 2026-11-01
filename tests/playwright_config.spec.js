const { test, expect } = require('@playwright/test');
const { spawnSync } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

// playwright.config.js reads the test server port from PW_PORT (AB#144). Local
// test tooling, no product requirement, so these titles carry no R- tag.
// Node-only (no page): listed in NODE_ONLY_SPECS so it runs once, in the "unit"
// project.
//
// The config reads process.env when it is loaded, so every case loads it in a
// fresh child node process with a minimal, controlled environment. The runner's
// own process.env is never touched, and an inherited CI, PW_PORT or
// NODE_OPTIONS cannot leak into a case.

const CONFIG_PATH = path.join(__dirname, '..', 'playwright.config.js');

// Print the settings under test as one JSON line on stdout.
const LOADER = `
const { default: config } = await import(${JSON.stringify(pathToFileURL(CONFIG_PATH).href)});
process.stdout.write(JSON.stringify({
  command: config.webServer.command,
  serverUrl: config.webServer.url,
  baseURL: config.use.baseURL,
  reuseExistingServer: config.webServer.reuseExistingServer,
  workers: config.workers === undefined ? 'undefined' : config.workers,
}));
`;

/** Load the config with exactly `vars` (plus PATH) in the environment. */
function loadConfig(vars) {
  const env = { PATH: process.env.PATH || '', ...vars };
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', LOADER], {
    cwd: path.dirname(CONFIG_PATH),
    env,
    encoding: 'utf8',
    timeout: 30 * 1000,
  });
  if (result.error) throw result.error;
  return result;
}

function loadOk(vars) {
  const result = loadConfig(vars);
  expect(result.status, `config failed to load:\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout);
}

function expectPort(settings, port) {
  expect(settings.command).toBe(`npx --no http-server ./web -p ${port} -a 127.0.0.1 -s`);
  expect(settings.serverUrl).toBe(`http://127.0.0.1:${port}`);
  expect(settings.baseURL).toBe(`http://127.0.0.1:${port}`);
}

test.describe('playwright.config.js: PW_PORT', () => {
  test('unset PW_PORT serves on the default port 8199', () => {
    expectPort(loadOk({}), 8199);
  });

  test('empty PW_PORT means unset: default port 8199', () => {
    expectPort(loadOk({ PW_PORT: '' }), 8199);
  });

  for (const port of [1024, 8299, 65535]) {
    test(`PW_PORT=${port} is accepted and moves the server`, () => {
      expectPort(loadOk({ PW_PORT: String(port) }), port);
    });
  }

  for (const bad of ['1023', '65536', ' 8199', '8199 ', '8199x', 'abc', '8199.0', ' ', '-8199', '0']) {
    test(`PW_PORT=${JSON.stringify(bad)} fails loading with a message naming PW_PORT`, () => {
      const result = loadConfig({ PW_PORT: bad });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('PW_PORT must be an integer from 1024 to 65535');
      expect(result.stderr).toContain(JSON.stringify(bad));
    });
  }

  test('reuseExistingServer stays false, with and without PW_PORT', () => {
    expect(loadOk({}).reuseExistingServer).toBe(false);
    expect(loadOk({ PW_PORT: '8299' }).reuseExistingServer).toBe(false);
  });
});

test.describe('playwright.config.js: workers', () => {
  test('with CI set, the run uses one worker', () => {
    expect(loadOk({ CI: 'true' }).workers).toBe(1);
  });

  test('with CI unset, workers is left to the Playwright default', () => {
    expect(loadOk({}).workers).toBe('undefined');
  });
});
