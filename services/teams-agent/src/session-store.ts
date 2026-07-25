/**
 * Persists the Playwright storageState (Microsoft session cookies + local
 * storage) in a private GCS bucket so that a cold Cloud Run instance can resume
 * an authenticated Teams session without re-doing the email MFA flow.
 */

import { Storage } from "@google-cloud/storage";

export class SessionStore {
  private readonly storage = new Storage();

  constructor(
    private readonly bucket: string,
    private readonly sessionObject: string,
    private readonly debugPrefix: string,
  ) {}

  /** Returns the parsed storageState, or null if no session has been saved yet. */
  async load(): Promise<Record<string, unknown> | null> {
    const file = this.storage.bucket(this.bucket).file(this.sessionObject);
    const [exists] = await file.exists();
    if (!exists) {
      return null;
    }
    const [contents] = await file.download();
    try {
      return JSON.parse(contents.toString("utf-8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async save(storageState: Record<string, unknown>): Promise<void> {
    const file = this.storage.bucket(this.bucket).file(this.sessionObject);
    await file.save(JSON.stringify(storageState), {
      contentType: "application/json",
      resumable: false,
    });
  }

  async clear(): Promise<void> {
    const file = this.storage.bucket(this.bucket).file(this.sessionObject);
    const [exists] = await file.exists();
    if (exists) {
      await file.delete({ ignoreNotFound: true });
    }
  }

  /**
   * Best-effort upload of a debug artifact (screenshot bytes or HTML) used when
   * a login attempt fails. Never throws — debugging must not break the caller.
   */
  async saveDebug(name: string, data: Buffer | string, contentType: string): Promise<string | null> {
    try {
      const objectName = `${this.debugPrefix}/${name}`;
      const file = this.storage.bucket(this.bucket).file(objectName);
      await file.save(data, { contentType, resumable: false });
      return `gs://${this.bucket}/${objectName}`;
    } catch {
      return null;
    }
  }
}
