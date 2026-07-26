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
        <button className="btn" data-variant="primary" onClick={() => respond('allow')}>
          Allow
        </button>
        <button className="btn" data-variant="danger" onClick={() => respond('deny')}>
          Deny
        </button>
      </div>
    </div>
  )
}
