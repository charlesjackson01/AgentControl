import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'

const KEY = 'agentcontrol.theme'

function read(): Theme {
  const raw = localStorage.getItem(KEY)
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
}

/** Resolved appearance actually painted on <html data-theme>. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(read)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const resolved = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
    document.documentElement.dataset.theme = resolved
  }, [theme, systemDark])

  useEffect(() => {
    localStorage.setItem(KEY, theme)
  }, [theme])

  return { theme, setTheme }
}
