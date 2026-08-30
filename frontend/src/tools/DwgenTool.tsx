// Drawing Generator — configured connection drawings from an SEL part
// number, entirely offline on the in-repo drawing corpus (64 models). Shows
// the decoded ordering positions and front/rear previews; outputs the
// layer-filtered PDFs plus an AutoCAD bundle (source .dwg + .lsp + .scr per
// drawing). "Open as DWG" on a drawing launches local AutoCAD with the same
// layer switch applied; without AutoCAD the bundle is the hand-off.

import { useEffect, useState } from 'react'

import { fetchDwgenModels, generateDwgen, openDwgenDwg, toolRunFileUrl } from '../api'
import { Button, CollapsibleSection, DataTable, Select, Spinner, TextInput } from '../components/ui'
import { errorMessage } from '../lib/errors'
import type { DwgenResult } from '../types'
import type { ToolProps } from './registry'
import { RunOutputs } from './RunOutputs'

export function DwgenTool(_props: ToolProps) {
  const [partNumber, setPartNumber] = useState('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<DwgenResult | null>(null)
  const [dwgStatus, setDwgStatus] = useState<string | null>(null)

  useEffect(() => {
    fetchDwgenModels().then(setModels).catch(() => {})
  }, [])

  const generate = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    setDwgStatus(null)
    try {
      setResult(await generateDwgen({ partNumber, model: model || undefined }))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const openDwg = async (run: string, stem: string) => {
    setDwgStatus(null)
    try {
      const { configured } = await openDwgenDwg({ run, stem })
      setDwgStatus(`Opening ${stem}.dwg in AutoCAD — layers switch on load, saved as ${configured}`)
    } catch (err) {
      setDwgStatus(`Open failed: ${errorMessage(err)}`)
    }
  }

  // The headline outputs; the AutoCAD bundle rows stay in the run but out of
  // the strip.
  const headline = result?.reports.filter((r) => !r.kind) ?? []

  return (
    <>
      <div className="preview-header">
        <div className="preview-title-row">
          <h2>Drawing Generator</h2>
          {busy && <Spinner />}
          {result && <span className="tool-stats">{result.product ?? result.model}</span>}
        </div>
        <div className="preview-subtitle">
          Enter an ordered part number (MOT) — the matching master configuration
          drawing gets its layers switched to that exact configuration. Open as
          DWG launches AutoCAD on the same drawing with the same layer switch;
          the run also includes the script bundle for other machines.
        </div>
      </div>
      <div className="tool-scroll">
        <div className="tool-col">
          <TextInput
            label="Part number (MOT)"
            value={partNumber}
            placeholder="e.g. 751A51ABA0X71850230"
            spellCheck={false}
            onChange={(e) => setPartNumber(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && partNumber.trim() && !busy) generate()
            }}
          />
          <Select
            label="Model"
            value={model}
            placeholder="Auto-detect"
            onChange={setModel}
            options={models}
          />
          <div className="tool-row">
            <Button variant="primary" disabled={busy || !partNumber.trim()} onClick={generate}>
              Generate
            </Button>
          </div>
        </div>

        {error && <div className="tool-error">{error}</div>}
        {result?.warnings.map((warning) => (
          <div key={warning} className="tool-error">{warning}</div>
        ))}

        {result && (
          <>
            {result.previews.length > 0 && (
              <div className="dwgen-previews">
                {result.previews.map((preview) => (
                  <img
                    key={preview}
                    src={toolRunFileUrl('dwgen', result.run, preview)}
                    alt={preview}
                  />
                ))}
              </div>
            )}

            <CollapsibleSection title="Decoded part number" count={result.decoded.positions.length}>
              <DataTable
                maxHeight="320px"
                columns={[
                  { key: 'position', label: 'Pos' },
                  { key: 'label', label: 'Option' },
                  { key: 'code', label: 'Code' },
                  { key: 'description', label: 'Selection' },
                ]}
                rows={result.decoded.positions.map((pos) => ({
                  id: String(pos.position),
                  cells: {
                    position: pos.position,
                    label: pos.label ?? '',
                    code: pos.code,
                    description: pos.description ?? (pos.matched ? '' : '(unrecognized)'),
                  },
                  tone: pos.matched ? undefined : 'removed',
                  titles: pos.note ? { description: pos.note } : undefined,
                }))}
              />
            </CollapsibleSection>

            <CollapsibleSection title="Enabled drawing layers" count={result.layers.length}>
              <ul className="dwgen-layers">
                {result.layers.map((layer) => <li key={layer} className="mono">{layer}</li>)}
              </ul>
            </CollapsibleSection>

            <RunOutputs
              tool="dwgen"
              run={result.run}
              reports={headline}
              count={headline.length + result.dwgs.length}
            >
              {result.dwgs.map((dwg) => (
                <div className="tool-row" key={dwg.stem}>
                  <span className="tool-output-name" title={`autocad/${dwg.stem}.dwg`}>
                    AutoCAD drawing ({dwg.stem}.dwg)
                  </span>
                  <Button
                    disabled={!result.autocad}
                    title={result.autocad ? undefined : 'AutoCAD not found on this machine'}
                    onClick={() => openDwg(result.run, dwg.stem)}
                  >
                    Open
                  </Button>
                </div>
              ))}
              {dwgStatus && <div className="tool-status">{dwgStatus}</div>}
            </RunOutputs>
          </>
        )}
      </div>
    </>
  )
}
