import type { ReactNode } from 'react'

import { Spinner } from '../components/ui'

/** The title strip every tool opens with: its name, a spinner while it
 *  works, and whatever status it wants beside them. */
export function ToolHeader({
  title,
  busy = false,
  children,
}: {
  title: string
  busy?: boolean
  children?: ReactNode
}) {
  return (
    <div className="preview-header">
      <div className="preview-title-row">
        <h2>{title}</h2>
        {busy && <Spinner />}
        {children}
      </div>
    </div>
  )
}
