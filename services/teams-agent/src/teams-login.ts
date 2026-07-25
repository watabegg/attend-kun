/**
 * Headless Teams login driven by Playwright.
 *
 * Flow (email one-time-code, no password — matches this guest account):
 *   1. Open the Teams login URL for the target tenant.
 *   2. If already authenticated (session restored), return immediately.
 *   3. Otherwise enter the email, which triggers Microsoft to email a code.
 *   4. Poll Gmail for that code and submit it.
 *   5. Answer the "Stay signed in?" prompt with Yes to get durable cookies.
 *
 * Microsoft's login DOM changes over time, so every step uses a list of
 * fallback selectors and tolerant waits. On failure we capture a screenshot to
 * GCS for debugging.
 */

import type { BrowserContext, Page } from "playwright";

import type { Config } from "./config";
import { waitForVerificationCode } from "./gmail";
import type { SessionStore } from "./session-store";

const EMAIL_SELECTORS = ['input[type="email"]', "#i0116", 'input[name="loginfmt"]'];
const NEXT_SELECTORS = ["#idSIButton9", 'input[type="submit"]', 'button[type="submit"]'];
const OTC_SELECTORS = [
  "#idTxtBx_OTC_Passcode",
  'input[name="otc"]',
  'input[autocomplete="one-time-code"]',
  "#iOttText",
  'input[type="tel"]',
];
const SIGNED_IN_MARKERS = [
  "https://teams.microsoft.com/",
  "https://teams.cloud.microsoft/",
  "https://teams.cloud.microsoft",
];

export type Logger = (message: string) => void;

export async function isSignedIn(page: Page): Promise<boolean> {
  const url = page.url();
  if (SIGNED_IN_MARKERS.some((marker) => url.startsWith(marker))) {
    // We are on a Teams origin and not bounced to the login host.
    return !url.includes("login.microsoftonline.com") && !url.includes("login.live.com");
  }
  return false;
}

/**
 * Ensures `page` ends up on an authenticated Teams origin. Performs the full
 * email + MFA login when the restored session is missing or expired.
 */
export async function ensureLoggedIn(
  context: BrowserContext,
  page: Page,
  config: Config,
  store: SessionStore,
  log: Logger,
): Promise<void> {
  log(`navigating to Teams login: ${config.teams.loginUrl}`);
  await page.goto(config.teams.loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await settle(page);

  if (await reachedSignedIn(page)) {
    log("existing session is still valid; skipping login");
    return;
  }

  try {
    await runLoginFlow(page, config, log);
    await reachedSignedIn(page, 60_000);
    log("login flow completed; persisting session");
    const state = (await context.storageState()) as unknown as Record<string, unknown>;
    await store.save(state);
  } catch (error) {
    await captureFailure(page, store, config, "login-failure", log);
    throw error;
  }
}

async function runLoginFlow(page: Page, config: Config, log: Logger): Promise<void> {
  // Step 1: email.
  const emailField = await waitForFirst(page, EMAIL_SELECTORS, 30_000);
  if (!emailField) {
    // Some restored sessions land on an account picker instead of the email
    // form; try clicking "Use another account" then re-checking.
    throw new Error("email input not found on login page");
  }
  log("entering login email");
  await emailField.fill(config.teams.loginEmail);
  const codeRequestedAt = Date.now();
  await clickFirst(page, NEXT_SELECTORS);
  await settle(page);

  // Microsoft may show an intermediate "we will email a code" screen with its
  // own submit button before revealing the code input. Advancing the primary
  // button if the OTC field is not yet present handles that case.
  let otcField = await waitForFirst(page, OTC_SELECTORS, 15_000);
  if (!otcField) {
    log("code input not visible yet; advancing intermediate screen");
    await clickFirst(page, NEXT_SELECTORS);
    await settle(page);
    otcField = await waitForFirst(page, OTC_SELECTORS, 20_000);
  }
  if (!otcField) {
    throw new Error("verification code input not found");
  }

  // Step 2: fetch the code from Gmail and submit it.
  log("waiting for verification code email");
  const verification = await waitForVerificationCode({
    credentials: config.google,
    userId: config.google.userId,
    fromAddress: config.mfa.fromAddress,
    notBefore: codeRequestedAt,
    timeoutSeconds: config.mfa.timeoutSeconds,
    pollIntervalMs: config.mfa.pollIntervalMs,
    log,
  });
  log(`submitting verification code from message ${verification.messageId}`);
  await otcField.fill(verification.code);
  await clickFirst(page, NEXT_SELECTORS);
  await settle(page);

  // Step 3: "Stay signed in?" — answer Yes for durable cookies. Missing prompt
  // is fine; we just proceed.
  await answerStaySignedIn(page, log);
}

async function answerStaySignedIn(page: Page, log: Logger): Promise<void> {
  const yes = await waitForFirst(page, ["#idSIButton9", 'input[value="Yes"]'], 12_000);
  if (yes) {
    log('answering "Stay signed in?" with Yes');
    await yes.click().catch(() => {});
    await settle(page);
  }
}

async function reachedSignedIn(page: Page, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isSignedIn(page)) {
      return true;
    }
    await page.waitForTimeout(1_000);
  }
  return isSignedIn(page);
}

async function waitForFirst(page: Page, selectors: string[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      try {
        if ((await locator.count()) > 0 && (await locator.isVisible())) {
          return locator;
        }
      } catch {
        /* selector not ready */
      }
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function clickFirst(page: Page, selectors: string[]): Promise<void> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) > 0 && (await locator.isVisible())) {
        await locator.click();
        return;
      }
    } catch {
      /* try next */
    }
  }
}

/** Waits for network + DOM to quiet down, tolerating navigations. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
}

async function captureFailure(
  page: Page,
  store: SessionStore,
  config: Config,
  label: string,
  log: Logger,
): Promise<void> {
  if (!config.debugArtifacts) {
    return;
  }
  try {
    const stamp = `${label}-${page.url().replace(/[^a-z0-9]/gi, "_").slice(0, 60)}`;
    const png = await page.screenshot({ fullPage: true });
    const shot = await store.saveDebug(`${stamp}.png`, png, "image/png");
    const html = await page.content();
    const dump = await store.saveDebug(`${stamp}.html`, html, "text/html");
    log(`captured debug artifacts: ${shot ?? "n/a"} ${dump ?? "n/a"}`);
  } catch (error) {
    log(`failed to capture debug artifacts: ${(error as Error).message}`);
  }
}
