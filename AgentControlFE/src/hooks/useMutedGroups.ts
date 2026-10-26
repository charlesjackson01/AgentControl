import { useCallback, useSyncExternalStore } from 'react'
import { MUTE_KEY, readMuted, writeMuted } from '../lib/groups'

/** GAP-G5: "Mute notifications" is this browser only (BE-5 has no mute field). */
const EVENT = 'agentcontrol:muted'
function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
let cache: { raw: string | null; set: Set<string> } = { raw: null, set: new Set() }
function snapshot(): Set<string> {
  const raw = storage()?.getItem(MUTE_KEY) ?? null
  if (raw !== cache.raw) cache = { raw, set: readMuted(storage()) }
  return cache.set
}
function subscribe(cb: () => void) {
  const onStorage = (e: StorageEvent) => e.key === MUTE_KEY && cb()
  window.addEventListener(EVENT, cb)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(EVENT, cb)
    window.removeEventListener('storage', onStorage)
  }
}

export function useMutedGroups(): Set<string> {
  return useSyncExternalStore(subscribe, snapshot)
}

export function useSetMuted(): (id: string, on: boolean) => void {
  return useCallback((id: string, on: boolean) => {
    const next = new Set(readMuted(storage()))
    if (on) next.add(id)
    else next.delete(id)
    writeMuted(storage(), next)
    window.dispatchEvent(new Event(EVENT))
  }, [])
}
