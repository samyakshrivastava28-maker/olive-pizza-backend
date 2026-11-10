const { chromium } = require('playwright');

async function testPOSLogin() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  page.on('console', msg => console.log('PAGE LOG:', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

  console.log('Navigating to http://localhost:5178/#/login...');
  await page.goto('http://localhost:5178/#/login', { waitUntil: 'networkidle' });

  // Fill in cashier credentials or check login
  const emailInput = await page.$('input[type="email"]');
  const passwordInput = await page.$('input[type="password"]');

  console.log('Found email input:', !!emailInput, 'password input:', !!passwordInput);

  if (emailInput && passwordInput) {
    await emailInput.fill('cashier@olivepizza.in');
    await passwordInput.fill('Olive@1234'); // Let's check password or how users login
    await page.click('button:has-text("Sign In")');
    await page.waitForTimeout(4000);
    console.log('URL after login attempt:', page.url());
    console.log('Body text after login attempt:\n', (await page.innerText('body')).slice(0, 500));
  }

  await browser.close();
}

testPOSLogin();
