/**
 * Orchestrates a single authenticated Teams browser session and exposes two
 * high-level operations: `send(text)` and `login()`.
 *
 * A process-wide mutex serialises all browser work so concurrent punches never
 * race on the shared session file. Cloud Run is deployed with max-instances=1
 * and concurrency=1 as a second layer of protection.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import type { Config } from "./config";
import {
  extractGraphToken,
  GraphTokenCollector,
  type GraphToken,
  sendChatMessage,
} from "./graph";
import { ensureLoggedIn, isSignedIn, type Logger } from "./teams-login";
import { SessionStore } from "./session-store";

export type SendResult = {
  ok: true;
  text: string;
  tokenExpiresAt: number;
  tenantId?: string;
  relogin: boolean;
};

export class TeamsAgent {
  private readonly store: SessionStore;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: Config) {
    this.store = new SessionStore(
      config.gcs.bucket,
      config.gcs.sessionObject,
      config.gcs.debugPrefix,
    );
  }

  /** Runs `task` after all previously queued browser work has finished. */
  private serialise<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    // Keep the chain alive regardless of individual task outcome.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Dry run: log in if needed and prove we can obtain a Graph token, WITHOUT
   * posting anything to the chat. Used to validate the login/session pipeline
   * safely (no risk of a stray message in the real chat).
   */
  async login(log: Logger): Promise<{ ok: true; relogin: boolean; tokenExpiresAt: number; tenantId?: string }> {
    return this.serialise(async () =>
      this.withSession(log, async (context, page) => {
        const { token, relogin } = await this.establish(context, page, log);
        return {
          ok: true as const,
          relogin,
          tokenExpiresAt: token.expiresAt,
          ...(token.tenantId ? { tenantId: token.tenantId } : {}),
        };
      }),
    );
  }

  async send(text: string, log: Logger): Promise<SendResult> {
    return this.serialise(async () =>
      this.withSession(log, async (context, page) => {
        const { token, relogin } = await this.establish(context, page, log);

        log(`sending message to chat ${this.config.teams.targetChatId}`);
        await sendChatMessage(token.jwt, this.config.teams.targetChatId, text);

        // Cookies often rotate during a session; persist the latest state.
        await this.persist(context);

        return {
          ok: true as const,
          text,
          tokenExpiresAt: token.expiresAt,
          relogin,
          ...(token.tenantId ? { tenantId: token.tenantId } : {}),
        } satisfies SendResult;
      }),
    );
  }

  /**
   * Ensures the session is authenticated and returns a usable Graph token,
   * re-logging in if cookies are missing or expired. Persists the session
   * afterwards. Shared by `login` (dry run) and `send`.
   */
  private async establish(
    context: BrowserContext,
    page: Page,
    log: Logger,
  ): Promise<{ token: GraphToken; relogin: boolean }> {
    const collector = new GraphTokenCollector(page);
    const wasSignedIn = await this.gotoTeams(page, log);
    let relogin = false;
    if (!wasSignedIn) {
      relogin = true;
      await ensureLoggedIn(context, page, this.config, this.store, log);
      await this.gotoTeams(page, log);
    }

    let token = await this.acquireToken(page, collector, log);
    if (!token) {
      // Session cookies may have silently expired; force a fresh login.
      log("no usable Graph token found; forcing re-login");
      relogin = true;
      await ensureLoggedIn(context, page, this.config, this.store, log);
      await this.gotoTeams(page, log);
      token = await this.acquireToken(page, collector, log);
    }
    if (!token) {
      await this.captureDebug(page, "token-failure", log);
      throw new Error("could not obtain a Graph token with ChatMessage.Send");
    }

    await this.persist(context);
    return { token, relogin };
  }

  /** Best-effort screenshot + HTML dump to GCS for debugging a failed run. */
  private async captureDebug(page: Page, label: string, log: Logger): Promise<void> {
    if (!this.config.debugArtifacts) {
      return;
    }
    try {
      log(`current url at failure: ${page.url()}`);
      const png = await page.screenshot({ fullPage: true });
      const shot = await this.store.saveDebug(`${label}.png`, png, "image/png");
      const html = await page.content();
      const dump = await this.store.saveDebug(`${label}.html`, html, "text/html");
      log(`captured debug artifacts: ${shot ?? "n/a"} ${dump ?? "n/a"}`);
    } catch (error) {
      log(`failed to capture debug artifacts: ${(error as Error).message}`);
    }
  }

  private async persist(context: BrowserContext): Promise<void> {
    const state = (await context.storageState()) as unknown as Record<string, unknown>;
    await this.store.save(state).catch(() => {});
  }

  /** Navigates to Teams (and the target chat) to trigger MSAL token acquisition. */
  private async gotoTeams(page: Page, log: Logger): Promise<boolean> {
    log("opening Teams");
    await page
      .goto(this.config.teams.loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 })
      .catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    return isSignedIn(page).catch(() => false);
  }

  private async acquireToken(page: Page, collector: GraphTokenCollector, log: Logger) {
    // Give MSAL a moment and nudge it by opening the specific chat deep link.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = await extractGraphToken(page, collector, log);
      if (token) {
        log(`acquired Graph token (scopes: ${token.scopes.join(",")})`);
        return token;
      }
      // Nudge MSAL to acquire a chat-scoped token by opening the chat, trying
      // both the classic and new-Teams deep-link shapes.
      const chatId = encodeURIComponent(this.config.teams.targetChatId);
      const deepLink =
        attempt % 2 === 0
          ? `https://teams.microsoft.com/_#/conversations/${chatId}?ctx=chat`
          : `https://teams.microsoft.com/v2/#/conversations/${chatId}?ctx=chat`;
      log(`nudging token acquisition via ${deepLink}`);
      await page.goto(deepLink, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(3_000);
    }
    return extractGraphToken(page, collector, log);
  }

  /** Launches a browser, restores the saved session, runs `fn`, then cleans up. */
  private async withSession<T>(
    log: Logger,
    fn: (context: BrowserContext, page: Page) => Promise<T>,
  ): Promise<T> {
    const browser: Browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const saved = await this.store.load();
      // Present as a normal desktop Chrome so Teams boots the full web client
      // instead of an "unsupported browser" fallback (HeadlessChrome UA).
      const contextOptions = {
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 900 },
        locale: "ja-JP",
        timezoneId: "Asia/Tokyo",
      };
      const context = await browser.newContext(
        saved ? { ...contextOptions, storageState: saved as never } : contextOptions,
      );
      const page = await context.newPage();
      try {
        return await fn(context, page);
      } finally {
        await context.close().catch(() => {});
      }
    } finally {
      await browser.close().catch(() => {});
    }
  }
}
