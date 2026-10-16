import { chromium, type Browser, type BrowserContext } from "playwright";
export async function protectContext(
  context: BrowserContext,
  studioOrigin?: string,
) {
  // Playwright's serviceWorkers:'block' init script throws in opaque frames.
  // Use a guarded block instead; opaque frames cannot register workers anyway.
  await context.addInitScript(() => {
    try {
      if (navigator.serviceWorker)
        navigator.serviceWorker.register = async () => {
          throw new Error(
            "Service worker registration is disabled in this local studio.",
          );
        };
    } catch {
      /* Opaque sandbox origin. */
    }
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    try {
      const url = new URL(request.url());
      const frame = request.frame();
      if (studioOrigin && url.origin === studioOrigin && !frame.parentFrame())
        return await route.continue();
    } catch {
      /* Worker requests have no frame and are blocked. */
    }
    await route.abort("blockedbyclient");
  });
  await context.routeWebSocket("**/*", (ws) => {
    try {
      const url = new URL(ws.url());
      // Only the Vite development connection; generated frames have connect-src 'none'.
      if (
        studioOrigin &&
        url.host === new URL(studioOrigin).host &&
        url.pathname === "/"
      ) {
        ws.connectToServer();
        return;
      }
    } catch {
      /* Block invalid addresses. */
    }
    ws.close();
  });
}
export async function launchStudio(origin: string): Promise<Browser> {
  // Prefer the installed, signed Edge on Windows; some Windows application
  // controls reject the downloaded Chrome-for-Testing GUI executable.
  let browser: Browser | undefined;
  const failures: string[] = [];
  const channels =
    process.platform === "win32"
      ? ["msedge", "chrome", undefined]
      : [undefined];
  for (const channel of channels) {
    try {
      browser = await chromium.launch({
        headless: false,
        ...(channel ? { channel } : {}),
        args: ["--site-per-process", "--start-maximized"],
        chromiumSandbox: true,
      });
      break;
    } catch (error) {
      failures.push(
        `${channel || "bundled Chromium"}: ${(error as Error).message.split("\n")[0]}`,
      );
    }
  }
  if (!browser)
    throw new Error(
      `Could not launch a protected browser. ${failures.join("; ")}`,
    );
  const context = await browser.newContext({ viewport: null });
  await protectContext(context, origin);
  await context.addInitScript(() =>
    Object.defineProperty(window, "__studioProtected", {
      value: true,
      configurable: false,
      writable: false,
    }),
  );
  const page = await context.newPage();
  await page.goto(origin);
  return browser;
}
