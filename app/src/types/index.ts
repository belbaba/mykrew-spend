export interface User {
  uid: string
  email: string
  firstName: string
  lastName: string
  role: 'manager' | 'employee'
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

export type ExpenseCategory =
  | 'meal'
  | 'transport'
  | 'accommodation'
  | 'supplies'
  | 'telecom'
  | 'training'
  | 'other'

export type ExpenseStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'reimbursed'
  | 'cancelled'
  | 'self_approved' // responsable pour lui-meme

export interface Expense {
  id: string
  employeeId: string
  employeeName: string
  // Montants
  amountTTC: number
  amountHT?: number
  vatRate?: number // 0, 5.5, 10, 20
  vatAmount?: number
  // Details
  date: Date // date de la depense
  location: string
  category: ExpenseCategory
  description: string
  project?: string
  // Justificatif
  receiptUrl?: string
  receiptPath?: string // chemin dans Storage
  // Statut
  status: ExpenseStatus
  rejectionReason?: string
  reimbursedAt?: Date
  // Meta
  createdAt: Date
  updatedAt: Date
  approvedAt?: Date
  approvedBy?: string
}

export interface BudgetLimit {
  category: ExpenseCategory
  monthlyLimit: number // en euros
  isActive: boolean
}

export interface MonthlyStats {
  totalTTC: number
  totalHT: number
  totalVAT: number
  count: number
  byCategory: Record<ExpenseCategory, { total: number; count: number }>
  byEmployee: Record<string, { name: string; total: number; count: number }>
}

export const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  meal: 'Repas',
  transport: 'Transport',
  accommodation: 'Hebergement',
  supplies: 'Fournitures',
  telecom: 'Telephone / Internet',
  training: 'Formation',
  other: 'Autre',
}

export const CATEGORY_ICONS: Record<ExpenseCategory, string> = {
  meal: '🍽️',
  transport: '🚗',
  accommodation: '🏨',
  supplies: '📦',
  telecom: '📱',
  training: '🎓',
  other: '📋',
}

export const VAT_RATES = [
  { value: 0, label: '0%' },
  { value: 5.5, label: '5.5%' },
  { value: 10, label: '10%' },
  { value: 20, label: '20%' },
]