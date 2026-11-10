const { chromium } = require('playwright');

async function debugPOS() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  page.on('console', msg => console.log('PAGE LOG:', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

  console.log('Navigating to http://localhost:5178...');
  try {
    await page.goto('http://localhost:5178', { waitUntil: 'load', timeout: 15000 });
    await page.waitForTimeout(3000);
    const content = await page.content();
    console.log('Page title:', await page.title());
    console.log('Root HTML length:', content.length);
    console.log('App root HTML snippet:', content.slice(0, 1000));
  } catch (e) {
    console.error('Navigation error:', e.message);
  } finally {
    await browser.close();
  }
}

debugPOS();
