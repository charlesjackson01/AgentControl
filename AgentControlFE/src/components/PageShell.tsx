import type { ReactNode } from 'react'

type PageShellProps = {
  eyebrow: string
  title: string
  subtitle: string
  actions?: ReactNode
  children: ReactNode
}

export default function PageShell({ eyebrow, title, subtitle, actions, children }: PageShellProps) {
  return (
    <main className="page">
      <div className="page__inner">
        <div className="page__head">
          <div>
            <p className="page__eyebrow">{eyebrow}</p>
            <h1 className="page__title">{title}</h1>
            <p className="page__sub">{subtitle}</p>
          </div>
          {actions && <div className="page__actions">{actions}</div>}
        </div>
        {children}
      </div>
    </main>
  )
}
