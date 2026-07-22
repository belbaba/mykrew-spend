import React, { useEffect, useState, useRef } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, updatePassword, User } from 'firebase/auth'
import { collection, onSnapshot, orderBy, query, where, addDoc, updateDoc, doc, getDoc, getDocs, setDoc, Timestamp } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { auth, db, storage, functions } from './services/firebase'
import type { Expense, ExpenseCategory, ExpenseStatus, Comment, BudgetLimit } from './types'
import { CATEGORY_LABELS, CATEGORY_ICONS, VAT_RATES } from './types'
import app from './services/firebase'

// === Status Badge ================================================================
const STATUS_CONFIG: Record<ExpenseStatus, { label: string; color: string; bg: string }> = {
  pending: { label: 'En attente', color: '#fbbf24', bg: 'rgba(251,191,36,0.15)' },
  approved: { label: 'Approuvee', color: '#4ade80', bg: 'rgba(74,222,128,0.15)' },
  rejected: { label: 'Refusee', color: '#f87171', bg: 'rgba(248,113,113,0.15)' },
  reimbursed: { label: 'Remboursee', color: '#6366f1', bg: 'rgba(16,185,129,0.12)' },
  cancelled: { label: 'Annulee', color: '#9ca3af', bg: 'rgba(156,163,175,0.15)' },
  self_approved: { label: 'Auto-approuvee', color: '#60a5fa', bg: 'rgba(96,165,250,0.15)' },
}

function StatusBadge({ status }: { status: ExpenseStatus }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.pending
  return (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium" style={{ color: cfg.color, backgroundColor: cfg.bg }}>
      {cfg.label}
    </span>
  )
}

function CategoryBadge({ category }: { category: ExpenseCategory }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-gray-600">
      <span>{CATEGORY_ICONS[category]}</span>
      <span>{CATEGORY_LABELS[category]}</span>
    </span>
  )
}

// === Photo Modal =================================================================
function PhotoModal({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="relative max-w-full max-h-full" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="absolute -top-10 right-0 text-white text-2xl font-bold hover:text-gray-300">✕</button>
        <img src={url} alt="Justificatif" className="max-w-full max-h-[85vh] rounded-lg object-contain" />
      </div>
    </div>
  )
}

// === PDF Export Helper ============================================================
function generatePDF(expenses: Expense[], title: string, filterMonth: string) {
  const month = filterMonth || new Date().toISOString().slice(0, 7)
  const totalTTC = expenses.reduce((s, e) => s + e.amountTTC, 0)
  const totalHT = expenses.reduce((s, e) => s + (e.amountHT || 0), 0)
  const totalVAT = expenses.reduce((s, e) => s + (e.vatAmount || 0), 0)

  const byCategory = Object.keys(CATEGORY_LABELS).map(cat => ({
    category: cat as ExpenseCategory,
    label: CATEGORY_LABELS[cat as ExpenseCategory],
    total: expenses.filter(e => e.category === cat).reduce((s, e) => s + e.amountTTC, 0),
    count: expenses.filter(e => e.category === cat).length,
  })).filter(c => c.total > 0)

  const rows = expenses.map(exp => {
    const d = exp.date instanceof Date ? exp.date.toLocaleDateString('fr-FR') : ''
    return `<tr>
      <td style="padding:6px 8px;border:1px solid #ddd;font-size:11px;">${d}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;font-size:11px;">${exp.employeeName}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;font-size:11px;">${CATEGORY_LABELS[exp.category]}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;font-size:11px;">${exp.location}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;font-size:11px;">${exp.description}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;font-size:11px;text-align:right;">${(exp.amountHT || 0).toFixed(2)}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;font-size:11px;text-align:right;">${(exp.vatAmount || 0).toFixed(2)}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;font-size:11px;text-align:right;font-weight:bold;">${exp.amountTTC.toFixed(2)}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;font-size:11px;">${STATUS_CONFIG[exp.status]?.label || exp.status}</td>
    </tr>`
  }).join('')

  const categoryRows = byCategory.map(c => `<tr>
    <td style="padding:4px 8px;border:1px solid #ddd;">${CATEGORY_ICONS[c.category]} ${c.label}</td>
    <td style="padding:4px 8px;border:1px solid #ddd;text-align:center;">${c.count}</td>
    <td style="padding:4px 8px;border:1px solid #ddd;text-align:right;font-weight:bold;">${c.total.toFixed(2)} EUR</td>
  </tr>`).join('')

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
    <style>body{font-family:-apple-system,sans-serif;padding:40px;color:#333;}
    h1{color:#7c3aed;margin-bottom:4px;} table{width:100%;border-collapse:collapse;margin:16px 0;}
    th{background:#7c3aed;color:white;padding:8px;text-align:left;font-size:11px;}
    .summary{display:flex;gap:24px;margin:16px 0;} .summary-item{background:#f8f9fa;padding:12px 16px;border-radius:8px;}
    .summary-item strong{display:block;font-size:18px;color:#7c3aed;}</style></head>
    <body><h1>MyKrew Spend</h1><p style="color:#666;">Recapitulatif des notes de frais — ${month}</p>
    <div class="summary"><div class="summary-item"><span>Total TTC</span><strong>${totalTTC.toFixed(2)} EUR</strong></div>
    <div class="summary-item"><span>Total HT</span><strong>${totalHT.toFixed(2)} EUR</strong></div>
    <div class="summary-item"><span>TVA</span><strong>${totalVAT.toFixed(2)} EUR</strong></div>
    <div class="summary-item"><span>Nombre</span><strong>${expenses.length}</strong></div></div>
    <h3>Par categorie</h3><table><tr><th>Categorie</th><th>Nombre</th><th>Total</th></tr>${categoryRows}</table>
    <h3>Detail des depenses</h3><table><tr><th>Date</th><th>Employe</th><th>Categorie</th><th>Lieu</th><th>Description</th><th>HT</th><th>TVA</th><th>TTC</th><th>Statut</th></tr>${rows}</table>
    <p style="color:#999;font-size:10px;margin-top:24px;">Genere par MyKrew Spend le ${new Date().toLocaleDateString('fr-FR')}</p></body></html>`

  const printWindow = window.open('', '_blank')
  if (printWindow) {
    printWindow.document.write(html)
    printWindow.document.close()
    printWindow.print()
  }
}

// === Push Notification Registration ==============================================
async function registerPushNotifications() {
  try {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return

    const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY
    if (!vapidKey) return

    const { getMessaging, getToken } = await import('firebase/messaging')
    const messaging = getMessaging(app)
    const token = await getToken(messaging, { vapidKey })
    if (token) {
      const registerFn = httpsCallable(functions, 'registerPushToken')
      await registerFn({ token })
    }
  } catch (err) {
    console.warn('Push notifications non disponibles:', err)
  }
}

// === Add Employee Form ============================================================
interface AddEmployeeProps { onBack: () => void }

function AddEmployeeForm({ onBack }: AddEmployeeProps) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<'employee' | 'manager'>('employee')
  const [department, setDepartment] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!firstName.trim() || !lastName.trim() || !email.trim() || !password.trim()) {
      setError('Tous les champs obligatoires doivent etre remplis.')
      return
    }
    if (password.length < 8) { setError('Le mot de passe doit contenir au moins 8 caracteres.'); return }
    setIsSubmitting(true)
    try {
      // Force refresh du token pour s'assurer qu'il est valide pour ce projet
      if (auth.currentUser) {
        await auth.currentUser.getIdToken(true)
      }
      const createEmployee = httpsCallable(functions, 'createEmployee')
      await createEmployee({ email: email.toLowerCase(), password, firstName: firstName.trim(), lastName: lastName.trim(), role, department: department.trim() })
      setSuccess(true)
    } catch (err: unknown) {
      const error = err as { message?: string }
      if (error.message?.includes('already-exists') || error.message?.includes('email-already')) setError('Un compte avec cet email existe deja.')
      else if (error.message?.includes('resource-exhausted')) setError('Limite de 40 utilisateurs actifs atteinte.')
      else setError(error.message || 'Erreur lors de la creation du compte.')
    } finally { setIsSubmitting(false) }
  }

  if (success) {
    return (
      <div className="p-4 flex flex-col items-center justify-center min-h-[60vh] text-center">
        <div className="text-5xl mb-4">✅</div>
        <h2 className="text-xl font-bold text-gray-900 mb-2">Membre ajoute !</h2>
        <p className="text-gray-600 mb-2"><strong>{firstName} {lastName}</strong> peut maintenant se connecter avec :</p>
        <p className="text-sm text-gray-500 bg-gray-100 px-4 py-2 rounded-lg mb-6">{email}</p>
        <div className="flex gap-3">
          <button onClick={() => { setSuccess(false); setFirstName(''); setLastName(''); setEmail(''); setPassword(''); setDepartment('') }} className="border border-gray-300 text-gray-700 px-5 py-2.5 rounded-lg font-medium">Ajouter un autre</button>
          <button onClick={onBack} className="bg-indigo-500 text-white px-5 py-2.5 rounded-lg font-medium">Retour</button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-6">
      <button onClick={onBack} className="text-indigo-500 text-sm font-medium">← Retour</button>
      <div><h1 className="text-xl font-bold text-gray-900">Ajouter un membre</h1><p className="text-sm text-gray-500 mt-1">Creez un compte pour un nouveau membre</p></div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div><label className="block text-sm font-medium text-gray-700 mb-1">Prenom *</label><input type="text" value={firstName} onChange={e => setFirstName(e.target.value)} className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:border-indigo-500 focus:outline-none" placeholder="Jean" required /></div>
          <div><label className="block text-sm font-medium text-gray-700 mb-1">Nom *</label><input type="text" value={lastName} onChange={e => setLastName(e.target.value)} className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:border-indigo-500 focus:outline-none" placeholder="Dupont" required /></div>
        </div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1">Email *</label><input type="email" value={email} onChange={e => setEmail(e.target.value)} className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:border-indigo-500 focus:outline-none" placeholder="jean.dupont@entreprise.com" required /></div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1">Departement</label><input type="text" value={department} onChange={e => setDepartment(e.target.value)} className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:border-indigo-500 focus:outline-none" placeholder="Marketing, Technique..." /></div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Role</label>
          <div className="flex gap-3">
            <button type="button" onClick={() => setRole('employee')} className={`flex-1 py-2.5 rounded-lg text-sm font-medium border transition-colors ${role === 'employee' ? 'bg-indigo-500 text-white border-indigo-500' : 'bg-white text-gray-700 border-gray-300'}`}>Employe</button>
            <button type="button" onClick={() => setRole('manager')} className={`flex-1 py-2.5 rounded-lg text-sm font-medium border transition-colors ${role === 'manager' ? 'bg-indigo-500 text-white border-indigo-500' : 'bg-white text-gray-700 border-gray-300'}`}>Responsable</button>
          </div>
        </div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1">Mot de passe initial *</label><input type="text" value={password} onChange={e => setPassword(e.target.value)} className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:border-indigo-500 focus:outline-none" placeholder="Minimum 8 caracteres" required /><p className="text-xs text-gray-400 mt-1">L'employe pourra le changer plus tard</p></div>
        {error && <div className="bg-red-50 text-red-700 text-sm p-3 rounded-lg">{error}</div>}
        <button type="submit" disabled={isSubmitting} className="w-full bg-indigo-500 text-white py-3.5 rounded-2xl font-semibold shadow-lg shadow-indigo-200 disabled:opacity-50 transition-all hover:bg-indigo-600">{isSubmitting ? 'Creation...' : 'Creer le compte'}</button>
      </form>
    </div>
  )
}

// === Team List ====================================================================
interface TeamMember { uid: string; email: string; firstName: string; lastName: string; role: 'manager' | 'employee'; department?: string; isActive: boolean }

function TeamList({ onBack, onAddEmployee, onViewEmployeeExpenses }: { onBack: () => void; onAddEmployee: () => void; onViewEmployeeExpenses: (e: TeamMember) => void }) {
  const [members, setMembers] = useState<TeamMember[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => {
    const q = query(collection(db, 'users'), where('isActive', '==', true))
    const unsub = onSnapshot(q, (snap) => { setMembers(snap.docs.map(d => ({ uid: d.id, ...d.data() } as TeamMember)).sort((a, b) => a.lastName.localeCompare(b.lastName))); setLoading(false) })
    return () => unsub()
  }, [])

  const handleDelete = async (member: TeamMember) => {
    if (!confirm(`Supprimer ${member.firstName} ${member.lastName} ?`)) return
    setDeletingId(member.uid)
    try { await httpsCallable(functions, 'deleteEmployee')({ employeeId: member.uid }) } catch (err) { alert('Erreur lors de la suppression') }
    setDeletingId(null)
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-bold text-gray-900">Equipe</h1><p className="text-sm text-gray-500">{members.length} membre(s)</p></div>
        <button onClick={onAddEmployee} className="bg-indigo-500 text-white text-sm font-medium px-3 py-2 rounded-lg hover:bg-indigo-600">+ Ajouter</button>
      </div>
      {loading ? <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-16 bg-gray-100 rounded-xl animate-pulse" />)}</div> : members.length === 0 ? (
        <div className="text-center py-12"><p className="text-4xl mb-2">👥</p><p className="text-gray-400">Aucun membre</p></div>
      ) : (
        <div className="space-y-3">{members.map(m => (
          <div key={m.uid} className="p-4 rounded-xl bg-white border border-gray-200 shadow-sm">
            <div className="flex items-center justify-between">
              <button onClick={() => onViewEmployeeExpenses(m)} className="flex-1 text-left">
                <p className="font-medium text-gray-900">{m.firstName} {m.lastName}</p>
                <p className="text-xs text-gray-500">{m.email}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${m.role === 'manager' ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600'}`}>{m.role === 'manager' ? 'Responsable' : 'Employe'}</span>
                  {m.department && <span className="text-xs text-gray-400">{m.department}</span>}
                </div>
              </button>
              <div className="flex items-center gap-2 ml-3">
                <button onClick={() => onViewEmployeeExpenses(m)} className="text-indigo-500 text-xs px-2 py-1 rounded border border-indigo-200">💸</button>
                <button onClick={() => handleDelete(m)} disabled={deletingId === m.uid} className="text-red-400 text-xs px-2 py-1 rounded border border-red-200 disabled:opacity-50">{deletingId === m.uid ? '...' : '🗑️'}</button>
              </div>
            </div>
          </div>
        ))}</div>
      )}
    </div>
  )
}

// === Employee Expenses View (with stats graph) ===================================
function EmployeeExpensesView({ employee, onBack }: { employee: TeamMember; onBack: () => void }) {
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [loading, setLoading] = useState(true)
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [filterMonth, setFilterMonth] = useState(new Date().toISOString().slice(0, 7))
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [showStats, setShowStats] = useState(false)

  useEffect(() => {
    const q = query(collection(db, 'expenses'), where('employeeId', '==', employee.uid), orderBy('createdAt', 'desc'))
    const unsub = onSnapshot(q, (snap) => { setExpenses(snap.docs.map(d => { const data = d.data(); return { id: d.id, ...data, amountTTC: data.amountTTC || data.amount || 0, date: data.date?.toDate?.() || new Date(), createdAt: data.createdAt?.toDate?.() || new Date(), updatedAt: data.updatedAt?.toDate?.() || new Date() } }) as Expense[]); setLoading(false) })
    return () => unsub()
  }, [employee.uid])

  const handleDeleteExpense = async (expenseId: string) => {
    if (!confirm('Supprimer cette note de frais ?')) return
    setDeletingId(expenseId)
    try { await httpsCallable(functions, 'deleteExpense')({ expenseId }) } catch { alert('Erreur suppression') }
    setDeletingId(null)
  }

  const filteredExpenses = expenses.filter(exp => {
    if (!filterMonth) return true
    const d = exp.date instanceof Date ? exp.date : new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === filterMonth
  })

  const totalTTC = filteredExpenses.reduce((s, e) => s + e.amountTTC, 0)
  const approvedTotal = filteredExpenses.filter(e => ['approved', 'reimbursed', 'self_approved'].includes(e.status)).reduce((s, e) => s + e.amountTTC, 0)

  // Stats by month (last 6 months)
  const monthlyStats = () => {
    const stats: { month: string; total: number }[] = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setMonth(d.getMonth() - i)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      const total = expenses.filter(e => { const ed = e.date instanceof Date ? e.date : new Date(); return `${ed.getFullYear()}-${String(ed.getMonth() + 1).padStart(2, '0')}` === key }).reduce((s, e) => s + e.amountTTC, 0)
      stats.push({ month: d.toLocaleDateString('fr-FR', { month: 'short' }), total })
    }
    return stats
  }

  const categoryStats = () => Object.keys(CATEGORY_LABELS).map(cat => ({
    category: cat as ExpenseCategory, total: filteredExpenses.filter(e => e.category === cat).reduce((s, e) => s + e.amountTTC, 0)
  })).filter(c => c.total > 0).sort((a, b) => b.total - a.total)

  return (
    <div className="p-4 space-y-4">
      {photoUrl && <PhotoModal url={photoUrl} onClose={() => setPhotoUrl(null)} />}
      <button onClick={onBack} className="text-indigo-500 text-sm font-medium">← Retour</button>
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-bold text-gray-900">{employee.firstName} {employee.lastName}</h1><p className="text-sm text-gray-500">{employee.email}</p></div>
        <button onClick={() => setShowStats(!showStats)} className="text-xs px-3 py-1.5 rounded-lg border border-indigo-200 text-indigo-600">{showStats ? 'Liste' : '📊 Stats'}</button>
      </div>
      <div className="flex items-center gap-3">
        <input type="month" value={filterMonth} onChange={e => setFilterMonth(e.target.value)} className="px-3 py-2 rounded-lg bg-white text-gray-900 border border-gray-200 text-sm focus:border-indigo-500 focus:outline-none" />
        <button onClick={() => setFilterMonth('')} className="text-xs text-gray-400 hover:text-gray-600">Tout</button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 rounded-xl bg-white border border-gray-200 shadow-sm"><p className="text-xs text-gray-400">Total</p><p className="text-lg font-bold text-gray-900">{totalTTC.toFixed(2)} EUR</p><p className="text-xs text-gray-400">{filteredExpenses.length} note(s)</p></div>
        <div className="p-3 rounded-xl bg-white border border-gray-200 shadow-sm"><p className="text-xs text-gray-400">Approuvees</p><p className="text-lg font-bold text-[#4ade80]">{approvedTotal.toFixed(2)} EUR</p></div>
      </div>

      {showStats ? (
        <div className="space-y-4">
          {/* Monthly bar chart */}
          <div className="p-4 rounded-xl bg-white border border-gray-200 shadow-sm">
            <p className="text-sm text-gray-500 mb-3">Depenses par mois (6 derniers mois)</p>
            <div className="flex items-end gap-2 h-32">
              {monthlyStats().map((m, i) => {
                const maxVal = Math.max(...monthlyStats().map(s => s.total), 1)
                const height = (m.total / maxVal) * 100
                return (<div key={i} className="flex-1 flex flex-col items-center gap-1">
                  <span className="text-xs text-gray-500">{m.total > 0 ? `${m.total.toFixed(0)}` : ''}</span>
                  <div className="w-full rounded-t-md bg-indigo-500" style={{ height: `${Math.max(height, 2)}%` }} />
                  <span className="text-xs text-gray-400">{m.month}</span>
                </div>)
              })}
            </div>
          </div>
          {/* Category breakdown */}
          <div className="p-4 rounded-xl bg-white border border-gray-200 shadow-sm">
            <p className="text-sm text-gray-500 mb-3">Par categorie</p>
            <div className="space-y-2">{categoryStats().map(c => {
              const maxCat = Math.max(...categoryStats().map(s => s.total), 1)
              return (<div key={c.category} className="flex items-center gap-2">
                <span className="text-xs w-24 truncate">{CATEGORY_ICONS[c.category]} {CATEGORY_LABELS[c.category]}</span>
                <div className="flex-1 h-4 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-indigo-500 rounded-full" style={{ width: `${(c.total / maxCat) * 100}%` }} /></div>
                <span className="text-xs text-gray-700 font-medium w-16 text-right">{c.total.toFixed(0)} EUR</span>
              </div>)
            })}</div>
          </div>
        </div>
      ) : (
        <>
          {loading ? <div className="text-center py-12"><div className="w-8 h-8 border-4 border-[#6366f1] border-t-transparent rounded-full animate-spin mx-auto" /></div> : filteredExpenses.length === 0 ? (
            <div className="text-center py-12"><p className="text-4xl mb-2">📋</p><p className="text-gray-400">Aucune depense</p></div>
          ) : (
            <div className="space-y-3 pb-6">{filteredExpenses.map(exp => (
              <div key={exp.id} className="p-4 rounded-xl bg-white border border-gray-200 shadow-sm">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1"><StatusBadge status={exp.status} /><CategoryBadge category={exp.category} /></div>
                    <p className="text-gray-900 font-medium text-sm truncate">{exp.description}</p>
                    <p className="text-gray-400 text-xs mt-0.5">{exp.location} • {exp.date instanceof Date ? exp.date.toLocaleDateString('fr-FR') : ''}</p>
                  </div>
                  <div className="text-right ml-3">
                    <p className="text-gray-900 font-bold text-sm">{exp.amountTTC.toFixed(2)} EUR</p>
                    {exp.receiptUrl && <button onClick={() => setPhotoUrl(exp.receiptUrl!)} className="text-indigo-600 text-xs mt-1 hover:underline">📷</button>}
                  </div>
                </div>
                {['approved', 'reimbursed', 'self_approved'].includes(exp.status) && (
                  <button onClick={() => handleDeleteExpense(exp.id)} disabled={deletingId === exp.id} className="mt-3 w-full py-2 rounded-lg text-xs font-medium bg-red-500/10 text-red-500 hover:bg-red-500/20 disabled:opacity-50">{deletingId === exp.id ? 'Suppression...' : '🗑️ Supprimer'}</button>
                )}
              </div>
            ))}</div>
          )}
        </>
      )}
    </div>
  )
}

// === Budget Limits Manager ========================================================
function BudgetLimitsView({ onBack }: { onBack: () => void }) {
  const [limits, setLimits] = useState<(BudgetLimit & { id?: string })[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'budgetLimits'), (snap) => {
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() })) as (BudgetLimit & { id?: string })[]
      // Fill missing categories
      const all = Object.keys(CATEGORY_LABELS).map(cat => {
        const existing = data.find(d => d.category === cat)
        return existing || { category: cat as ExpenseCategory, monthlyLimit: 0, isActive: false }
      })
      setLimits(all)
      setLoading(false)
    })
    return () => unsub()
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      for (const limit of limits) {
        await setDoc(doc(db, 'budgetLimits', limit.category), { category: limit.category, monthlyLimit: limit.monthlyLimit, isActive: limit.isActive })
      }
    } catch (err) { console.error(err) }
    setSaving(false)
  }

  const updateLimit = (cat: ExpenseCategory, field: 'monthlyLimit' | 'isActive', value: number | boolean) => {
    setLimits(prev => prev.map(l => l.category === cat ? { ...l, [field]: value } : l))
  }

  return (
    <div className="p-4 space-y-4">
      <button onClick={onBack} className="text-indigo-500 text-sm font-medium">← Retour</button>
      <div><h1 className="text-xl font-bold text-gray-900">Plafonds mensuels</h1><p className="text-sm text-gray-500">Definir des alertes par categorie</p></div>
      {loading ? <div className="animate-pulse space-y-3">{[1,2,3].map(i => <div key={i} className="h-12 bg-gray-100 rounded-xl" />)}</div> : (
        <div className="space-y-3">
          {limits.map(limit => (
            <div key={limit.category} className="p-3 rounded-xl bg-white border border-gray-200 shadow-sm flex items-center gap-3">
              <button onClick={() => updateLimit(limit.category, 'isActive', !limit.isActive)} className={`w-10 h-6 rounded-full transition-colors ${limit.isActive ? 'bg-indigo-500' : 'bg-gray-300'}`}>
                <div className={`w-4 h-4 bg-white rounded-full transition-transform mx-1 ${limit.isActive ? 'translate-x-4' : ''}`} />
              </button>
              <span className="text-sm flex-1">{CATEGORY_ICONS[limit.category]} {CATEGORY_LABELS[limit.category]}</span>
              <input type="number" min="0" step="50" value={limit.monthlyLimit || ''} onChange={e => updateLimit(limit.category, 'monthlyLimit', parseFloat(e.target.value) || 0)} placeholder="0" className="w-24 px-2 py-1.5 text-sm border border-gray-200 rounded-lg text-right focus:border-indigo-500 focus:outline-none" />
              <span className="text-xs text-gray-400">EUR</span>
            </div>
          ))}
          <button onClick={handleSave} disabled={saving} className="w-full bg-indigo-500 text-white py-3 rounded-xl font-semibold disabled:opacity-50 hover:bg-indigo-600">{saving ? 'Enregistrement...' : 'Enregistrer les plafonds'}</button>
        </div>
      )}
    </div>
  )
}

// === Comments / Timeline Component ================================================
function ExpenseComments({ expenseId, isManager }: { expenseId: string; isManager: boolean }) {
  const [comments, setComments] = useState<Comment[]>([])
  const [newComment, setNewComment] = useState('')
  const [sending, setSending] = useState(false)
  const [showComments, setShowComments] = useState(false)

  useEffect(() => {
    if (!showComments) return
    const q = query(collection(db, 'expenses', expenseId, 'comments'), orderBy('createdAt', 'desc'))
    const unsub = onSnapshot(q, (snap) => {
      setComments(snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.() || new Date() })) as Comment[])
    })
    return () => unsub()
  }, [expenseId, showComments])

  const handleSend = async () => {
    if (!newComment.trim()) return
    setSending(true)
    try {
      await httpsCallable(functions, 'addComment')({ expenseId, text: newComment.trim() })
      setNewComment('')
    } catch (err) { console.error(err) }
    setSending(false)
  }

  return (
    <div className="mt-2">
      <button onClick={() => setShowComments(!showComments)} className="text-xs text-indigo-500 hover:underline">
        💬 {showComments ? 'Masquer' : 'Commentaires'}
      </button>
      {showComments && (
        <div className="mt-2 space-y-2">
          {comments.length === 0 && <p className="text-xs text-gray-400">Aucun commentaire</p>}
          {comments.map(c => (
            <div key={c.id} className="bg-gray-50 rounded-lg p-2">
              <p className="text-xs font-medium text-gray-700">{c.authorName}</p>
              <p className="text-xs text-gray-600">{c.text}</p>
              <p className="text-xs text-gray-400 mt-0.5">{c.createdAt instanceof Date ? c.createdAt.toLocaleString('fr-FR') : ''}</p>
            </div>
          ))}
          {isManager && (
            <div className="flex gap-2">
              <input type="text" value={newComment} onChange={e => setNewComment(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSend()} placeholder="Ajouter un commentaire..." className="flex-1 px-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:border-indigo-500 focus:outline-none" />
              <button onClick={handleSend} disabled={sending || !newComment.trim()} className="px-3 py-1.5 text-xs bg-indigo-500 text-white rounded-lg disabled:opacity-50">Envoyer</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// === Activity Timeline ============================================================
function ActivityTimeline({ expenseId }: { expenseId: string }) {
  const [logs, setLogs] = useState<{ action: string; timestamp: Date; userId: string }[]>([])
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (!show) return
    const q = query(collection(db, 'activityLogs'), where('details.expenseId', '==', expenseId), orderBy('timestamp', 'desc'))
    getDocs(q).then(snap => {
      setLogs(snap.docs.map(d => ({ action: d.data().action, timestamp: d.data().timestamp?.toDate?.() || new Date(), userId: d.data().userId })))
    })
  }, [expenseId, show])

  const actionLabels: Record<string, string> = {
    expense_created: '📝 Creee',
    expense_decided: '⚖️ Decision prise',
    expense_deleted: '🗑️ Supprimee',
    comment_added: '💬 Commentaire',
  }

  return (
    <div className="mt-1">
      <button onClick={() => setShow(!show)} className="text-xs text-gray-400 hover:text-gray-600">🕐 Historique</button>
      {show && logs.length > 0 && (
        <div className="mt-2 space-y-1 border-l-2 border-gray-200 pl-3 ml-1">
          {logs.map((log, i) => (
            <div key={i} className="text-xs text-gray-500">
              <span className="font-medium">{actionLabels[log.action] || log.action}</span>
              <span className="ml-2">{log.timestamp.toLocaleString('fr-FR')}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// === Install Banner (PWA) =========================================================
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function InstallBanner() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [showIOSGuide, setShowIOSGuide] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  const isAndroid = /Android/.test(navigator.userAgent)
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches

  useEffect(() => {
    if (isStandalone || localStorage.getItem('install-dismissed')) return
    const handler = (e: Event) => { e.preventDefault(); setDeferredPrompt(e as BeforeInstallPromptEvent) }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [isStandalone])

  if (isStandalone || dismissed || localStorage.getItem('install-dismissed')) return null
  if (!deferredPrompt && !isIOS && !isAndroid) return null

  const handleInstall = async () => {
    if (deferredPrompt) {
      await deferredPrompt.prompt()
      const { outcome } = await deferredPrompt.userChoice
      if (outcome === 'accepted') setDeferredPrompt(null)
    }
  }

  const handleDismiss = () => { setDismissed(true); localStorage.setItem('install-dismissed', 'true') }

  return (
    <>

      {/* Bandeau Android/Desktop (Chrome) */}
      {deferredPrompt && (
        <div className="fixed bottom-16 left-4 right-4 z-40 max-w-lg mx-auto">
          <div className="rounded-2xl p-4 border border-indigo-100 shadow-xl bg-white">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-gray-900 font-medium text-sm">Installer MyKrew Spend</p>
                <p className="text-gray-500 text-xs mt-0.5">Accedez a l'app directement depuis votre ecran d'accueil</p>
              </div>
              <button onClick={handleDismiss} className="text-gray-400 hover:text-gray-600 p-1">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <button onClick={handleInstall} className="w-full mt-3 bg-indigo-500 text-white py-2.5 rounded-xl text-sm font-medium transition-colors shadow-lg shadow-indigo-500/20 hover:bg-indigo-600">Installer</button>
          </div>
        </div>
      )}

      {/* Bandeau iOS */}
      {isIOS && !deferredPrompt && (
        <div className="fixed bottom-16 left-4 right-4 z-40 max-w-lg mx-auto">
          <div className="rounded-2xl p-4 border border-indigo-100 shadow-xl bg-white">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-gray-900 font-medium text-sm">Installer MyKrew Spend</p>
                <p className="text-gray-500 text-xs mt-0.5">Pour un acces rapide depuis votre iPhone</p>
              </div>
              <button onClick={handleDismiss} className="text-gray-400 hover:text-gray-600 p-1">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            {!showIOSGuide ? (
              <button onClick={() => setShowIOSGuide(true)} className="w-full mt-3 bg-indigo-500 text-white py-2.5 rounded-xl text-sm font-medium transition-colors shadow-lg shadow-indigo-500/20 hover:bg-indigo-600">Comment installer sur iPhone ?</button>
            ) : (
              <div className="mt-3 space-y-2 text-sm">
                <div className="flex items-center gap-2 text-gray-600"><span className="w-6 h-6 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center text-xs font-bold shrink-0">1</span><span>Ouvrez cette page dans <strong className="text-gray-900">Safari</strong></span></div>
                <div className="flex items-center gap-2 text-gray-600"><span className="w-6 h-6 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center text-xs font-bold shrink-0">2</span><span>Appuyez sur <strong className="text-gray-900">Partager</strong> (icone ↑) en bas de l'ecran</span></div>
                <div className="flex items-center gap-2 text-gray-600"><span className="w-6 h-6 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center text-xs font-bold shrink-0">3</span><span>Appuyez sur <strong className="text-gray-900">"Sur l'ecran d'accueil"</strong></span></div>
                <div className="flex items-center gap-2 text-gray-600"><span className="w-6 h-6 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center text-xs font-bold shrink-0">4</span><span>Appuyez sur <strong className="text-gray-900">Ajouter</strong> en haut a droite</span></div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Bandeau Android (quand beforeinstallprompt n'est pas disponible) */}
      {isAndroid && !deferredPrompt && !isIOS && (
        <div className="fixed bottom-16 left-4 right-4 z-40 max-w-lg mx-auto">
          <div className="rounded-2xl p-4 border border-indigo-100 shadow-xl bg-white">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-gray-900 font-medium text-sm">Installer MyKrew Spend</p>
                <p className="text-gray-500 text-xs mt-0.5">Pour un acces rapide depuis votre Android</p>
              </div>
              <button onClick={handleDismiss} className="text-gray-400 hover:text-gray-600 p-1">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            {!showIOSGuide ? (
              <button onClick={() => setShowIOSGuide(true)} className="w-full mt-3 bg-indigo-500 text-white py-2.5 rounded-xl text-sm font-medium transition-colors shadow-lg shadow-indigo-500/20 hover:bg-indigo-600">Comment installer sur Android ?</button>
            ) : (
              <div className="mt-3 space-y-2 text-sm">
                <div className="flex items-center gap-2 text-gray-600"><span className="w-6 h-6 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center text-xs font-bold shrink-0">1</span><span>Ouvrez cette page dans <strong className="text-gray-900">Chrome</strong></span></div>
                <div className="flex items-center gap-2 text-gray-600"><span className="w-6 h-6 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center text-xs font-bold shrink-0">2</span><span>Appuyez sur le menu <strong className="text-gray-900">⋮</strong> (3 points) en haut a droite</span></div>
                <div className="flex items-center gap-2 text-gray-600"><span className="w-6 h-6 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center text-xs font-bold shrink-0">3</span><span>Appuyez sur <strong className="text-gray-900">"Ajouter a l'ecran d'accueil"</strong></span></div>
                <div className="flex items-center gap-2 text-gray-600"><span className="w-6 h-6 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center text-xs font-bold shrink-0">4</span><span>Appuyez sur <strong className="text-gray-900">Installer</strong></span></div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

// === Settings Page ================================================================
function SettingsPage({ userName, userEmail, onBack }: { userName: string; userEmail: string; onBack: () => void }) {
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(''); setSuccess('')
    if (newPassword.length < 8) { setError('Le mot de passe doit contenir au moins 8 caracteres'); return }
    if (newPassword !== confirmPassword) { setError('Les mots de passe ne correspondent pas'); return }
    setIsLoading(true)
    try {
      const user = auth.currentUser
      if (!user) throw new Error('Non connecte')
      await updatePassword(user, newPassword)
      setSuccess('Mot de passe modifie avec succes !')
      setNewPassword(''); setConfirmPassword('')
    } catch {
      setError('Erreur. Deconnectez-vous et reconnectez-vous avant de reessayer.')
    } finally { setIsLoading(false) }
  }

  return (
    <div className="min-h-screen">
      <div className="px-4 py-3 bg-white/80 backdrop-blur-md border-b border-gray-200/50 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-indigo-500 text-sm font-medium">← Retour</button>
          <h1 className="text-xl font-bold text-gray-900">Parametres</h1>
        </div>
      </div>
      <div className="p-4 space-y-6">
        <div className="bg-white rounded-2xl border border-gray-200 p-4 shadow-sm">
          <p className="text-sm text-gray-400 mb-1">Compte</p>
          <p className="font-medium text-gray-900">{userName}</p>
          <p className="text-sm text-gray-500">{userEmail}</p>
        </div>
        <form onSubmit={handleChangePassword} className="bg-white rounded-2xl border border-gray-200 p-4 shadow-sm space-y-4">
          <h2 className="text-base font-semibold text-gray-900">Changer le mot de passe</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Nouveau mot de passe</label>
            <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:border-indigo-500 focus:outline-none" placeholder="Minimum 8 caracteres" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Confirmer</label>
            <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:border-indigo-500 focus:outline-none" placeholder="Retapez le mot de passe" required />
          </div>
          {error && <div className="bg-red-50 text-red-700 text-sm p-3 rounded-xl">{error}</div>}
          {success && <div className="bg-green-50 text-green-700 text-sm p-3 rounded-xl">{success}</div>}
          <button type="submit" disabled={isLoading} className="w-full bg-indigo-500 text-white py-2.5 rounded-xl font-medium disabled:opacity-50 hover:bg-indigo-600">{isLoading ? 'Modification...' : 'Modifier le mot de passe'}</button>
        </form>
      </div>
    </div>
  )
}

// === Login Page ===================================================================
function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setLoading(true)
    try { await signInWithEmailAndPassword(auth, email, password); onLogin() }
    catch (err: any) {
      if (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password') setError('Email ou mot de passe incorrect')
      else if (err.code === 'auth/too-many-requests') setError('Trop de tentatives. Reessayez plus tard.')
      else setError('Erreur de connexion')
    } finally { setLoading(false) }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <img src="/logo.png" alt="MyKrew" className="h-44 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-indigo-500">Spend</h1>
          <p className="text-gray-400 text-sm mt-1">Gestion des notes de frais</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div><label className="block text-sm text-gray-400 mb-1">Email</label><input type="email" value={email} onChange={e => setEmail(e.target.value)} className="w-full px-4 py-3 rounded-xl bg-white text-gray-900 border border-gray-200 focus:border-indigo-500 focus:outline-none" placeholder="votre@email.com" required autoComplete="email" /></div>
          <div><label className="block text-sm text-gray-400 mb-1">Mot de passe</label><input type="password" value={password} onChange={e => setPassword(e.target.value)} className="w-full px-4 py-3 rounded-xl bg-white text-gray-900 border border-gray-200 focus:border-indigo-500 focus:outline-none" placeholder="••••••••" required autoComplete="current-password" /></div>
          {error && <p className="text-red-400 text-sm text-center bg-red-400/10 rounded-lg py-2">{error}</p>}
          <button type="submit" disabled={loading} className="w-full py-3 rounded-xl text-white font-semibold disabled:opacity-50 bg-indigo-500 hover:bg-indigo-600">{loading ? 'Connexion...' : 'Se connecter'}</button>
        </form>
      </div>
    </div>
  )
}

// === Expense Form (with multi-receipts & duplication) =============================
interface ExpenseFormProps {
  employeeId: string; employeeName: string; isManager: boolean; onSubmit: () => void; onCancel: () => void
  duplicateFrom?: Expense | null
}

function ExpenseForm({ employeeId, employeeName, isManager, onSubmit, onCancel, duplicateFrom }: ExpenseFormProps) {
  const [amountTTC, setAmountTTC] = useState(duplicateFrom?.amountTTC?.toString() || '')
  const [vatRate, setVatRate] = useState(duplicateFrom?.vatRate ?? 20)
  const [date, setDate] = useState(new Date().toISOString().split('T')[0])
  const [location, setLocation] = useState(duplicateFrom?.location || '')
  const [category, setCategory] = useState<ExpenseCategory>(duplicateFrom?.category || 'meal')
  const [description, setDescription] = useState(duplicateFrom?.description || '')
  const [project, setProject] = useState(duplicateFrom?.project || '')
  const [photos, setPhotos] = useState<File[]>([])
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const amountHT = amountTTC ? (parseFloat(amountTTC) / (1 + vatRate / 100)).toFixed(2) : '0.00'
  const vatAmount = amountTTC ? (parseFloat(amountTTC) - parseFloat(amountHT)).toFixed(2) : '0.00'

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    const newPhotos = [...photos, ...files].slice(0, 5) // max 5
    setPhotos(newPhotos)
    // Generate previews
    const previews: string[] = [...photoPreviews]
    files.forEach(file => {
      const reader = new FileReader()
      reader.onload = () => { previews.push(reader.result as string); setPhotoPreviews([...previews]) }
      reader.readAsDataURL(file)
    })
  }

  const removePhoto = (idx: number) => {
    setPhotos(photos.filter((_, i) => i !== idx))
    setPhotoPreviews(photoPreviews.filter((_, i) => i !== idx))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!amountTTC || !location || !description) { setError('Champs obligatoires manquants'); return }
    setError(''); setSubmitting(true)
    try {
      const ttc = parseFloat(amountTTC)
      const expenseData: any = {
        employeeId, employeeName, amountTTC: ttc, amountHT: parseFloat(amountHT), vatRate, vatAmount: parseFloat(vatAmount),
        date: Timestamp.fromDate(new Date(date)), location, category, description,
        status: isManager ? 'self_approved' : 'pending', createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
      }
      if (project.trim()) expenseData.project = project.trim()
      if (isManager) { expenseData.approvedAt = Timestamp.now(); expenseData.approvedBy = employeeId }

      const docRef = await addDoc(collection(db, 'expenses'), expenseData)

      // Upload multiple photos
      if (photos.length > 0) {
        const receipts: { url: string; path: string; name: string }[] = []
        for (let i = 0; i < photos.length; i++) {
          const photo = photos[i]
          const ext = photo.name.split('.').pop() || 'jpg'
          const storagePath = `expenses/${docRef.id}/receipt_${i}.${ext}`
          const storageRef = ref(storage, storagePath)
          await uploadBytes(storageRef, photo)
          const downloadUrl = await getDownloadURL(storageRef)
          receipts.push({ url: downloadUrl, path: storagePath, name: photo.name })
        }
        await updateDoc(doc(db, 'expenses', docRef.id), {
          receiptUrl: receipts[0].url, receiptPath: receipts[0].path, receipts,
        })
      }
      onSubmit()
    } catch (err: any) { setError('Erreur lors de la creation') }
    finally { setSubmitting(false) }
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-6">
        <button onClick={onCancel} className="flex items-center gap-2"><img src="/logo.png" alt="MyKrew" className="h-10" /><h2 className="text-xl font-bold text-gray-900">{duplicateFrom ? 'Dupliquer' : 'Nouvelle depense'}</h2></button>
        <button onClick={onCancel} className="text-indigo-500 hover:text-indigo-700 text-sm font-medium">← Retour</button>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div><label className="block text-sm text-gray-400 mb-1">Montant TTC (EUR) *</label><input type="number" step="0.01" min="0.01" value={amountTTC} onChange={e => setAmountTTC(e.target.value)} className="w-full px-4 py-3 rounded-xl bg-white text-gray-900 border border-gray-200 focus:border-indigo-500 focus:outline-none" placeholder="0.00" required /></div>
        <div><label className="block text-sm text-gray-400 mb-1">Taux de TVA</label><select value={vatRate} onChange={e => setVatRate(parseFloat(e.target.value))} className="w-full px-4 py-3 rounded-xl bg-white text-gray-900 border border-gray-200 focus:border-indigo-500 focus:outline-none">{VAT_RATES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}</select></div>
        <div className="grid grid-cols-2 gap-3">
          <div className="px-3 py-2 rounded-lg bg-gray-50 border border-gray-200"><p className="text-xs text-gray-400">HT</p><p className="text-gray-900 font-medium">{amountHT} EUR</p></div>
          <div className="px-3 py-2 rounded-lg bg-gray-50 border border-gray-200"><p className="text-xs text-gray-400">TVA</p><p className="text-gray-900 font-medium">{vatAmount} EUR</p></div>
        </div>
        <div><label className="block text-sm text-gray-400 mb-1">Date *</label><input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-full px-4 py-3 rounded-xl bg-white text-gray-900 border border-gray-200 focus:border-indigo-500 focus:outline-none" required /></div>
        <div><label className="block text-sm text-gray-400 mb-1">Lieu *</label><input type="text" value={location} onChange={e => setLocation(e.target.value)} className="w-full px-4 py-3 rounded-xl bg-white text-gray-900 border border-gray-200 focus:border-indigo-500 focus:outline-none" placeholder="Restaurant, Gare..." required /></div>
        <div><label className="block text-sm text-gray-400 mb-1">Categorie *</label><select value={category} onChange={e => setCategory(e.target.value as ExpenseCategory)} className="w-full px-4 py-3 rounded-xl bg-white text-gray-900 border border-gray-200 focus:border-indigo-500 focus:outline-none">{Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{CATEGORY_ICONS[k as ExpenseCategory]} {v}</option>)}</select></div>
        <div><label className="block text-sm text-gray-400 mb-1">Description *</label><textarea value={description} onChange={e => setDescription(e.target.value)} className="w-full px-4 py-3 rounded-xl bg-white text-gray-900 border border-gray-200 focus:border-indigo-500 focus:outline-none resize-none" rows={2} placeholder="Dejeuner equipe..." required /></div>
        <div><label className="block text-sm text-gray-400 mb-1">Projet (optionnel)</label><input type="text" value={project} onChange={e => setProject(e.target.value)} className="w-full px-4 py-3 rounded-xl bg-white text-gray-900 border border-gray-200 focus:border-indigo-500 focus:outline-none" placeholder="Nom du projet" /></div>
        {/* Multi-photo upload */}
        <div>
          <label className="block text-sm text-gray-400 mb-1">Justificatifs ({photos.length}/5)</label>
          <input ref={fileInputRef} type="file" accept="image/*" capture="environment" onChange={handlePhotoChange} className="hidden" multiple />
          <button type="button" onClick={() => fileInputRef.current?.click()} className="w-full py-3 rounded-xl border-2 border-dashed border-gray-300 text-gray-400 hover:border-[#6366f1] hover:text-indigo-600 transition-colors">📷 {photos.length > 0 ? 'Ajouter une photo' : 'Ajouter un justificatif'}</button>
          {photoPreviews.length > 0 && (
            <div className="mt-3 flex gap-2 overflow-x-auto">{photoPreviews.map((p, i) => (
              <div key={i} className="relative shrink-0">
                <img src={p} alt={`Receipt ${i+1}`} className="w-20 h-20 object-cover rounded-lg" />
                <button type="button" onClick={() => removePhoto(i)} className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center text-xs">✕</button>
              </div>
            ))}</div>
          )}
        </div>
        {error && <p className="text-red-400 text-sm text-center bg-red-400/10 rounded-lg py-2">{error}</p>}
        <button type="submit" disabled={submitting} className="w-full py-3 rounded-xl text-white font-semibold disabled:opacity-50 bg-indigo-500 hover:bg-indigo-600">{submitting ? 'Envoi...' : isManager ? 'Creer (auto-approuvee)' : 'Soumettre'}</button>
      </form>
    </div>
  )
}

// === Employee View (with stats & duplication) ====================================
function EmployeeView({ userId, userName, onLogout }: { userId: string; userName: string; onLogout: () => void }) {
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [duplicateFrom, setDuplicateFrom] = useState<Expense | null>(null)
  const [showStats, setShowStats] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    const q = query(collection(db, 'expenses'), where('employeeId', '==', userId), orderBy('createdAt', 'desc'))
    const unsub = onSnapshot(q, (snap) => { setExpenses(snap.docs.map(d => { const data = d.data(); return { id: d.id, ...data, amountTTC: data.amountTTC || data.amount || 0, date: data.date?.toDate?.() || new Date(), createdAt: data.createdAt?.toDate?.() || new Date(), updatedAt: data.updatedAt?.toDate?.() || new Date() } }) as Expense[]); setLoading(false) }, (err) => { console.error('Erreur:', err); setLoading(false) })
    return () => unsub()
  }, [userId])

  useEffect(() => { registerPushNotifications() }, [])

  const handleDuplicate = (exp: Expense) => { setDuplicateFrom(exp); setShowForm(true) }

  // Stats
  const monthlyStats = () => {
    const stats: { month: string; total: number }[] = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setMonth(d.getMonth() - i)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      const total = expenses.filter(e => { const ed = e.date instanceof Date ? e.date : new Date(); return `${ed.getFullYear()}-${String(ed.getMonth() + 1).padStart(2, '0')}` === key }).reduce((s, e) => s + e.amountTTC, 0)
      stats.push({ month: d.toLocaleDateString('fr-FR', { month: 'short' }), total })
    }
    return stats
  }

  if (showSettings) {
    return <SettingsPage userName={userName} userEmail={auth.currentUser?.email || ''} onBack={() => setShowSettings(false)} />
  }

  if (showForm) {
    return <div className="min-h-screen"><ExpenseForm employeeId={userId} employeeName={userName} isManager={false} onSubmit={() => { setShowForm(false); setDuplicateFrom(null) }} onCancel={() => { setShowForm(false); setDuplicateFrom(null) }} duplicateFrom={duplicateFrom} /></div>
  }

  return (
    <div className="min-h-screen pb-20">
      {photoUrl && <PhotoModal url={photoUrl} onClose={() => setPhotoUrl(null)} />}
      <InstallBanner />
      <div className="px-4 pt-0 pb-0 bg-white/80 backdrop-blur-md border-b border-gray-200/50 sticky top-0 z-10">
        <div className="flex items-center justify-between">
          <button onClick={() => { setShowForm(false); setShowStats(false) }} className="flex items-center gap-0.5"><img src="/logo.png" alt="MyKrew" className="h-24 my-[-8px]" /><span className="text-lg font-semibold text-gray-500">Spend</span></button>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowSettings(true)} className="p-2 text-gray-400 hover:text-indigo-500 transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            </button>
            <button onClick={onLogout} className="text-gray-400 hover:text-gray-900 text-sm px-3 py-1 rounded-lg border border-gray-200">Deconnexion</button>
          </div>
        </div>
        <p className="text-gray-400 text-sm mt-1">{userName}</p>
      </div>

      <div className="px-4 mb-4 grid grid-cols-2 gap-3">
        <div className="p-3 rounded-xl bg-white border border-gray-200 shadow-sm"><p className="text-xs text-gray-400">En attente</p><p className="text-lg font-bold text-[#fbbf24]">{expenses.filter(e => e.status === 'pending').reduce((s, e) => s + e.amountTTC, 0).toFixed(2)} EUR</p></div>
        <div className="p-3 rounded-xl bg-white border border-gray-200 shadow-sm"><p className="text-xs text-gray-400">Ce mois</p><p className="text-lg font-bold text-gray-900">{expenses.filter(e => { const d = e.date instanceof Date ? e.date : new Date(); const now = new Date(); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear() }).reduce((s, e) => s + e.amountTTC, 0).toFixed(2)} EUR</p></div>
      </div>

      {showStats ? (
        <div className="px-4 space-y-4">
          <div className="p-4 rounded-xl bg-white border border-gray-200 shadow-sm">
            <p className="text-sm text-gray-500 mb-3">Mes depenses (6 derniers mois)</p>
            <div className="flex items-end gap-2 h-32">
              {monthlyStats().map((m, i) => {
                const maxVal = Math.max(...monthlyStats().map(s => s.total), 1)
                const height = (m.total / maxVal) * 100
                return (<div key={i} className="flex-1 flex flex-col items-center gap-1">
                  <span className="text-xs text-gray-500">{m.total > 0 ? `${m.total.toFixed(0)}` : ''}</span>
                  <div className="w-full rounded-t-md bg-indigo-500" style={{ height: `${Math.max(height, 2)}%` }} />
                  <span className="text-xs text-gray-400">{m.month}</span>
                </div>)
              })}
            </div>
          </div>
          <div className="p-4 rounded-xl bg-white border border-gray-200 shadow-sm">
            <p className="text-sm text-gray-500 mb-2">Par categorie (total)</p>
            {Object.keys(CATEGORY_LABELS).map(cat => {
              const total = expenses.filter(e => e.category === cat).reduce((s, e) => s + e.amountTTC, 0)
              if (total === 0) return null
              const maxCat = Math.max(...Object.keys(CATEGORY_LABELS).map(c => expenses.filter(e => e.category === c).reduce((s, e) => s + e.amountTTC, 0)), 1)
              return (<div key={cat} className="flex items-center gap-2 mb-1">
                <span className="text-xs w-20 truncate">{CATEGORY_ICONS[cat as ExpenseCategory]} {CATEGORY_LABELS[cat as ExpenseCategory]}</span>
                <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-indigo-500 rounded-full" style={{ width: `${(total / maxCat) * 100}%` }} /></div>
                <span className="text-xs text-gray-700 w-14 text-right">{total.toFixed(0)}</span>
              </div>)
            })}
          </div>
        </div>
      ) : (
        <div className="px-4">
          {loading ? <div className="text-center py-12"><div className="w-8 h-8 border-4 border-[#6366f1] border-t-transparent rounded-full animate-spin mx-auto" /></div> : expenses.length === 0 ? (
            <div className="text-center py-12"><p className="text-4xl mb-2">💸</p><p className="text-gray-400">Aucune depense</p></div>
          ) : (
            <div className="space-y-3 pb-24">{expenses.map(exp => (
              <div key={exp.id} className="p-4 rounded-xl bg-white border border-gray-200 shadow-sm">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1"><CategoryBadge category={exp.category} /><StatusBadge status={exp.status} /></div>
                    <p className="text-gray-900 font-medium text-sm truncate">{exp.description}</p>
                    <p className="text-gray-400 text-xs mt-0.5">{exp.location} • {exp.date instanceof Date ? exp.date.toLocaleDateString('fr-FR') : ''}</p>
                    {exp.rejectionReason && <p className="text-red-400 text-xs mt-1">Motif: {exp.rejectionReason}</p>}
                  </div>
                  <div className="text-right ml-3">
                    <p className="text-gray-900 font-bold">{exp.amountTTC.toFixed(2)} EUR</p>
                    {exp.receiptUrl && <button onClick={() => setPhotoUrl(exp.receiptUrl!)} className="text-indigo-600 text-xs mt-1 hover:underline">📷</button>}
                    <button onClick={() => handleDuplicate(exp)} className="block text-gray-400 text-xs mt-1 hover:text-indigo-500">📋 Dupliquer</button>
                  </div>
                </div>
                <ExpenseComments expenseId={exp.id} isManager={false} />
              </div>
            ))}</div>
          )}
        </div>
      )}

      <button onClick={() => setShowForm(true)} className="fixed bottom-20 right-6 w-14 h-14 rounded-full flex items-center justify-center text-white text-2xl shadow-lg shadow-indigo-500/30 active:scale-95 transition-transform bg-indigo-500 hover:bg-indigo-600">+</button>

      {/* Bottom Navigation Bar */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-md border-t border-gray-200/50 px-2 py-1 z-20">
        <div className="max-w-lg mx-auto flex justify-around">
          <button onClick={() => setShowStats(false)} className={`flex flex-col items-center gap-0.5 text-xs font-medium py-2 px-3 rounded-lg transition-colors ${!showStats ? 'text-indigo-600' : 'text-gray-400'}`}>
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>
            <span>Depenses</span>
          </button>
          <button onClick={() => setShowStats(true)} className={`flex flex-col items-center gap-0.5 text-xs font-medium py-2 px-3 rounded-lg transition-colors ${showStats ? 'text-indigo-600' : 'text-gray-400'}`}>
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
            <span>Statistiques</span>
          </button>
        </div>
      </nav>
    </div>
  )
}

// === Expense Calendar View ========================================================
function ExpenseCalendar({ expenses, onViewExpense }: { expenses: Expense[]; onViewExpense: (exp: Expense) => void }) {
  const [currentMonth, setCurrentMonth] = useState(new Date())

  const year = currentMonth.getFullYear()
  const month = currentMonth.getMonth()
  const firstDay = new Date(year, month, 1).getDay() // 0=Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const startOffset = firstDay === 0 ? 6 : firstDay - 1 // Monday-based

  const prevMonth = () => setCurrentMonth(new Date(year, month - 1, 1))
  const nextMonth = () => setCurrentMonth(new Date(year, month + 1, 1))

  // Group expenses by day
  const expensesByDay: Record<number, Expense[]> = {}
  expenses.forEach(exp => {
    const d = exp.date instanceof Date ? exp.date : new Date()
    if (d.getMonth() === month && d.getFullYear() === year) {
      const day = d.getDate()
      if (!expensesByDay[day]) expensesByDay[day] = []
      expensesByDay[day].push(exp)
    }
  })

  const monthTotal = expenses.filter(e => { const d = e.date instanceof Date ? e.date : new Date(); return d.getMonth() === month && d.getFullYear() === year }).reduce((s, e) => s + e.amountTTC, 0)
  const monthCount = expenses.filter(e => { const d = e.date instanceof Date ? e.date : new Date(); return d.getMonth() === month && d.getFullYear() === year }).length

  const [selectedDay, setSelectedDay] = useState<number | null>(null)

  const dayStatusColor = (day: number): string => {
    const dayExpenses = expensesByDay[day]
    if (!dayExpenses || dayExpenses.length === 0) return ''
    const hasPending = dayExpenses.some(e => e.status === 'pending')
    const hasApproved = dayExpenses.some(e => ['approved', 'reimbursed', 'self_approved'].includes(e.status))
    if (hasPending) return 'bg-yellow-400'
    if (hasApproved) return 'bg-green-400'
    return 'bg-gray-400'
  }

  return (
    <div className="space-y-4">
      {/* Month navigator */}
      <div className="flex items-center justify-between">
        <button onClick={prevMonth} className="p-2 rounded-lg text-gray-500 hover:bg-gray-100">←</button>
        <div className="text-center">
          <h2 className="text-lg font-bold text-gray-900 capitalize">{currentMonth.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}</h2>
          <p className="text-xs text-gray-400">{monthCount} depense(s) • {monthTotal.toFixed(2)} EUR</p>
        </div>
        <button onClick={nextMonth} className="p-2 rounded-lg text-gray-500 hover:bg-gray-100">→</button>
      </div>

      {/* Calendar grid */}
      <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-2">
        <div className="grid grid-cols-7 gap-0.5 mb-1">
          {['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d, i) => (
            <div key={i} className="text-center text-[10px] font-medium text-gray-400 py-0.5">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-0.5">
          {Array.from({ length: startOffset }).map((_, i) => <div key={`empty-${i}`} />)}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const day = i + 1
            const hasExpenses = !!expensesByDay[day]
            const isSelected = selectedDay === day
            const isToday = day === new Date().getDate() && month === new Date().getMonth() && year === new Date().getFullYear()
            const dotColor = dayStatusColor(day)
            return (
              <button key={day} onClick={() => setSelectedDay(isSelected ? null : day)} className={`relative w-full h-8 flex flex-col items-center justify-center rounded text-xs transition-colors ${isSelected ? 'bg-indigo-500 text-white' : isToday ? 'bg-indigo-50 text-indigo-700 font-bold' : hasExpenses ? 'bg-gray-50 text-gray-900 font-medium' : 'text-gray-500'}`}>
                {day}
                {dotColor && <span className={`absolute bottom-0.5 w-1 h-1 rounded-full ${dotColor}`} />}
              </button>
            )
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-gray-400">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-400" /> En attente</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-400" /> Approuvee</span>
      </div>

      {/* Selected day expenses */}
      {selectedDay && expensesByDay[selectedDay] && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-700">{selectedDay} {currentMonth.toLocaleDateString('fr-FR', { month: 'long' })}</p>
          {expensesByDay[selectedDay].map(exp => (
            <div key={exp.id} className="p-3 rounded-xl bg-white border border-gray-200 shadow-sm" onClick={() => onViewExpense(exp)}>
              <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2"><StatusBadge status={exp.status} /><CategoryBadge category={exp.category} /></div>
                  <p className="text-gray-900 text-sm font-medium mt-0.5">{exp.employeeName}</p>
                  <p className="text-gray-400 text-xs truncate">{exp.description}</p>
                </div>
                <p className="text-gray-900 font-bold text-sm ml-2">{exp.amountTTC.toFixed(2)} EUR</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {selectedDay && !expensesByDay[selectedDay] && (
        <p className="text-center text-sm text-gray-400 py-4">Aucune depense ce jour</p>
      )}
    </div>
  )
}

// === Manager View =================================================================
type ManagerTab = 'home' | 'requests' | 'calendar' | 'team' | 'new' | 'add-employee' | 'employee-expenses' | 'budgets' | 'settings'

function ManagerView({ userId, userName, onLogout }: { userId: string; userName: string; onLogout: () => void }) {
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [budgetLimits, setBudgetLimits] = useState<BudgetLimit[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<ManagerTab>('home')
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<ExpenseStatus | 'all'>('all')
  const [filterCategory, setFilterCategory] = useState<ExpenseCategory | 'all'>('all')
  const [filterMonth, setFilterMonth] = useState(new Date().toISOString().slice(0, 7))
  const [rejectionReason, setRejectionReason] = useState('')
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [selectedEmployee, setSelectedEmployee] = useState<TeamMember | null>(null)
  const [deletingExpenseId, setDeletingExpenseId] = useState<string | null>(null)
  const [duplicateFrom, setDuplicateFrom] = useState<Expense | null>(null)

  useEffect(() => {
    const q = query(collection(db, 'expenses'), orderBy('createdAt', 'desc'))
    const unsub = onSnapshot(q, (snap) => {
      setExpenses(snap.docs.map(d => { const data = d.data(); return { id: d.id, ...data, amountTTC: data.amountTTC || data.amount || 0, date: data.date?.toDate?.() || new Date(), createdAt: data.createdAt?.toDate?.() || new Date(), updatedAt: data.updatedAt?.toDate?.() || new Date(), approvedAt: data.approvedAt?.toDate?.() || undefined, reimbursedAt: data.reimbursedAt?.toDate?.() || undefined } }) as Expense[])
      setLoading(false)
    }, (err) => { console.error('Erreur chargement expenses:', err); setLoading(false) })
    return () => unsub()
  }, [])

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'budgetLimits'), (snap) => {
      setBudgetLimits(snap.docs.map(d => d.data() as BudgetLimit))
    }, (err) => { console.warn('budgetLimits non accessible:', err) })
    return () => unsub()
  }, [])

  useEffect(() => { registerPushNotifications() }, [])

  const handleApprove = async (id: string) => { await updateDoc(doc(db, 'expenses', id), { status: 'approved', approvedAt: Timestamp.now(), approvedBy: userId, updatedAt: Timestamp.now() }) }
  const handleReject = async (id: string) => { if (!rejectionReason.trim()) return; await updateDoc(doc(db, 'expenses', id), { status: 'rejected', rejectionReason: rejectionReason.trim(), updatedAt: Timestamp.now() }); setRejectingId(null); setRejectionReason('') }
  const handleReimburse = async (id: string) => { await updateDoc(doc(db, 'expenses', id), { status: 'reimbursed', reimbursedAt: Timestamp.now(), updatedAt: Timestamp.now() }) }
  const handleDeleteExpense = async (id: string) => { if (!confirm('Supprimer cette note ?')) return; setDeletingExpenseId(id); try { await httpsCallable(functions, 'deleteExpense')({ expenseId: id }) } catch { alert('Erreur') }; setDeletingExpenseId(null) }

  const filteredExpenses = expenses.filter(exp => {
    if (filterStatus !== 'all' && exp.status !== filterStatus) return false
    if (filterCategory !== 'all' && exp.category !== filterCategory) return false
    if (filterMonth) { const d = exp.date instanceof Date ? exp.date : new Date(); if (`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` !== filterMonth) return false }
    return true
  })

  const pendingExpenses = expenses.filter(e => e.status === 'pending')

  // Budget warning helper
  const getBudgetWarning = (category: ExpenseCategory): string | null => {
    const limit = budgetLimits.find(l => l.category === category && l.isActive)
    if (!limit || !limit.monthlyLimit) return null
    const now = new Date()
    const monthTotal = expenses.filter(e => e.category === category && ['approved', 'reimbursed', 'self_approved', 'pending'].includes(e.status) && e.date instanceof Date && e.date.getMonth() === now.getMonth() && e.date.getFullYear() === now.getFullYear()).reduce((s, e) => s + e.amountTTC, 0)
    if (monthTotal >= limit.monthlyLimit) return `⚠️ Plafond depasse (${monthTotal.toFixed(0)}/${limit.monthlyLimit} EUR)`
    if (monthTotal >= limit.monthlyLimit * 0.8) return `⚡ Proche du plafond (${monthTotal.toFixed(0)}/${limit.monthlyLimit} EUR)`
    return null
  }

  // CSV Export
  const exportCSV = () => {
    const header = 'Date,Employe,Categorie,Lieu,Description,HT,TVA,TTC,Statut'
    const rows = filteredExpenses.map(exp => {
      const d = exp.date instanceof Date ? exp.date.toLocaleDateString('fr-FR') : ''
      return `${d},${exp.employeeName},${CATEGORY_LABELS[exp.category]},"${(exp.location||'').replace(/"/g,'""')}","${(exp.description||'').replace(/"/g,'""')}",${(exp.amountHT||0).toFixed(2)},${(exp.vatAmount||0).toFixed(2)},${exp.amountTTC.toFixed(2)},${STATUS_CONFIG[exp.status]?.label||exp.status}`
    })
    const blob = new Blob(['\ufeff' + [header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `depenses_${filterMonth||'export'}.csv`; link.click(); URL.revokeObjectURL(url)
  }

  // Dashboard stats
  const now = new Date()
  const thisMonth = expenses.filter(e => { const d = e.date instanceof Date ? e.date : new Date(); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear() })
  const totalPending = pendingExpenses.reduce((s, e) => s + e.amountTTC, 0)
  const totalApprovedMonth = thisMonth.filter(e => ['approved', 'reimbursed', 'self_approved'].includes(e.status)).reduce((s, e) => s + e.amountTTC, 0)
  const lastMonth = (() => { const d = new Date(); d.setMonth(d.getMonth() - 1); return expenses.filter(e => { const ed = e.date instanceof Date ? e.date : new Date(); return ed.getMonth() === d.getMonth() && ed.getFullYear() === d.getFullYear() }).filter(e => ['approved', 'reimbursed', 'self_approved'].includes(e.status)).reduce((s, e) => s + e.amountTTC, 0) })()
  const byCategory = Object.keys(CATEGORY_LABELS).map(cat => ({ category: cat as ExpenseCategory, total: thisMonth.filter(e => e.category === cat).reduce((s, e) => s + e.amountTTC, 0) })).filter(c => c.total > 0)

  // Sub-views (fullscreen overlays)
  if (activeTab === 'new') return <div className="min-h-screen"><ExpenseForm employeeId={userId} employeeName={userName} isManager={true} onSubmit={() => { setActiveTab('home'); setDuplicateFrom(null) }} onCancel={() => { setActiveTab('home'); setDuplicateFrom(null) }} duplicateFrom={duplicateFrom} /></div>
  if (activeTab === 'add-employee') return <div className="min-h-screen"><AddEmployeeForm onBack={() => setActiveTab('team')} /></div>
  if (activeTab === 'employee-expenses' && selectedEmployee) return <div className="min-h-screen"><EmployeeExpensesView employee={selectedEmployee} onBack={() => setActiveTab('team')} /></div>
  if (activeTab === 'budgets') return <div className="min-h-screen"><BudgetLimitsView onBack={() => setActiveTab('home')} /></div>
  if (activeTab === 'settings') return <SettingsPage userName={userName} userEmail={auth.currentUser?.email || ''} onBack={() => setActiveTab('home')} />

  return (
    <div className="min-h-screen pb-20">
      {photoUrl && <PhotoModal url={photoUrl} onClose={() => setPhotoUrl(null)} />}
      <InstallBanner />
      
      {/* Header */}
      <div className="px-4 pt-0 pb-0 bg-white/80 backdrop-blur-md border-b border-gray-200/50 sticky top-0 z-10">
        <div className="flex items-center justify-between">
          <button onClick={() => setActiveTab('home')} className="flex items-center gap-0.5"><img src="/logo.png" alt="MyKrew" className="h-24 my-[-8px]" /><span className="text-lg font-semibold text-gray-500">Spend</span></button>
          <div className="flex items-center gap-2">
            <button onClick={() => setActiveTab('settings')} className="p-2 text-gray-400 hover:text-indigo-500 transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            </button>
            <button onClick={onLogout} className="text-gray-400 hover:text-gray-900 text-sm px-3 py-1 rounded-lg border border-gray-200">Deconnexion</button>
          </div>
        </div>
      </div>

      {loading ? <div className="text-center py-12"><div className="w-8 h-8 border-4 border-[#6366f1] border-t-transparent rounded-full animate-spin mx-auto" /><p className="text-gray-400 mt-3">Chargement...</p></div> : (<>
        {/* Home Tab - Dashboard */}
        {activeTab === 'home' && (
          <div className="px-4 pt-4 space-y-4">
            <p className="text-sm text-gray-500">Bonjour, {userName}</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-4 rounded-xl bg-white border border-gray-200 shadow-sm"><p className="text-xs text-gray-400">En attente</p><p className="text-xl font-bold text-[#fbbf24]">{totalPending.toFixed(2)} EUR</p><p className="text-xs text-gray-400">{pendingExpenses.length} depense(s)</p></div>
              <div className="p-4 rounded-xl bg-white border border-gray-200 shadow-sm"><p className="text-xs text-gray-400">Approuvees (mois)</p><p className="text-xl font-bold text-[#4ade80]">{totalApprovedMonth.toFixed(2)} EUR</p><p className="text-xs text-gray-400">{lastMonth > 0 ? `${lastMonth > totalApprovedMonth ? '↓' : '↑'} vs ${lastMonth.toFixed(0)} EUR mois prec.` : ''}</p></div>
            </div>
            {/* Budget warnings */}
            {Object.keys(CATEGORY_LABELS).map(cat => { const w = getBudgetWarning(cat as ExpenseCategory); return w ? <div key={cat} className="px-3 py-2 rounded-lg bg-yellow-50 border border-yellow-200 text-xs text-yellow-800">{w} — {CATEGORY_LABELS[cat as ExpenseCategory]}</div> : null })}
            {/* Quick action buttons */}
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => setActiveTab('new')} className="p-4 rounded-xl bg-indigo-50 border border-indigo-200 text-center hover:bg-indigo-100 transition-colors"><span className="text-2xl block mb-1">💸</span><span className="text-sm font-medium text-indigo-700">Nouvelle depense</span></button>
              <button onClick={() => setActiveTab('budgets')} className="p-4 rounded-xl bg-violet-50 border border-violet-200 text-center hover:bg-violet-100 transition-colors"><span className="text-2xl block mb-1">📊</span><span className="text-sm font-medium text-violet-700">Plafonds</span></button>
            </div>
            {/* Category chart */}
            {byCategory.length > 0 && (
              <div className="p-4 rounded-xl bg-white border border-gray-200 shadow-sm">
                <p className="text-sm text-gray-400 mb-3">Par categorie (ce mois)</p>
                <div className="space-y-2">{byCategory.sort((a, b) => b.total - a.total).map(c => (
                  <div key={c.category} className="flex items-center justify-between"><CategoryBadge category={c.category} /><span className="text-gray-900 text-sm font-medium">{c.total.toFixed(2)} EUR</span></div>
                ))}</div>
              </div>
            )}
            {/* Last pending expenses */}
            {pendingExpenses.length > 0 && (<div>
              <div className="flex items-center justify-between mb-2"><p className="text-sm text-gray-400">Dernieres en attente</p><button onClick={() => setActiveTab('requests')} className="text-xs text-indigo-600 hover:underline">Voir tout →</button></div>
              {pendingExpenses.slice(0, 3).map(exp => (<div key={exp.id} className="p-3 rounded-xl mb-2 bg-white border border-gray-200 shadow-sm"><div className="flex items-center justify-between"><div><p className="text-gray-900 text-sm font-medium">{exp.employeeName}</p><p className="text-gray-400 text-xs">{exp.description}</p></div><p className="text-gray-900 font-bold text-sm">{exp.amountTTC.toFixed(2)} EUR</p></div></div>))}
            </div>)}
            {/* Approved this month */}
            {(() => { const approved = thisMonth.filter(e => ['approved', 'reimbursed', 'self_approved'].includes(e.status)); return approved.length > 0 ? (<div><p className="text-sm text-gray-400 mb-2">Approuvees ce mois</p><div className="space-y-2">{approved.slice(0, 5).map(exp => (<div key={exp.id} className="p-3 rounded-xl bg-white border border-gray-200 shadow-sm"><div className="flex items-center justify-between"><div className="flex-1 min-w-0"><div className="flex items-center gap-2"><StatusBadge status={exp.status} /><CategoryBadge category={exp.category} /></div><p className="text-gray-900 text-sm font-medium mt-0.5">{exp.employeeName}</p><p className="text-gray-400 text-xs truncate">{exp.description}</p></div><p className="text-gray-900 font-bold text-sm ml-2">{exp.amountTTC.toFixed(2)} EUR</p></div></div>))}</div></div>) : null })()}
          </div>
        )}

        {/* Requests Tab - Pending + All expenses with filters */}
        {activeTab === 'requests' && (
          <div className="px-4 pt-4">
            <div className="flex gap-2 mb-4 overflow-x-auto">
              <button onClick={() => setFilterStatus('pending')} className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${filterStatus === 'pending' ? 'bg-indigo-500 text-white' : 'bg-white text-gray-700 border border-gray-200'}`}>En attente ({pendingExpenses.length})</button>
              <button onClick={() => setFilterStatus('all')} className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${filterStatus === 'all' ? 'bg-indigo-500 text-white' : 'bg-white text-gray-700 border border-gray-200'}`}>Toutes</button>
              <button onClick={() => setFilterStatus('approved')} className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${filterStatus === 'approved' ? 'bg-indigo-500 text-white' : 'bg-white text-gray-700 border border-gray-200'}`}>Approuvees</button>
              <button onClick={() => setFilterStatus('reimbursed')} className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${filterStatus === 'reimbursed' ? 'bg-indigo-500 text-white' : 'bg-white text-gray-700 border border-gray-200'}`}>Remboursees</button>
            </div>
            <div className="flex gap-2 mb-3">
              <select value={filterCategory} onChange={e => setFilterCategory(e.target.value as any)} className="flex-1 px-3 py-2 rounded-lg bg-white text-gray-900 border border-gray-200 text-xs focus:border-indigo-500 focus:outline-none">
                <option value="all">Toutes categories</option>{Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <input type="month" value={filterMonth} onChange={e => setFilterMonth(e.target.value)} className="px-3 py-2 rounded-lg bg-white text-gray-900 border border-gray-200 text-xs focus:border-indigo-500 focus:outline-none" />
            </div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-gray-400">{filteredExpenses.length} depense(s) • {filteredExpenses.reduce((s, e) => s + e.amountTTC, 0).toFixed(2)} EUR</p>
              <div className="flex gap-2">
                <button onClick={exportCSV} className="px-3 py-1.5 rounded-lg text-xs font-medium text-indigo-600 border border-indigo-300 hover:bg-indigo-50">📥 CSV</button>
                <button onClick={() => generatePDF(filteredExpenses, 'Recapitulatif', filterMonth)} className="px-3 py-1.5 rounded-lg text-xs font-medium text-indigo-600 border border-indigo-300 hover:bg-indigo-50">📄 PDF</button>
              </div>
            </div>
            {filteredExpenses.length === 0 ? <div className="text-center py-12"><p className="text-4xl mb-2">✅</p><p className="text-gray-400">Aucune depense</p></div> : (
              <div className="space-y-3 pb-6">{filteredExpenses.map(exp => {
                const budgetWarn = getBudgetWarning(exp.category)
                return (
                <div key={exp.id} className="p-4 rounded-xl bg-white border border-gray-200 shadow-sm">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1"><StatusBadge status={exp.status} /><CategoryBadge category={exp.category} /></div>
                      <p className="text-gray-900 font-medium text-sm">{exp.employeeName}</p>
                      <p className="text-gray-400 text-xs mt-1 truncate">{exp.description}</p>
                      <p className="text-gray-400 text-xs">{exp.location} • {exp.date instanceof Date ? exp.date.toLocaleDateString('fr-FR') : ''}</p>
                      {exp.project && <p className="text-gray-400 text-xs">Projet: {exp.project}</p>}
                      {budgetWarn && <p className="text-yellow-600 text-xs mt-1">{budgetWarn}</p>}
                    </div>
                    <div className="text-right ml-3">
                      <p className="text-gray-900 font-bold">{exp.amountTTC.toFixed(2)} EUR</p>
                      <p className="text-gray-400 text-xs">HT: {(exp.amountHT || 0).toFixed(2)}</p>
                      {exp.receiptUrl && <button onClick={() => setPhotoUrl(exp.receiptUrl!)} className="text-indigo-600 text-xs mt-1 hover:underline">📷 Justificatif</button>}
                      <button onClick={() => { setDuplicateFrom(exp); setActiveTab('new') }} className="block text-gray-400 text-xs mt-1 hover:text-indigo-500">📋 Dupliquer</button>
                    </div>
                  </div>
                  <ExpenseComments expenseId={exp.id} isManager={true} />
                  <ActivityTimeline expenseId={exp.id} />
                  {exp.status === 'pending' && (
                    <>
                      {rejectingId === exp.id ? (
                        <div className="mt-3 space-y-2">
                          <input type="text" value={rejectionReason} onChange={e => setRejectionReason(e.target.value)} placeholder="Motif du refus..." className="w-full px-3 py-2 rounded-lg bg-white text-gray-900 border border-gray-200 text-sm focus:border-red-400 focus:outline-none" />
                          <div className="flex gap-2">
                            <button onClick={() => handleReject(exp.id)} disabled={!rejectionReason.trim()} className="flex-1 py-2 rounded-lg text-sm font-medium bg-red-100 text-red-700 hover:bg-red-200 disabled:opacity-50">Confirmer refus</button>
                            <button onClick={() => { setRejectingId(null); setRejectionReason('') }} className="px-4 py-2 rounded-lg text-sm text-gray-400">Annuler</button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex gap-2 mt-3">
                          <button onClick={() => handleApprove(exp.id)} className="flex-1 py-2 rounded-lg text-sm font-medium bg-green-100 text-green-700 hover:bg-green-200">✓ Approuver</button>
                          <button onClick={() => setRejectingId(exp.id)} className="flex-1 py-2 rounded-lg text-sm font-medium bg-red-100 text-red-700 hover:bg-red-200">✕ Refuser</button>
                        </div>
                      )}
                    </>
                  )}
                  {exp.status === 'approved' && (
                    <div className="flex gap-2 mt-3">
                      <button onClick={() => handleReimburse(exp.id)} className="flex-1 py-2 rounded-lg text-xs font-medium bg-indigo-100 text-indigo-700 hover:bg-indigo-200">💰 Marquer remboursee</button>
                      <button onClick={() => handleDeleteExpense(exp.id)} disabled={deletingExpenseId === exp.id} className="py-2 px-3 rounded-lg text-xs font-medium bg-red-50 text-red-500 hover:bg-red-100 disabled:opacity-50">{deletingExpenseId === exp.id ? '...' : '🗑️'}</button>
                    </div>
                  )}
                  {['reimbursed', 'self_approved'].includes(exp.status) && (
                    <button onClick={() => handleDeleteExpense(exp.id)} disabled={deletingExpenseId === exp.id} className="mt-3 w-full py-2 rounded-lg text-xs font-medium bg-red-50 text-red-500 hover:bg-red-100 disabled:opacity-50">{deletingExpenseId === exp.id ? 'Suppression...' : '🗑️ Supprimer'}</button>
                  )}
                </div>
              )})}</div>
            )}
          </div>
        )}

        {/* Calendar Tab */}
        {activeTab === 'calendar' && (
          <div className="px-4 pt-4">
            <ExpenseCalendar expenses={expenses} onViewExpense={(exp) => { setPhotoUrl(exp.receiptUrl || null) }} />
          </div>
        )}

        {/* Team Tab */}
        {activeTab === 'team' && (
          <div className="pt-2"><TeamList onBack={() => {}} onAddEmployee={() => setActiveTab('add-employee')} onViewEmployeeExpenses={emp => { setSelectedEmployee(emp); setActiveTab('employee-expenses') }} /></div>
        )}
      </>)}

      {/* Bottom Navigation Bar */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-md border-t border-gray-200/50 px-2 py-1 z-20">
        <div className="max-w-lg mx-auto flex justify-around">
          <button onClick={() => setActiveTab('home')} className={`flex flex-col items-center gap-0.5 text-xs font-medium py-2 px-3 rounded-lg transition-colors ${activeTab === 'home' ? 'text-indigo-600' : 'text-gray-400'}`}>
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>
            <span>Accueil</span>
          </button>
          <button onClick={() => { setActiveTab('requests'); setFilterStatus('pending') }} className={`flex flex-col items-center gap-0.5 text-xs font-medium py-2 px-3 rounded-lg transition-colors relative ${activeTab === 'requests' ? 'text-indigo-600' : 'text-gray-400'}`}>
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
            <span>Demandes</span>
            {pendingExpenses.length > 0 && <span className="absolute -top-0.5 right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] flex items-center justify-center">{pendingExpenses.length}</span>}
          </button>
          <button onClick={() => setActiveTab('calendar')} className={`flex flex-col items-center gap-0.5 text-xs font-medium py-2 px-3 rounded-lg transition-colors ${activeTab === 'calendar' ? 'text-indigo-600' : 'text-gray-400'}`}>
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
            <span>Calendrier</span>
          </button>
          <button onClick={() => setActiveTab('team')} className={`flex flex-col items-center gap-0.5 text-xs font-medium py-2 px-3 rounded-lg transition-colors ${activeTab === 'team' ? 'text-indigo-600' : 'text-gray-400'}`}>
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            <span>Equipe</span>
          </button>
        </div>
      </nav>
    </div>
  )
}

// === Main App ====================================================================
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <p className="text-4xl mb-4">⚠️</p>
          <h2 className="text-lg font-bold text-gray-900 mb-2">Erreur d'affichage</h2>
          <p className="text-sm text-red-500 bg-red-50 p-3 rounded-lg break-all">{this.state.error.message}</p>
          <button onClick={() => { this.setState({ error: null }); window.location.reload() }} className="mt-4 px-4 py-2 bg-indigo-500 text-white rounded-lg">Recharger</button>
        </div>
      </div>
    )
    return this.props.children
  }
}

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [role, setRole] = useState<'manager' | 'employee' | null>(null)
  const [userName, setUserName] = useState('')
  const [authLoading, setAuthLoading] = useState(true)
  const [roleLoading, setRoleLoading] = useState(false)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setUser(firebaseUser); setRoleLoading(true)
        let resolved = false
        
        // Try Firestore first
        try {
          const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid))
          if (userDoc.exists()) {
            const data = userDoc.data()
            setRole(data.role as 'manager' | 'employee')
            setUserName(`${data.firstName || ''} ${data.lastName || ''}`.trim() || firebaseUser.displayName || firebaseUser.email || '')
            resolved = true
          }
        } catch (err) {
          console.warn('[Spend] Firestore read failed, using fallback:', err)
        }

        // Fallback: use displayName from Auth
        // The createEmployee CF sets displayName, so we know the user exists
        // We check token claims or default based on whether user was created as first user
        if (!resolved) {
          const tokenResult = await firebaseUser.getIdTokenResult()
          const claimRole = tokenResult.claims.role as string | undefined
          if (claimRole === 'employee' || claimRole === 'manager') {
            setRole(claimRole)
          } else {
            // No claim set = first user = manager
            setRole('manager')
          }
          const resolvedRole = (claimRole === 'employee' || claimRole === 'manager') ? claimRole : 'manager'
          const displayName = firebaseUser.displayName || firebaseUser.email || ''
          setUserName(displayName)

          // Auto-create Firestore doc for first user (fixes "unauthenticated" error on createEmployee)
          try {
            const nameParts = displayName.split(' ')
            await setDoc(doc(db, 'users', firebaseUser.uid), {
              email: firebaseUser.email || '',
              firstName: nameParts[0] || '',
              lastName: nameParts.slice(1).join(' ') || '',
              role: resolvedRole,
              isActive: true,
              createdAt: Timestamp.now(),
              updatedAt: Timestamp.now(),
            })
          } catch (err) {
            console.warn('[Spend] Could not auto-create user doc:', err)
          }
        }
        
        setRoleLoading(false)
      } else { setUser(null); setRole(null); setUserName('') }
      setAuthLoading(false)
    })
    return () => unsub()
  }, [])

  const handleLogout = async () => { await signOut(auth) }

  if (authLoading || roleLoading) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center"><div className="w-10 h-10 border-4 border-[#6366f1] border-t-transparent rounded-full animate-spin mx-auto" /><p className="text-gray-400 mt-4 text-sm">Chargement...</p></div>
    </div>
  )

  if (!user) return <LoginPage onLogin={() => {}} />
  if (role === 'manager') return <ErrorBoundary><ManagerView userId={user.uid} userName={userName} onLogout={handleLogout} /></ErrorBoundary>
  return <ErrorBoundary><EmployeeView userId={user.uid} userName={userName} onLogout={handleLogout} /></ErrorBoundary>
}
