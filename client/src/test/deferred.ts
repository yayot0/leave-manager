/**
 * A promise the test resolves when it wants. An MSW handler can `await` it to
 * keep a request in flight, so the test can check the loading state
 * deterministically (no timers).
 */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
