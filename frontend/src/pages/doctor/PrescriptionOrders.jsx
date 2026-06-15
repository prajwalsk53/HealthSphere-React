import { useState, useEffect } from 'react';
import api from '../../api/axios';

const STATUS_CONFIG = {
  pending:    { color: '#F59E0B', bg: '#FEF3C7', label: 'Pending Approval', next: 'approve',   nextLabel: 'Approve',        nextColor: '#1565C0' },
  approved:   { color: '#1565C0', bg: '#DBEAFE', label: 'Approved',         next: 'preparing', nextLabel: 'Mark Preparing', nextColor: '#0891B2' },
  preparing:  { color: '#0891B2', bg: '#E0F2FE', label: 'Being Prepared',   next: 'dispatch',  nextLabel: 'Mark Dispatched', nextColor: '#7C3AED' },
  dispatched: { color: '#7C3AED', bg: '#EDE9FE', label: 'Dispatched',       next: 'deliver',   nextLabel: 'Mark Delivered', nextColor: '#16A34A' },
  delivered:  { color: '#16A34A', bg: '#DCFCE7', label: 'Delivered',        next: null, nextLabel: null, nextColor: null },
  rejected:   { color: '#DC2626', bg: '#FEE2E2', label: 'Rejected',         next: null, nextLabel: null, nextColor: null },
  cancelled:  { color: '#6B7280', bg: '#F3F4F6', label: 'Cancelled',        next: null, nextLabel: null, nextColor: null },
};

const ACTION_TITLES = {
  approve: 'Approve Order', preparing: 'Mark as Preparing', dispatch: 'Mark as Dispatched',
  deliver: 'Mark as Delivered', reject: 'Reject Order',
};

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function PrescriptionOrders() {
  const [tab, setTab] = useState('pending');
  const [orders, setOrders] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const [modal, setModal] = useState(null); // { orderId, action, patient, medication }
  const [pharmacyName, setPharmacyName] = useState('');
  const [doctorNote, setDoctorNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    setLoading(true);
    api.get('/doctor/prescription-orders', { params: { tab } })
      .then(r => { setOrders(r.data.orders); setPendingCount(r.data.pendingCount); })
      .finally(() => setLoading(false));
  };

  useEffect(load, [tab]);

  const openModal = (orderId, action, patient, medication) => {
    setModal({ orderId, action, patient, medication });
    setPharmacyName('');
    setDoctorNote('');
  };

  const submitAction = async () => {
    setSubmitting(true);
    try {
      const r = await api.put('/doctor/prescription-orders', {
        action: modal.action, order_id: modal.orderId,
        doctor_notes: doctorNote, pharmacy_name: pharmacyName,
      });
      if (r.data.success) {
        setModal(null);
        load();
      }
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to update order');
    } finally { setSubmitting(false); }
  };

  const initials = (name) => name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, background: '#fff', borderRadius: 10, padding: 5, border: '1px solid var(--border)', marginBottom: 20, width: 'fit-content' }}>
        <button onClick={() => setTab('pending')}
          style={{
            padding: '8px 18px', borderRadius: 7, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'inherit',
            background: tab === 'pending' ? 'var(--primary-light)' : 'transparent',
            color: tab === 'pending' ? '#fff' : 'var(--text-muted)',
          }}>
          <i className="fas fa-clock" /> Active Orders
          {pendingCount > 0 && <span style={{ background: '#DC2626', color: '#fff', borderRadius: 20, padding: '1px 7px', fontSize: 10 }}>{pendingCount}</span>}
        </button>
        <button onClick={() => setTab('history')}
          style={{
            padding: '8px 18px', borderRadius: 7, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'inherit',
            background: tab === 'history' ? 'var(--primary-light)' : 'transparent',
            color: tab === 'history' ? '#fff' : 'var(--text-muted)',
          }}>
          <i className="fas fa-history" /> Completed
        </button>
      </div>

      {loading ? <div className="loading"><div className="spinner" /></div> : (
        !orders.length ? (
          <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>
            <i className="fas fa-clipboard-check" style={{ fontSize: 48, opacity: .2, display: 'block', marginBottom: 16 }} />
            <p>{tab === 'pending' ? 'No active prescription orders from patients.' : 'No completed orders yet.'}</p>
          </div>
        ) : orders.map(o => {
          const sc = STATUS_CONFIG[o.status] || STATUS_CONFIG.pending;
          return (
            <div key={o.id} className="card mb-3" style={{ borderLeft: `4px solid ${sc.color}` }}>
              <div className="card-body" style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                <div className="user-avatar" style={{ width: 44, height: 44, fontSize: 16, flexShrink: 0 }}>
                  {initials(o.patient_name)}
                </div>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontWeight: 800, fontSize: 15 }}>{o.patient_name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    NHS: {o.nhs_id} · {o.date_of_birth ? new Date(o.date_of_birth).toLocaleDateString('en-GB') : '—'}
                  </div>
                  <div style={{ marginTop: 8, background: 'var(--bg)', borderRadius: 8, padding: '10px 14px', display: 'inline-block' }}>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>💊 {o.medication_name}</span>
                    <span style={{ fontSize: 13, color: 'var(--primary-light)', marginLeft: 8, fontWeight: 600 }}>{o.dosage}</span>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
                      {o.frequency}{o.instructions ? ` · ${o.instructions}` : ''}
                    </div>
                  </div>
                  {o.delivery_method === 'delivery' ? (
                    <div style={{ marginTop: 6, fontSize: 12, color: '#7C3AED', fontWeight: 600 }}>
                      <i className="fas fa-truck" /> Home delivery{o.delivery_address ? ` — ${o.delivery_address}` : ''}
                    </div>
                  ) : (
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--primary-light)', fontWeight: 600 }}>
                      <i className="fas fa-store" /> Collection from pharmacy
                    </div>
                  )}
                  {o.patient_notes && (
                    <div style={{ marginTop: 8, background: '#FEF3C7', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#92400E' }}>
                      <i className="fas fa-comment" /> Patient note: {o.patient_notes}
                    </div>
                  )}
                  {o.doctor_notes && (
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                      <i className="fas fa-comment-medical" /> Your note: {o.doctor_notes}
                    </div>
                  )}
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 160 }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: sc.bg, color: sc.color, padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>
                    {sc.label}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>{timeAgo(o.ordered_at)}</div>
                  {sc.next && (
                    <button onClick={() => openModal(o.id, sc.next, o.patient_name, o.medication_name)}
                      style={{ background: sc.nextColor, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer', marginBottom: 6, display: 'block', width: '100%' }}>
                      {sc.nextLabel}
                    </button>
                  )}
                  {o.status === 'pending' && (
                    <button onClick={() => openModal(o.id, 'reject', o.patient_name, o.medication_name)}
                      style={{ background: '#FEE2E2', color: '#DC2626', border: '1px solid #FECACA', borderRadius: 8, padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', width: '100%' }}>
                      Reject
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })
      )}

      {/* Action Modal */}
      {modal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setModal(null); }}>
          <div className="modal" style={{ maxWidth: 420 }}>
            <div className="modal-header" style={{ background: 'var(--primary)', color: '#fff' }}>
              <div>
                <h3 style={{ margin: 0 }}>{ACTION_TITLES[modal.action] || 'Update Order'}</h3>
                <div style={{ fontSize: 12, opacity: .7, marginTop: 3 }}>{modal.patient} — {modal.medication}</div>
              </div>
              <button className="modal-close" style={{ color: '#fff' }} onClick={() => setModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              {['preparing', 'dispatch', 'deliver'].includes(modal.action) && (
                <div className="form-group">
                  <label className="form-label">Pharmacy Name (optional)</label>
                  <input className="form-control" placeholder="e.g. Boots Pharmacy, Leicester"
                    value={pharmacyName} onChange={e => setPharmacyName(e.target.value)} />
                </div>
              )}
              <div className="form-group">
                <label className="form-label">Note to patient (optional)</label>
                <textarea className="form-control" rows={2}
                  placeholder={modal.action === 'reject' ? 'Reason for rejection...' : 'Note to patient (optional)...'}
                  value={doctorNote} onChange={e => setDoctorNote(e.target.value)} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={submitting} onClick={submitAction}>
                {submitting ? 'Updating...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
