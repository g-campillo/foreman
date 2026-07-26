import { Ban, Check } from 'lucide-react'
import type { PermissionRequest } from '../../../shared/types'
import { summarise } from './ToolCard'

export default function ApprovalCard({ req }: { req: PermissionRequest }): React.JSX.Element {
  const gist = summarise(req.toolName, req.input)

  const respond = (behavior: 'allow' | 'deny'): void => {
    void window.foreman.respondPermission(req.requestId, behavior)
  }

  return (
    <div className="approval">
      <div className="approval-title">
        Allow <code>{req.toolName}</code>?
      </div>
      {gist && <div className="approval-input">{gist}</div>}
      <div className="approval-actions">
        {/* Both keep their words: these grant or refuse a real permission, and
            an icon-only Allow beside an icon+text Deny reads as a bug. */}
        <button className="btn" data-variant="primary" onClick={() => respond('allow')}>
          <Check size={14} />
          Allow
        </button>
        <button className="btn" data-variant="danger" onClick={() => respond('deny')}>
          <Ban size={14} />
          Deny
        </button>
      </div>
    </div>
  )
}
