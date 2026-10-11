// Screenshot of the Macro & News panel (lower panel expanded). usage: node scripts/screenshot-macro.js [url] [out]
const { chromium } = require('playwright-core');
(async () => {
  const url = process.argv[2] || 'http://localhost:8000/?tab=macro&expand=1';
  const out = process.argv[3] || __dirname + '/../screenshot-macro.png';
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: +process.env.H || 1500 } });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#macroOut .kv') && document.querySelector('#macroOut .news'), null, { timeout: 90000 }).catch(() => console.log('wait timeout'));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: out });
  console.log('saved', out);
  await browser.close();
})();
