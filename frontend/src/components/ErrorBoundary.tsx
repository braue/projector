import { Component, type ReactNode } from 'react'

import { Button } from './ui'

// Last line of defense: a render crash anywhere in the tree shows a readable
// message instead of a white screen. Reload restarts the app; nothing here
// depends on the crashed state.
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash-screen">
        <h2>Something went wrong</h2>
        <p className="mono">{this.state.error.message}</p>
        <Button variant="primary" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    )
  }
}
