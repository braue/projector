import { fileRawUrl } from '../api'

// PDFs render in the preview pane with Chromium's built-in viewer (scroll,
// zoom, text search, print) — the app and its backend share one loopback
// origin, so an <iframe> at the raw-bytes endpoint is same-origin and needs
// no plugin or dependency. Archived versions address by their real
// `.versions/…` path, which the endpoint serves like any other file.
export function PdfView({
  project,
  path,
  name,
}: {
  project: string
  path: string
  name: string
}) {
  return (
    <main className="preview">
      <header className="preview-header">
        <div className="preview-title-row">
          <h2>{name}</h2>
        </div>
        <div className="preview-subtitle">
          <span className="mono">{path}</span>
        </div>
      </header>
      <div className="preview-scroll">
        <iframe
          className="pdf-frame"
          key={`${project}:${path}`}
          title={name}
          src={fileRawUrl(project, path)}
        />
      </div>
    </main>
  )
}
