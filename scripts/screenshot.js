// Headless screenshot using system Chrome via playwright-core.
// usage: node scripts/screenshot.js [url] [out.png] [waitMs]
const { chromium } = require('playwright-core');
(async () => {
  const url = process.argv[2] || 'http://localhost:8000/?scan=solana:TDtNdhCcJcarSCiLzYVGiJFcQnHFJcGijVsK6nNiEN1';
  const out = process.argv[3] || __dirname + '/../screenshot.png';
  const wait = +process.argv[4] || 30000;
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // wait for watchlist data + deep scan to finish
  await page.waitForFunction(() => document.querySelector('#watchTbl tbody tr td.r') && !document.querySelector('#scanOut .spin') && document.querySelector('#scanOut .verdict'), null, { timeout: 120000 }).catch(() => console.log('wait timeout'));
  await page.waitForTimeout(wait);
  await page.screenshot({ path: out });
  console.log('saved', out);
  await browser.close();
})();
