import type { DeskState } from './api';

export function Audit({ state }: { state: DeskState }) {
  const rows = [...state.audit].reverse();
  return (
    <div className="panel fill scroll audit">
      {rows.length === 0 ? (
        <div className="empty">Every agent tool call, approval and PayPal status change is recorded here.</div>
      ) : (
        <table>
          <thead>
            <tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr>
          </thead>
          <tbody>
            {rows.map((a, i) => (
              <tr key={i}>
                <td className="mono">{new Date(a.at).toLocaleString()}</td>
                <td>
                  <span className={`badge ${a.actor.startsWith('human') ? 'ok' : a.actor === 'agent' ? 'brand' : ''}`}>{a.actor}</span>
                </td>
                <td className="mono">{a.action}</td>
                <td className="mono" style={{ maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {JSON.stringify(a.detail)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
