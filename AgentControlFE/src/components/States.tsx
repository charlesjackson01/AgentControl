import type { ReactNode } from 'react'

export function Skeleton({ width, height = 10 }: { width?: number | string; height?: number }) {
  return <span className="skeleton" style={{ display: 'block', width: width ?? '100%', height }} />
}

type EmptyStateProps = {
  icon: ReactNode
  title: string
  text: string
  actions?: ReactNode
}

export function EmptyState({ icon, title, text, actions }: EmptyStateProps) {
  return (
    <div className="empty">
      <div className="empty__icon">{icon}</div>
      <p className="empty__title">{title}</p>
      <p className="empty__text">{text}</p>
      {actions && <div className="empty__actions">{actions}</div>}
    </div>
  )
}

type ErrorStateProps = {
  title?: string
  error: Error
  onRetry?: () => void
}

export function ErrorState({ title = 'Something went wrong', error, onRetry }: ErrorStateProps) {
  return (
    <div className="empty" role="alert">
      <div className="empty__icon empty__icon--danger">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
          <path d="M12 8v5" />
          <circle cx="12" cy="16.5" r="1" fill="currentColor" stroke="none" />
          <path d="M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3l-7.7-13.5a2 2 0 0 0-3.4 0Z" />
        </svg>
      </div>
      <p className="empty__title">{title}</p>
      <p className="empty__text">{error.message}</p>
      {onRetry && (
        <div className="empty__actions">
          <button type="button" className="btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  )
}