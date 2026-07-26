import { useMemo, useState } from 'react'
import type { ElicitationRequest } from '../../../shared/types'
import { schemaFields } from '../derive.mts'

/**
 * An MCP server asking the user for something mid-turn.
 *
 * 'url' mode is informational — main already opened the browser and accepted,
 * because the useful act for an OAuth prompt is opening the page. 'form' mode
 * blocks the turn until answered, exactly like an approval card.
 */
export default function ElicitationCard({
  req,
}: {
  req: ElicitationRequest
}): React.JSX.Element {
  const fields = useMemo(() => schemaFields(req.schema), [req.schema])
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      fields.flatMap((f) => (f.default !== undefined ? [[f.name, f.default]] : [])),
    ),
  )

  const missing = fields.filter(
    (f) => f.required && (values[f.name] === undefined || values[f.name] === ''),
  )

  const respond = (action: 'accept' | 'decline'): void => {
    void window.foreman.respondElicitation(
      req.requestId,
      action,
      action === 'accept' ? values : undefined,
    )
  }

  if (req.mode === 'url') {
    return (
      <div className="elicit">
        <div className="elicit-head">
          <span className="elicit-server">{req.serverName}</span>
          <span className="elicit-badge">opened in browser</span>
        </div>
        <p className="elicit-msg">{req.title ?? req.message}</p>
        <p className="elicit-sub">
          Finish signing in there; this session continues once the server confirms.
        </p>
      </div>
    )
  }

  return (
    <div className="elicit">
      <div className="elicit-head">
        <span className="elicit-server">{req.serverName}</span>
        <span className="elicit-badge" data-wait="">
          needs input
        </span>
      </div>
      <p className="elicit-msg">{req.title ?? req.message}</p>
      {req.description && <p className="elicit-sub">{req.description}</p>}

      {fields.map((f) => (
        <label key={f.name} className="elicit-field">
          <span>
            {f.label}
            {f.required && <em> *</em>}
          </span>

          {f.type === 'boolean' ? (
            <input
              type="checkbox"
              checked={Boolean(values[f.name])}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.checked }))}
            />
          ) : f.type === 'enum' ? (
            <select
              className="select"
              value={String(values[f.name] ?? '')}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
            >
              <option value="">Choose…</option>
              {f.options?.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={f.type === 'number' ? 'number' : 'text'}
              value={String(values[f.name] ?? '')}
              onChange={(e) =>
                setValues((v) => ({
                  ...v,
                  // A number field must not send a string, or the server's schema
                  // validation rejects the whole response.
                  [f.name]:
                    f.type === 'number'
                      ? e.target.value === ''
                        ? undefined
                        : Number(e.target.value)
                      : e.target.value,
                }))
              }
            />
          )}
          {f.description && <small>{f.description}</small>}
        </label>
      ))}

      <div className="elicit-actions">
        <button className="btn" onClick={() => respond('decline')}>
          Decline
        </button>
        <button
          className="btn"
          data-variant="primary"
          disabled={missing.length > 0}
          onClick={() => respond('accept')}
          title={missing.length ? `Required: ${missing.map((f) => f.label).join(', ')}` : undefined}
        >
          Send
        </button>
      </div>
    </div>
  )
}
