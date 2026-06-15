const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  try {
    await page.goto('http://localhost:8000', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    
    // Check that the list element exists and is scrollable
    const listElement = await page.$('#dappList');
    const isScrollable = await page.evaluate(() => {
      const list = document.getElementById('dappList');
      return {
        hasOverflowAuto: window.getComputedStyle(list).overflowY === 'auto',
        hasOverscrollBehavior: window.getComputedStyle(list).overscrollBehaviorY === 'contain',
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
        isScrollable: list.scrollHeight > list.clientHeight,
        touchAction: window.getComputedStyle(list).touchAction
      };
    });
    
    console.log('Scroll properties:', JSON.stringify(isScrollable, null, 2));
    
    // Try to scroll
    if (isScrollable.isScrollable) {
      const initialScrollTop = await page.evaluate(() => document.getElementById('dappList').scrollTop);
      await page.evaluate(() => {
        document.getElementById('dappList').scrollTop = 100;
      });
      const finalScrollTop = await page.evaluate(() => document.getElementById('dappList').scrollTop);
      console.log(`Scroll test: initial=${initialScrollTop}, after scroll=${finalScrollTop}, difference=${finalScrollTop - initialScrollTop}`);
    } else {
      console.log('List is not scrollable (fits in viewport)');
    }
    
    // Take screenshot
    await page.screenshot({ path: '/tmp/dapplist.png' });
    console.log('Screenshot saved to /tmp/dapplist.png');
    
  } finally {
    await browser.close();
  }
})();
