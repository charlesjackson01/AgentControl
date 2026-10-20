/*
 * Open dialogs, in the order they opened. Only the topmost one handles Esc and the
 * Tab trap, so Esc in a dialog opened from another (endpoint Edit inside Settings)
 * closes just that one. Pure; tests/dialog-stack.test.mjs.
 */
export type DialogStack = {
  open: (token: object) => void
  close: (token: object) => void
  isTop: (token: object) => boolean
  size: () => number
}

export function createDialogStack(): DialogStack {
  const stack: object[] = []
  return {
    open(token) {
      if (!stack.includes(token)) stack.push(token)
    },
    close(token) {
      const i = stack.indexOf(token)
      if (i !== -1) stack.splice(i, 1)
    },
    isTop(token) {
      return stack.length > 0 && stack[stack.length - 1] === token
    },
    size: () => stack.length,
  }
}

/** The app's one stack, shared by every <Dialog>. */
export const dialogStack = createDialogStack()
