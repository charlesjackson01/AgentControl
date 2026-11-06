/**
 * BE-P2-19: an in-process mutex for the shared image builds. The bot-images setup step
 * (VmHostService.buildBotImages, which may rebuild botvm and botvm-browser) and the browser add-on's
 * own download (BrowserAddon, which builds botvm-browser FROM botvm) take turns on one lock, so the
 * two never run `podman build` for these images at the same time. Waiters run in arrival order.
 */
export interface ImageBuildLock {
  /** Runs `fn` once every earlier holder is done. `waited` is true when it had to wait. */
  run<T>(fn: (waited: boolean) => Promise<T>): Promise<T>
  /** True while a holder is running (or queued). */
  busy(): boolean
}

export function createImageBuildLock(): ImageBuildLock {
  let tail: Promise<void> = Promise.resolve()
  let holders = 0
  return {
    run<T>(fn: (waited: boolean) => Promise<T>): Promise<T> {
      const waited = holders > 0
      holders += 1
      const prev = tail
      let release!: () => void
      tail = new Promise<void>((r) => (release = r))
      return (async () => {
        try {
          await prev
          return await fn(waited)
        } finally {
          holders -= 1
          release()
        }
      })()
    },
    busy: () => holders > 0,
  }
}
