import { useCallback, useEffect, useState, type DependencyList } from 'react'

type Settled<T> = {
  key: string
  attempt: number
  data: T | undefined
  error: Error | undefined
}

/**
 * Minimal async-data hook.
 *
 * `loader` must be a stable reference (pass `api.listAgents`, not
 * `() => api.listAgents()`). `deps` controls when it refetches.
 *
 * `loading` is derived during render from whether the settled result belongs
 * to the current request, so it flips to true the moment `reload` is called or
 * a dep changes, without a state reset inside the effect.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: DependencyList) {
  const key = JSON.stringify(deps)
  const [attempt, setAttempt] = useState(0)
  const [settled, setSettled] = useState<Settled<T> | null>(null)

  useEffect(() => {
    let active = true

    loader().then(
      (data) => {
        if (active) setSettled({ key, attempt, data, error: undefined })
      },
      (error: unknown) => {
        if (active) {
          setSettled({
            key,
            attempt,
            data: undefined,
            error: error instanceof Error ? error : new Error(String(error)),
          })
        }
      },
    )

    return () => {
      active = false
    }
  }, [key, attempt, loader])

  const current = settled !== null && settled.key === key && settled.attempt === attempt ? settled : null
  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  return { data: current?.data, error: current?.error, loading: current === null, reload }
}