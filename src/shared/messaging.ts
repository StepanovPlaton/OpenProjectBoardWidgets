import type { BackgroundRequest, BackgroundResponse } from "./types";

const RETRIES = 2;
const RETRY_DELAY_MS = 400;

function isContextInvalidated(message: string): boolean {
  return /extension context invalidated|message port closed|receiving end does not exist/i.test(
    message,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendOnce<T extends BackgroundResponse>(message: BackgroundRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      if (!chrome.runtime?.id) {
        reject(new Error("Extension context invalidated"));
        return;
      }
      chrome.runtime.sendMessage(message, (response: BackgroundResponse | undefined) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        if (!response) {
          reject(new Error("Empty response from background"));
          return;
        }
        resolve(response as T);
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Send a message to the service worker with short retries.
 * Callers should still catch — after extension reload the page must be refreshed.
 */
export async function sendMessage<T extends BackgroundResponse>(
  message: BackgroundRequest,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      return await sendOnce<T>(message);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const retryable = isContextInvalidated(lastError.message) || /empty response/i.test(lastError.message);
      if (!retryable || attempt === RETRIES) break;
      await delay(RETRY_DELAY_MS * (attempt + 1));
    }
  }

  throw lastError ?? new Error("Messaging failed");
}
