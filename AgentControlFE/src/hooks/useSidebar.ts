import { useCallback, useEffect, useState } from 'react'

const KEY = 'agentcontrol.sidebar.collapsed'
const MOBILE_QUERY = '(max-width: 900px)'

function read(): boolean {
  return localStorage.getItem(KEY) === '1'
}

/** Rail-mode on desktop, drawer on mobile. */
export function useSidebar() {
  const [collapsed, setCollapsed] = useState(read)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia(MOBILE_QUERY).matches,
  )

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY)
    const onChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches)
      if (!e.matches) setMobileOpen(false)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    localStorage.setItem(KEY, collapsed ? '1' : '0')
  }, [collapsed])

  const toggle = useCallback(() => {
    if (isMobile) setMobileOpen((o) => !o)
    else setCollapsed((c) => !c)
  }, [isMobile])

  const close = useCallback(() => setMobileOpen(false), [])

  return { collapsed, setCollapsed, mobileOpen, setMobileOpen, isMobile, toggle, close }
}
