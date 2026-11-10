let schedulerActive = false;

export function initKeepAlive() {
  if (schedulerActive) return;

  const enabled = process.env.KEEP_ALIVE_ENABLED === 'true';
  const url = process.env.RENDER_PUBLIC_URL;

  if (!enabled) {
    return;
  }

  if (!url) {
    console.warn('Keep Alive Scheduler skipped: RENDER_PUBLIC_URL is not set.');
    return;
  }

  console.log('Keep Alive Scheduler Started');
  console.log('Interval: 10 minutes');
  console.log(`Target: ${url}/keep-alive`);

  schedulerActive = true;

  // Run every 10 minutes (600,000 ms)
  setInterval(async () => {
    try {
      const response = await fetch(`${url}/keep-alive`);
      if (response.ok) {
        console.log('Keep Alive Success');
      } else {
        console.log('Keep Alive Failed');
      }
    } catch (error) {
      console.log('Keep Alive Failed');
      console.error(error);
    }
  }, 10 * 60 * 1000);
}
