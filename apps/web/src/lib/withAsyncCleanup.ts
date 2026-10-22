// Keep exception cleanup outside component bodies, where React Compiler cannot lower finally.
export async function withAsyncCleanup<T>(run: () => Promise<T>, cleanup: () => void): Promise<T> {
  try {
    return await run();
  } finally {
    cleanup();
  }
}
