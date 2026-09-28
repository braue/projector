import { AcrtacProjectList } from './AcrtacProjectList'
import { Modal } from './ui'

// Pick ONE project from the AcRTAC database, in a window: the shared list
// (AcrtacProjectList) in single mode — clicking a row picks it and closes.

export function AcrtacProjectPicker({
  current,
  taken = [],
  onPick,
  onClose,
}: {
  /** The row's current pick, highlighted. */
  current?: string
  /** Projects other rows already use — badged, still pickable. */
  taken?: string[]
  onPick: (project: string) => void
  onClose: () => void
}) {
  return (
    <Modal title="AcRTAC database" onClose={onClose}>
      <div className="modal-sub">Pick the project to upload to this RTAC.</div>
      <AcrtacProjectList mode="single" autoFocus current={current} taken={taken} onPick={onPick} />
    </Modal>
  )
}
