import { useEffect, useState, useRef } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, User } from 'firebase/auth'
import { collection, onSnapshot, orderBy, query, where, addDoc, updateDoc, doc, getDoc, Timestamp } from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { auth, db, storage } from './services/firebase'
import type { Expense, ExpenseCategory, ExpenseStatus } from './types'
import { CATEGORY_LABELS, CATEGORY_ICONS, VAT_RATES } from './types'

// === Status Badge ================================================================
const STATUS_CONFIG: Record<ExpenseStatus, { label: string; color: string; bg: string }> = {
  pending: { label: 'En attente', color: '#fbbf24', bg: 'rgba(251,191,36,0.15)' },
  approved: { label: 'Approuvee', color: '#4ade80', bg: 'rgba(74,222,128,0.15)' },
  rejected: { label: 'Refusee', color: '#f87171', bg: 'rgba(248,113,113,0.15)' },
  reimbursed: { label: 'Remboursee', color: '#a78bfa', bg: 'rgba(167,139,250,0.15)' },
  cancelled: { label: 'Annulee', color: '#9ca3af', bg: 'rgba(156,163,175,0.15)' },
  self_approved: { label: 'Auto-approuvee', color: '#60a5fa', bg: 'rgba(96,165,250,0.15)' },
}

function StatusBadge({ status }: { status: ExpenseStatus }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.pending
  return (
    <span
      className="px-2 py-0.5 rounded-full text-xs font-medium"
      style={{ color: cfg.color, backgroundColor: cfg.bg }}
    >
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
        <button onClick={onClose} className="absolute -top-10 right-0 text-gray-900 text-2xl font-bold hover:text-gray-600">
          ✕
        </button>
        <img src={url} alt="Justificatif" className="max-w-full max-h-[85vh] rounded-lg object-contain" />
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
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await signInWithEmailAndPassword(auth, email, password)
      onLogin()
    } catch (err: any) {
      if (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password') {
        setError('Email ou mot de passe incorrect')
      } else if (err.code === 'auth/user-not-found') {
        setError('Aucun compte associe a cet email')
      } else if (err.code === 'auth/too-many-requests') {
        setError('Trop de tentatives. Reessayez plus tard.')
      } else {
        setError('Erreur de connexion')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4" className="min-h-screen">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4" className="bg-[#863bff] hover:bg-[#7e14ff]">
            <span className="text-3xl">��</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">MyKrew Spend</h1>
          <p className="text-gray-400 text-sm mt-1">Gestion des notes de frais</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full px-4 py-3 rounded-xl bg-gray-50 text-gray-900 border border-gray-200 focus:border-[#863bff] focus:outline-none transition-colors"
              placeholder="votre@email.com"
              required
              autoComplete="email"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Mot de passe</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full px-4 py-3 rounded-xl bg-gray-50 text-gray-900 border border-gray-200 focus:border-[#863bff] focus:outline-none transition-colors"
              placeholder="••••••••"
              required
              autoComplete="current-password"
            />
          </div>

          {error && (
            <p className="text-red-400 text-sm text-center bg-red-400/10 rounded-lg py-2">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-xl text-gray-900 font-semibold transition-all disabled:opacity-50"
            className="bg-[#863bff] hover:bg-[#7e14ff]"
          >
            {loading ? 'Connexion...' : 'Se connecter'}
          </button>
        </form>
      </div>
    </div>
  )
}

// === Expense Form ================================================================
interface ExpenseFormProps {
  employeeId: string
  employeeName: string
  isManager: boolean
  onSubmit: () => void
  onCancel: () => void
}

function ExpenseForm({ employeeId, employeeName, isManager, onSubmit, onCancel }: ExpenseFormProps) {
  const [amountTTC, setAmountTTC] = useState('')
  const [vatRate, setVatRate] = useState(20)
  const [date, setDate] = useState(new Date().toISOString().split('T')[0])
  const [location, setLocation] = useState('')
  const [category, setCategory] = useState<ExpenseCategory>('meal')
  const [description, setDescription] = useState('')
  const [project, setProject] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const amountHT = amountTTC ? (parseFloat(amountTTC) / (1 + vatRate / 100)).toFixed(2) : '0.00'
  const vatAmount = amountTTC ? (parseFloat(amountTTC) - parseFloat(amountHT)).toFixed(2) : '0.00'

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setPhoto(file)
      const reader = new FileReader()
      reader.onload = () => setPhotoPreview(reader.result as string)
      reader.readAsDataURL(file)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!amountTTC || !location || !description) {
      setError('Veuillez remplir tous les champs obligatoires')
      return
    }
    setError('')
    setSubmitting(true)

    try {
      const ttc = parseFloat(amountTTC)
      const ht = parseFloat(amountHT)
      const vat = parseFloat(vatAmount)

      const expenseData: any = {
        employeeId,
        employeeName,
        amountTTC: ttc,
        amountHT: ht,
        vatRate,
        vatAmount: vat,
        date: Timestamp.fromDate(new Date(date)),
        location,
        category,
        description,
        status: isManager ? 'self_approved' : 'pending',
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      }

      if (project.trim()) {
        expenseData.project = project.trim()
      }

      if (isManager) {
        expenseData.approvedAt = Timestamp.now()
        expenseData.approvedBy = employeeId
      }

      const docRef = await addDoc(collection(db, 'expenses'), expenseData)

      // Upload photo if provided
      if (photo) {
        const ext = photo.name.split('.').pop() || 'jpg'
        const storagePath = `expenses/${docRef.id}/receipt.${ext}`
        const storageRef = ref(storage, storagePath)
        await uploadBytes(storageRef, photo)
        const downloadUrl = await getDownloadURL(storageRef)
        await updateDoc(doc(db, 'expenses', docRef.id), {
          receiptUrl: downloadUrl,
          receiptPath: storagePath,
        })
      }

      onSubmit()
    } catch (err: any) {
      console.error('Error creating expense:', err)
      setError('Erreur lors de la creation de la depense')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-gray-900">Nouvelle depense</h2>
        <button onClick={onCancel} className="text-gray-400 hover:text-gray-900 text-sm">Annuler</button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Amount TTC */}
        <div>
          <label className="block text-sm text-gray-400 mb-1">Montant TTC (EUR) *</label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={amountTTC}
            onChange={e => setAmountTTC(e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-gray-50 text-gray-900 border border-gray-200 focus:border-[#863bff] focus:outline-none"
            placeholder="0.00"
            required
          />
        </div>

        {/* VAT Rate */}
        <div>
          <label className="block text-sm text-gray-400 mb-1">Taux de TVA</label>
          <select
            value={vatRate}
            onChange={e => setVatRate(parseFloat(e.target.value))}
            className="w-full px-4 py-3 rounded-xl bg-gray-50 text-gray-900 border border-gray-200 focus:border-[#863bff] focus:outline-none"
          >
            {VAT_RATES.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>

        {/* Computed amounts */}
        <div className="grid grid-cols-2 gap-3">
          <div className="px-3 py-2 rounded-lg bg-gray-50 border border-gray-200">
            <p className="text-xs text-gray-400">Montant HT</p>
            <p className="text-gray-900 font-medium">{amountHT} EUR</p>
          </div>
          <div className="px-3 py-2 rounded-lg bg-gray-50 border border-gray-200">
            <p className="text-xs text-gray-400">TVA</p>
            <p className="text-gray-900 font-medium">{vatAmount} EUR</p>
          </div>
        </div>

        {/* Date */}
        <div>
          <label className="block text-sm text-gray-400 mb-1">Date *</label>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-gray-50 text-gray-900 border border-gray-200 focus:border-[#863bff] focus:outline-none"
            required
          />
        </div>

        {/* Location */}
        <div>
          <label className="block text-sm text-gray-400 mb-1">Lieu *</label>
          <input
            type="text"
            value={location}
            onChange={e => setLocation(e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-gray-50 text-gray-900 border border-gray-200 focus:border-[#863bff] focus:outline-none"
            placeholder="Restaurant, Gare, etc."
            required
          />
        </div>

        {/* Category */}
        <div>
          <label className="block text-sm text-gray-400 mb-1">Categorie *</label>
          <select
            value={category}
            onChange={e => setCategory(e.target.value as ExpenseCategory)}
            className="w-full px-4 py-3 rounded-xl bg-gray-50 text-gray-900 border border-gray-200 focus:border-[#863bff] focus:outline-none"
          >
            {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{CATEGORY_ICONS[key as ExpenseCategory]} {label}</option>
            ))}
          </select>
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm text-gray-400 mb-1">Description *</label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-gray-50 text-gray-900 border border-gray-200 focus:border-[#863bff] focus:outline-none resize-none"
            rows={2}
            placeholder="Dejeuner equipe, Train Paris-Lyon..."
            required
          />
        </div>

        {/* Project */}
        <div>
          <label className="block text-sm text-gray-400 mb-1">Projet (optionnel)</label>
          <input
            type="text"
            value={project}
            onChange={e => setProject(e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-gray-50 text-gray-900 border border-gray-200 focus:border-[#863bff] focus:outline-none"
            placeholder="Nom du projet"
          />
        </div>

        {/* Photo upload */}
        <div>
          <label className="block text-sm text-gray-400 mb-1">Justificatif (photo)</label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handlePhotoChange}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full py-3 rounded-xl border-2 border-dashed border-gray-300 text-gray-400 hover:border-[#863bff] hover:text-[#863bff] transition-colors"
          >
            📷 {photo ? 'Changer la photo' : 'Ajouter un justificatif'}
          </button>
          {photoPreview && (
            <div className="mt-3 relative">
              <img src={photoPreview} alt="Preview" className="w-full max-h-48 object-cover rounded-xl" />
              <button
                type="button"
                onClick={() => { setPhoto(null); setPhotoPreview(null) }}
                className="absolute top-2 right-2 w-7 h-7 rounded-full bg-red-500 text-gray-900 flex items-center justify-center text-sm"
              >
                ✕
              </button>
            </div>
          )}
        </div>

        {error && (
          <p className="text-red-400 text-sm text-center bg-red-400/10 rounded-lg py-2">{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full py-3 rounded-xl text-gray-900 font-semibold transition-all disabled:opacity-50"
          className="bg-[#863bff] hover:bg-[#7e14ff]"
        >
          {submitting ? 'Envoi en cours...' : isManager ? 'Creer (auto-approuvee)' : 'Soumettre'}
        </button>
      </form>
    </div>
  )
}

// === Employee View ===============================================================
interface EmployeeViewProps {
  userId: string
  userName: string
  onLogout: () => void
}

function EmployeeView({ userId, userName, onLogout }: EmployeeViewProps) {
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)

  useEffect(() => {
    const q = query(
      collection(db, 'expenses'),
      where('employeeId', '==', userId),
      orderBy('createdAt', 'desc')
    )
    const unsub = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(d => ({
        id: d.id,
        ...d.data(),
        date: d.data().date?.toDate?.() || new Date(),
        createdAt: d.data().createdAt?.toDate?.() || new Date(),
        updatedAt: d.data().updatedAt?.toDate?.() || new Date(),
      })) as Expense[]
      setExpenses(data)
      setLoading(false)
    }, (err) => {
      console.error('Error fetching expenses:', err)
      setLoading(false)
    })
    return () => unsub()
  }, [userId])

  if (showForm) {
    return (
      <div className="min-h-screen" className="min-h-screen">
        <ExpenseForm
          employeeId={userId}
          employeeName={userName}
          isManager={false}
          onSubmit={() => setShowForm(false)}
          onCancel={() => setShowForm(false)}
        />
      </div>
    )
  }

  return (
    <div className="min-h-screen" className="min-h-screen">
      {photoUrl && <PhotoModal url={photoUrl} onClose={() => setPhotoUrl(null)} />}

      {/* Header */}
      <div className="px-4 pt-6 pb-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2"><img src="/logo.png" alt="MyKrew" className="h-7" /><h1 className="text-xl font-bold text-gray-900">Spend</h1></div>
            <p className="text-gray-400 text-sm">{userName}</p>
          </div>
          <button
            onClick={onLogout}
            className="text-gray-400 hover:text-gray-900 text-sm px-3 py-1 rounded-lg border border-gray-200"
          >
            Deconnexion
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="px-4 mb-4 grid grid-cols-2 gap-3">
        <div className="p-3 rounded-xl" className="bg-white border border-gray-200 shadow-sm">
          <p className="text-xs text-gray-400">En attente</p>
          <p className="text-lg font-bold text-[#fbbf24]">
            {expenses.filter(e => e.status === 'pending').reduce((s, e) => s + e.amountTTC, 0).toFixed(2)} EUR
          </p>
        </div>
        <div className="p-3 rounded-xl" className="bg-white border border-gray-200 shadow-sm">
          <p className="text-xs text-gray-400">Ce mois</p>
          <p className="text-lg font-bold text-gray-900">
            {expenses
              .filter(e => {
                const d = e.date instanceof Date ? e.date : new Date()
                const now = new Date()
                return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
              })
              .reduce((s, e) => s + e.amountTTC, 0).toFixed(2)} EUR
          </p>
        </div>
      </div>

      {/* Expense list */}
      <div className="px-4">
        {loading ? (
          <div className="text-center py-12">
            <div className="w-8 h-8 border-4 border-[#863bff] border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-gray-400 mt-3">Chargement...</p>
          </div>
        ) : expenses.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-4xl mb-2">💸</p>
            <p className="text-gray-400">Aucune depense</p>
          </div>
        ) : (
          <div className="space-y-3 pb-24">
            {expenses.map(exp => (
              <div
                key={exp.id}
                className="p-4 rounded-xl"
                className="bg-white border border-gray-200 shadow-sm"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <CategoryBadge category={exp.category} />
                      <StatusBadge status={exp.status} />
                    </div>
                    <p className="text-gray-900 font-medium text-sm truncate">{exp.description}</p>
                    <p className="text-gray-400 text-xs mt-0.5">
                      {exp.location} • {exp.date instanceof Date ? exp.date.toLocaleDateString('fr-FR') : ''}
                    </p>
                    {exp.rejectionReason && (
                      <p className="text-red-400 text-xs mt-1">Motif: {exp.rejectionReason}</p>
                    )}
                  </div>
                  <div className="text-right ml-3">
                    <p className="text-gray-900 font-bold">{exp.amountTTC.toFixed(2)} EUR</p>
                    {exp.receiptUrl && (
                      <button
                        onClick={() => setPhotoUrl(exp.receiptUrl!)}
                        className="text-[#863bff] text-xs mt-1 hover:underline"
                      >
                        📷 Voir
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* FAB */}
      <button
        onClick={() => setShowForm(true)}
        className="fixed bottom-6 right-6 w-14 h-14 rounded-full flex items-center justify-center text-gray-900 text-2xl shadow-lg shadow-[#863bff]/30 active:scale-95 transition-transform"
        className="bg-[#863bff] hover:bg-[#7e14ff]"
      >
        +
      </button>
    </div>
  )
}

// === Manager View ================================================================
interface ManagerViewProps {
  userId: string
  userName: string
  onLogout: () => void
}

type ManagerTab = 'dashboard' | 'pending' | 'all' | 'new'

function ManagerView({ userId, userName, onLogout }: ManagerViewProps) {
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<ManagerTab>('dashboard')
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<ExpenseStatus | 'all'>('all')
  const [filterCategory, setFilterCategory] = useState<ExpenseCategory | 'all'>('all')
  const [filterMonth, setFilterMonth] = useState(new Date().toISOString().slice(0, 7))
  const [rejectionReason, setRejectionReason] = useState('')
  const [rejectingId, setRejectingId] = useState<string | null>(null)

  useEffect(() => {
    const q = query(
      collection(db, 'expenses'),
      orderBy('createdAt', 'desc')
    )
    const unsub = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(d => ({
        id: d.id,
        ...d.data(),
        date: d.data().date?.toDate?.() || new Date(),
        createdAt: d.data().createdAt?.toDate?.() || new Date(),
        updatedAt: d.data().updatedAt?.toDate?.() || new Date(),
        approvedAt: d.data().approvedAt?.toDate?.() || undefined,
        reimbursedAt: d.data().reimbursedAt?.toDate?.() || undefined,
      })) as Expense[]
      setExpenses(data)
      setLoading(false)
    }, (err) => {
      console.error('Error fetching expenses:', err)
      setLoading(false)
    })
    return () => unsub()
  }, [])

  const handleApprove = async (expenseId: string) => {
    try {
      await updateDoc(doc(db, 'expenses', expenseId), {
        status: 'approved',
        approvedAt: Timestamp.now(),
        approvedBy: userId,
        updatedAt: Timestamp.now(),
      })
    } catch (err) {
      console.error('Error approving expense:', err)
    }
  }

  const handleReject = async (expenseId: string) => {
    if (!rejectionReason.trim()) return
    try {
      await updateDoc(doc(db, 'expenses', expenseId), {
        status: 'rejected',
        rejectionReason: rejectionReason.trim(),
        updatedAt: Timestamp.now(),
      })
      setRejectingId(null)
      setRejectionReason('')
    } catch (err) {
      console.error('Error rejecting expense:', err)
    }
  }

  const handleReimburse = async (expenseId: string) => {
    try {
      await updateDoc(doc(db, 'expenses', expenseId), {
        status: 'reimbursed',
        reimbursedAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      })
    } catch (err) {
      console.error('Error marking as reimbursed:', err)
    }
  }

  // Filtered expenses for "all" tab
  const filteredExpenses = expenses.filter(exp => {
    if (filterStatus !== 'all' && exp.status !== filterStatus) return false
    if (filterCategory !== 'all' && exp.category !== filterCategory) return false
    if (filterMonth) {
      const d = exp.date instanceof Date ? exp.date : new Date()
      const expMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      if (expMonth !== filterMonth) return false
    }
    return true
  })

  const pendingExpenses = expenses.filter(e => e.status === 'pending')

  // CSV Export
  const exportCSV = () => {
    const header = 'Date,Employe,Categorie,Lieu,Description,HT,TVA,TTC,Statut'
    const rows = filteredExpenses.map(exp => {
      const d = exp.date instanceof Date ? exp.date.toLocaleDateString('fr-FR') : ''
      const cat = CATEGORY_LABELS[exp.category] || exp.category
      const status = STATUS_CONFIG[exp.status]?.label || exp.status
      const loc = `"${(exp.location || '').replace(/"/g, '""')}"`
      const desc = `"${(exp.description || '').replace(/"/g, '""')}"`
      const ht = (exp.amountHT || 0).toFixed(2)
      const vat = (exp.vatAmount || 0).toFixed(2)
      const ttc = exp.amountTTC.toFixed(2)
      return `${d},${exp.employeeName},${cat},${loc},${desc},${ht},${vat},${ttc},${status}`
    })
    const csv = [header, ...rows].join('\n')
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `depenses_${filterMonth || 'export'}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  // Dashboard stats
  const now = new Date()
  const thisMonth = expenses.filter(e => {
    const d = e.date instanceof Date ? e.date : new Date()
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
  })
  const totalPending = pendingExpenses.reduce((s, e) => s + e.amountTTC, 0)
  const totalApprovedMonth = thisMonth
    .filter(e => ['approved', 'reimbursed', 'self_approved'].includes(e.status))
    .reduce((s, e) => s + e.amountTTC, 0)
  const byCategory = Object.keys(CATEGORY_LABELS).map(cat => ({
    category: cat as ExpenseCategory,
    total: thisMonth.filter(e => e.category === cat).reduce((s, e) => s + e.amountTTC, 0),
  })).filter(c => c.total > 0)

  if (activeTab === 'new') {
    return (
      <div className="min-h-screen" className="min-h-screen">
        <ExpenseForm
          employeeId={userId}
          employeeName={userName}
          isManager={true}
          onSubmit={() => setActiveTab('dashboard')}
          onCancel={() => setActiveTab('dashboard')}
        />
      </div>
    )
  }

  return (
    <div className="min-h-screen pb-20" className="min-h-screen">
      {photoUrl && <PhotoModal url={photoUrl} onClose={() => setPhotoUrl(null)} />}

      {/* Header */}
      <div className="px-4 pt-6 pb-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2"><img src="/logo.png" alt="MyKrew" className="h-7" /><h1 className="text-xl font-bold text-gray-900">Spend</h1></div>
            <p className="text-gray-400 text-sm">Responsable : {userName}</p>
          </div>
          <button
            onClick={onLogout}
            className="text-gray-400 hover:text-gray-900 text-sm px-3 py-1 rounded-lg border border-gray-200"
          >
            Deconnexion
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-4 mb-4 flex gap-2 overflow-x-auto">
        {([
          { key: 'dashboard', label: '📊 Tableau' },
          { key: 'pending', label: `⏳ A traiter (${pendingExpenses.length})` },
          { key: 'all', label: '�� Toutes' },
          { key: 'new', label: '➕ Nouvelle' },
        ] as { key: ManagerTab; label: string }[]).map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
              activeTab === tab.key
                ? 'text-gray-900'
                : 'text-gray-400 hover:text-gray-900'
            }`}
            style={activeTab === tab.key ? { backgroundColor: '#863bff' } : { backgroundColor: '#242640' }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-12">
          <div className="w-8 h-8 border-4 border-[#863bff] border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-gray-400 mt-3">Chargement...</p>
        </div>
      ) : (
        <>
          {/* Dashboard Tab */}
          {activeTab === 'dashboard' && (
            <div className="px-4 space-y-4">
              {/* Summary cards */}
              <div className="grid grid-cols-2 gap-3">
                <div className="p-4 rounded-xl" className="bg-white border border-gray-200 shadow-sm">
                  <p className="text-xs text-gray-400">En attente</p>
                  <p className="text-xl font-bold text-[#fbbf24]">{totalPending.toFixed(2)} EUR</p>
                  <p className="text-xs text-gray-400">{pendingExpenses.length} depense(s)</p>
                </div>
                <div className="p-4 rounded-xl" className="bg-white border border-gray-200 shadow-sm">
                  <p className="text-xs text-gray-400">Approuvees (mois)</p>
                  <p className="text-xl font-bold text-[#4ade80]">{totalApprovedMonth.toFixed(2)} EUR</p>
                  <p className="text-xs text-gray-400">{thisMonth.filter(e => ['approved', 'reimbursed', 'self_approved'].includes(e.status)).length} depense(s)</p>
                </div>
              </div>

              {/* By category */}
              {byCategory.length > 0 && (
                <div className="p-4 rounded-xl" className="bg-white border border-gray-200 shadow-sm">
                  <p className="text-sm text-gray-400 mb-3">Par categorie (ce mois)</p>
                  <div className="space-y-2">
                    {byCategory.sort((a, b) => b.total - a.total).map(c => (
                      <div key={c.category} className="flex items-center justify-between">
                        <CategoryBadge category={c.category} />
                        <span className="text-gray-900 text-sm font-medium">{c.total.toFixed(2)} EUR</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Quick pending preview */}
              {pendingExpenses.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm text-gray-400">Dernieres en attente</p>
                    <button
                      onClick={() => setActiveTab('pending')}
                      className="text-xs text-[#863bff] hover:underline"
                    >
                      Voir tout →
                    </button>
                  </div>
                  {pendingExpenses.slice(0, 3).map(exp => (
                    <div key={exp.id} className="p-3 rounded-xl mb-2" className="bg-white border border-gray-200 shadow-sm">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-gray-900 text-sm font-medium">{exp.employeeName}</p>
                          <p className="text-gray-400 text-xs">{exp.description}</p>
                        </div>
                        <p className="text-gray-900 font-bold text-sm">{exp.amountTTC.toFixed(2)} EUR</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Pending Tab */}
          {activeTab === 'pending' && (
            <div className="px-4 space-y-3">
              {pendingExpenses.length === 0 ? (
                <div className="text-center py-12">
                  <p className="text-4xl mb-2">✅</p>
                  <p className="text-gray-400">Aucune depense en attente</p>
                </div>
              ) : (
                pendingExpenses.map(exp => (
                  <div key={exp.id} className="p-4 rounded-xl" className="bg-white border border-gray-200 shadow-sm">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-gray-900 font-medium text-sm">{exp.employeeName}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <CategoryBadge category={exp.category} />
                        </div>
                        <p className="text-gray-400 text-xs mt-1 truncate">{exp.description}</p>
                        <p className="text-gray-400 text-xs">
                          {exp.location} • {exp.date instanceof Date ? exp.date.toLocaleDateString('fr-FR') : ''}
                        </p>
                        {exp.project && <p className="text-gray-400 text-xs">Projet: {exp.project}</p>}
                      </div>
                      <div className="text-right ml-3">
                        <p className="text-gray-900 font-bold">{exp.amountTTC.toFixed(2)} EUR</p>
                        <p className="text-gray-400 text-xs">HT: {(exp.amountHT || 0).toFixed(2)}</p>
                        {exp.receiptUrl && (
                          <button
                            onClick={() => setPhotoUrl(exp.receiptUrl!)}
                            className="text-[#863bff] text-xs mt-1 hover:underline"
                          >
                            📷 Justificatif
                          </button>
                        )}
                      </div>
                    </div>

                    {rejectingId === exp.id ? (
                      <div className="mt-3 space-y-2">
                        <input
                          type="text"
                          value={rejectionReason}
                          onChange={e => setRejectionReason(e.target.value)}
                          placeholder="Motif du refus..."
                          className="w-full px-3 py-2 rounded-lg bg-white text-gray-900 border border-gray-200 text-sm focus:border-red-400 focus:outline-none"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleReject(exp.id)}
                            disabled={!rejectionReason.trim()}
                            className="flex-1 py-2 rounded-lg text-sm font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 disabled:opacity-50"
                          >
                            Confirmer refus
                          </button>
                          <button
                            onClick={() => { setRejectingId(null); setRejectionReason('') }}
                            className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-900"
                          >
                            Annuler
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-2 mt-3">
                        <button
                          onClick={() => handleApprove(exp.id)}
                          className="flex-1 py-2 rounded-lg text-sm font-medium bg-green-500/20 text-green-400 hover:bg-green-500/30"
                        >
                          ✓ Approuver
                        </button>
                        <button
                          onClick={() => setRejectingId(exp.id)}
                          className="flex-1 py-2 rounded-lg text-sm font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30"
                        >
                          ✕ Refuser
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {/* All Expenses Tab */}
          {activeTab === 'all' && (
            <div className="px-4">
              {/* Filters */}
              <div className="space-y-3 mb-4">
                <div className="grid grid-cols-3 gap-2">
                  <select
                    value={filterStatus}
                    onChange={e => setFilterStatus(e.target.value as ExpenseStatus | 'all')}
                    className="px-3 py-2 rounded-lg bg-gray-50 text-gray-900 border border-gray-200 text-xs focus:border-[#863bff] focus:outline-none"
                  >
                    <option value="all">Tous statuts</option>
                    <option value="pending">En attente</option>
                    <option value="approved">Approuvee</option>
                    <option value="rejected">Refusee</option>
                    <option value="reimbursed">Remboursee</option>
                    <option value="self_approved">Auto-approuvee</option>
                  </select>
                  <select
                    value={filterCategory}
                    onChange={e => setFilterCategory(e.target.value as ExpenseCategory | 'all')}
                    className="px-3 py-2 rounded-lg bg-gray-50 text-gray-900 border border-gray-200 text-xs focus:border-[#863bff] focus:outline-none"
                  >
                    <option value="all">Categories</option>
                    {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                  <input
                    type="month"
                    value={filterMonth}
                    onChange={e => setFilterMonth(e.target.value)}
                    className="px-3 py-2 rounded-lg bg-gray-50 text-gray-900 border border-gray-200 text-xs focus:border-[#863bff] focus:outline-none"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-gray-400">{filteredExpenses.length} depense(s) • {filteredExpenses.reduce((s, e) => s + e.amountTTC, 0).toFixed(2)} EUR TTC</p>
                  <button
                    onClick={exportCSV}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-[#863bff] border border-[#863bff] hover:bg-[#863bff]/10"
                  >
                    📥 Export CSV
                  </button>
                </div>
              </div>

              {/* Expense list */}
              {filteredExpenses.length === 0 ? (
                <div className="text-center py-12">
                  <p className="text-4xl mb-2">🔍</p>
                  <p className="text-gray-400">Aucune depense trouvee</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredExpenses.map(exp => (
                    <div key={exp.id} className="p-4 rounded-xl" className="bg-white border border-gray-200 shadow-sm">
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <StatusBadge status={exp.status} />
                            <CategoryBadge category={exp.category} />
                          </div>
                          <p className="text-gray-900 font-medium text-sm">{exp.employeeName}</p>
                          <p className="text-gray-400 text-xs truncate">{exp.description}</p>
                          <p className="text-gray-400 text-xs">
                            {exp.location} • {exp.date instanceof Date ? exp.date.toLocaleDateString('fr-FR') : ''}
                          </p>
                        </div>
                        <div className="text-right ml-3">
                          <p className="text-gray-900 font-bold text-sm">{exp.amountTTC.toFixed(2)} EUR</p>
                          {exp.receiptUrl && (
                            <button
                              onClick={() => setPhotoUrl(exp.receiptUrl!)}
                              className="text-[#863bff] text-xs mt-1 hover:underline"
                            >
                              📷
                            </button>
                          )}
                        </div>
                      </div>
                      {/* Reimburse button for approved expenses */}
                      {exp.status === 'approved' && (
                        <button
                          onClick={() => handleReimburse(exp.id)}
                          className="mt-3 w-full py-2 rounded-lg text-xs font-medium bg-[#863bff]/20 text-[#a78bfa] hover:bg-[#863bff]/30"
                        >
                          💰 Marquer comme remboursee
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// === Main App ====================================================================
export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [role, setRole] = useState<'manager' | 'employee' | null>(null)
  const [userName, setUserName] = useState('')
  const [authLoading, setAuthLoading] = useState(true)
  const [roleLoading, setRoleLoading] = useState(false)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setUser(firebaseUser)
        setRoleLoading(true)
        try {
          const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid))
          if (userDoc.exists()) {
            const data = userDoc.data()
            setRole(data.role as 'manager' | 'employee')
            setUserName(`${data.firstName || ''} ${data.lastName || ''}`.trim() || firebaseUser.email || '')
          } else {
            // Default to employee if no doc found
            setRole('employee')
            setUserName(firebaseUser.email || '')
          }
        } catch (err) {
          console.error('Error fetching user role:', err)
          setRole('employee')
          setUserName(firebaseUser.email || '')
        } finally {
          setRoleLoading(false)
        }
      } else {
        setUser(null)
        setRole(null)
        setUserName('')
      }
      setAuthLoading(false)
    })
    return () => unsub()
  }, [])

  const handleLogout = async () => {
    try {
      await signOut(auth)
    } catch (err) {
      console.error('Error signing out:', err)
    }
  }

  // Loading state
  if (authLoading || roleLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" className="min-h-screen">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-[#863bff] border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-gray-400 mt-4 text-sm">Chargement...</p>
        </div>
      </div>
    )
  }

  // Not authenticated
  if (!user) {
    return <LoginPage onLogin={() => {}} />
  }

  // Role-based view
  if (role === 'manager') {
    return <ManagerView userId={user.uid} userName={userName} onLogout={handleLogout} />
  }

  return <EmployeeView userId={user.uid} userName={userName} onLogout={handleLogout} />
}