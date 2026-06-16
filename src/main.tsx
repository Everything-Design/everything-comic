import { Component, ErrorInfo, ReactNode, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// Feature-detect the APIs the engine relies on so unsupported browsers get a clear message
// instead of a blank page or a cryptic throw deep in the worker.
function unsupportedReason(): string | null {
  if (typeof Worker === 'undefined') return 'Web Workers'
  if (typeof OffscreenCanvas === 'undefined' && typeof createImageBitmap === 'undefined')
    return 'createImageBitmap'
  const cv = document.createElement('canvas')
  if (!cv.getContext('2d')) return 'Canvas 2D'
  return null
}

function Fallback({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="fatal" role="alert">
      <h1>{title}</h1>
      <p>{detail}</p>
    </div>
  )
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Everything Comic crashed:', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div className="fatal" role="alert">
          <h1>Something went wrong.</h1>
          <p>{this.state.error.message || 'An unexpected error occurred.'}</p>
          <button onClick={() => location.reload()}>Reload</button>
        </div>
      )
    }
    return this.props.children
  }
}

const root = createRoot(document.getElementById('root')!)
const missing = unsupportedReason()
if (missing) {
  root.render(
    <Fallback
      title="This browser isn’t supported"
      detail={`Everything Comic needs ${missing}, which isn’t available here. Try the latest Chrome, Edge, Firefox, or Safari.`}
    />,
  )
} else {
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
}
