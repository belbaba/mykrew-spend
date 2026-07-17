import { onCall, HttpsError, onRequest } from 'firebase-functions/v2/https'
import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { defineString } from 'firebase-functions/params'
import * as admin from 'firebase-admin'
import { Resend } from 'resend'

admin.initializeApp()
const db = admin.firestore()

// --- Params ---
const resendApiKey = defineString('RESEND_API_KEY')
const senderEmail = defineString('SENDER_EMAIL', { default: 'MyKrew Spend <noreply@mykrew.pro>' })
const appUrl = defineString('APP_URL', { default: 'https://spend.mykrew.pro' })
const adminEmail = defineString('ADMIN_EMAIL')

// --- Helpers ---

function getResend(): Resend {
  return new Resend(resendApiKey.value())
}

/**
 * Enregistre une action dans les logs d activite
 */
async function logActivity(action: string, details: Record<string, unknown>, userId?: string): Promise<void> {
  try {
    await db.collection('activityLogs').add({
      action,
      details,
      userId: userId || 'system',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      environment: process.env.GCLOUD_PROJECT || 'mykrew-spend',
    })
  } catch (err) {
    console.error('Erreur ecriture log:', err)
  }
}

/**
 * Incremente le compteur d emails envoyes pour le mois en cours
 */
async function incrementEmailCounter(): Promise<void> {
  const now = new Date()
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  const monthRef = db.collection('emailStats').doc(monthKey)
  const dayRef = db.collection('emailStats').doc(monthKey).collection('days').doc(dayKey)

  await monthRef.set(
    { count: admin.firestore.FieldValue.increment(1), updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  )
  await dayRef.set(
    { count: admin.firestore.FieldValue.increment(1), date: dayKey },
    { merge: true }
  )
}

/**
 * Template email HTML avec le style MyKrew Spend (dark theme)
 */
function emailTemplate(title: string, body: string, ctaUrl?: string, ctaText?: string): string {
  const cta = ctaUrl && ctaText
    ? `<a href="${ctaUrl}" style="background-color:#7c3aed;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;margin-top:16px;font-weight:600;">${ctaText}</a>`
    : ''
  return `
    <div style="background-color:#1a1b2e;padding:40px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:600px;margin:0 auto;background-color:#242640;border-radius:12px;overflow:hidden;border:1px solid #363858;">
        <div style="background:linear-gradient(135deg,#7c3aed,#6d28d9);padding:24px 32px;">
          <h1 style="color:white;margin:0;font-size:20px;">MyKrew Spend</h1>
        </div>
        <div style="padding:32px;color:#e2e8f0;">
          <h2 style="color:#f1f5f9;margin:0 0 16px;font-size:18px;">${title}</h2>
          ${body}
          ${cta ? `<div style="margin-top:24px;">${cta}</div>` : ''}
        </div>
        <div style="padding:16px 32px;border-top:1px solid #363858;text-align:center;">
          <p style="color:#64748b;font-size:11px;margin:0;">MyKrew Spend — Gestion des notes de frais</p>
        </div>
      </div>
    </div>
  `
}
// --- Cloud Functions ---

/**
 * Creer un employe (compte Auth + profil Firestore)
 */
export const createEmployee = onCall({ region: 'europe-west1' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Non authentifie')
  }

  const callerDoc = await db.collection('users').doc(request.auth.uid).get()
  if (!callerDoc.exists || callerDoc.data()?.role !== 'manager') {
    throw new HttpsError('permission-denied', 'Seuls les responsables peuvent ajouter des employes')
  }

  const { email, password, firstName, lastName, role, department } = request.data

  if (!email || !password || !firstName || !lastName) {
    throw new HttpsError('invalid-argument', 'Tous les champs sont obligatoires')
  }

  const userRole = role === 'manager' ? 'manager' : 'employee'

  if (password.length < 8) {
    throw new HttpsError('invalid-argument', 'Le mot de passe doit contenir au moins 8 caracteres')
  }

  // Verifier la limite de 40 utilisateurs actifs
  const MAX_EMPLOYEES = 40
  const usersSnap = await db.collection('users').where('isActive', '==', true).get()
  if (usersSnap.size >= MAX_EMPLOYEES) {
    throw new HttpsError('resource-exhausted', `Limite atteinte : maximum ${MAX_EMPLOYEES} utilisateurs actifs`)
  }

  try {
    const userRecord = await admin.auth().createUser({
      email: email.toLowerCase(),
      password: password,
      displayName: `${firstName} ${lastName}`,
    })

    await db.collection('users').doc(userRecord.uid).set({
      email: email.toLowerCase(),
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      role: userRole,
      department: department || '',
      managerId: request.auth.uid,
      isActive: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    await logActivity('employee_created', {
      newEmployeeId: userRecord.uid,
      email: email.toLowerCase(),
      role: userRole,
    }, request.auth.uid)

    return { success: true, uid: userRecord.uid }
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string }
    if (err.code === 'auth/email-already-exists') {
      throw new HttpsError('already-exists', 'Un compte avec cet email existe deja')
    }
    throw new HttpsError('internal', err.message || 'Erreur lors de la creation')
  }
})
/**
 * Supprimer un employe
 */
export const deleteEmployee = onCall({ region: 'europe-west1' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Non authentifie')
  }

  const callerDoc = await db.collection('users').doc(request.auth.uid).get()
  if (!callerDoc.exists || callerDoc.data()?.role !== 'manager') {
    throw new HttpsError('permission-denied', 'Seuls les responsables peuvent supprimer des employes')
  }

  const { employeeId } = request.data

  if (!employeeId) {
    throw new HttpsError('invalid-argument', 'ID employe manquant')
  }

  if (employeeId === request.auth.uid) {
    throw new HttpsError('permission-denied', 'Vous ne pouvez pas supprimer votre propre compte')
  }

  try {
    await admin.auth().deleteUser(employeeId)

    // Annuler les depenses en attente
    const expensesSnap = await db.collection('expenses')
      .where('employeeId', '==', employeeId)
      .where('status', '==', 'pending')
      .get()

    const batch = db.batch()
    expensesSnap.docs.forEach((doc) => {
      batch.update(doc.ref, { status: 'cancelled' })
    })

    batch.update(db.collection('users').doc(employeeId), {
      isActive: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    await batch.commit()

    await logActivity('employee_deleted', {
      deletedEmployeeId: employeeId,
      cancelledExpenses: expensesSnap.size,
    }, request.auth.uid)

    return { success: true }
  } catch (error: unknown) {
    const err = error as { message?: string }
    throw new HttpsError('internal', err.message || 'Erreur lors de la suppression')
  }
})
/**
 * Envoie un email aux managers quand un employe soumet une note de frais
 */
export const onExpenseCreated = onDocumentCreated(
  { document: 'expenses/{expenseId}', region: 'europe-west1' },
  async (event) => {
    const snapshot = event.data
    if (!snapshot) return

    const expense = snapshot.data()
    const expenseId = event.params.expenseId

    await logActivity('expense_created', {
      expenseId,
      employeeId: expense.employeeId,
      amount: expense.amount,
      category: expense.category,
    }, expense.employeeId)

    try {
      const managersSnap = await db.collection('users').where('role', '==', 'manager').get()
      const employeeDoc = await db.collection('users').doc(expense.employeeId).get()

      if (!employeeDoc.exists) return

      const employee = employeeDoc.data()!
      const expenseDate = expense.date?.toDate
        ? expense.date.toDate().toLocaleDateString('fr-FR')
        : new Date().toLocaleDateString('fr-FR')

      const body = `
        <p style="color:#cbd5e1;"><strong style="color:#f1f5f9;">${employee.firstName} ${employee.lastName}</strong> a soumis une note de frais.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;">
          <tr><td style="padding:8px 12px;border:1px solid #363858;color:#94a3b8;">Montant</td><td style="padding:8px 12px;border:1px solid #363858;color:#f1f5f9;font-weight:600;">${expense.amount.toFixed(2)} EUR</td></tr>
          <tr><td style="padding:8px 12px;border:1px solid #363858;color:#94a3b8;">Categorie</td><td style="padding:8px 12px;border:1px solid #363858;color:#f1f5f9;">${expense.category || 'Non categorise'}</td></tr>
          <tr><td style="padding:8px 12px;border:1px solid #363858;color:#94a3b8;">Date</td><td style="padding:8px 12px;border:1px solid #363858;color:#f1f5f9;">${expenseDate}</td></tr>
          <tr><td style="padding:8px 12px;border:1px solid #363858;color:#94a3b8;">Description</td><td style="padding:8px 12px;border:1px solid #363858;color:#f1f5f9;">${expense.description || '-'}</td></tr>
        </table>
      `

      for (const managerDoc of managersSnap.docs) {
        const manager = managerDoc.data()
        if (!manager.email) continue

        await getResend().emails.send({
          from: senderEmail.value(),
          to: manager.email,
          subject: `MyKrew Spend -- Nouvelle note de frais de ${employee.firstName} ${employee.lastName} (${expense.amount.toFixed(2)} EUR)`,
          html: emailTemplate(
            'Nouvelle note de frais',
            body,
            `${appUrl.value()}/manager/expense/${expenseId}`,
            'Voir la depense'
          ),
        })

        console.log(`Email envoye a ${manager.email} pour la depense ${expenseId}`)
        await incrementEmailCounter()
      }
    } catch (error) {
      console.error('Erreur envoi email onExpenseCreated:', error)
    }
  }
)
/**
 * Envoie des emails quand le statut d une depense change
 * - pending -> approved : email employe + email manager avec justificatif en PJ
 * - pending -> rejected : email employe avec motif de refus
 */
export const onExpenseUpdated = onDocumentUpdated(
  { document: 'expenses/{expenseId}', region: 'europe-west1' },
  async (event) => {
    if (!event.data) return

    const before = event.data.before.data()
    const after = event.data.after.data()

    // Ne reagir que si le statut change depuis 'pending'
    if (before.status !== 'pending' || after.status === 'pending') return

    await logActivity('expense_decided', {
      expenseId: event.params.expenseId,
      employeeId: after.employeeId,
      decision: after.status,
      amount: after.amount,
    })

    try {
      const employeeDoc = await db.collection('users').doc(after.employeeId).get()
      if (!employeeDoc.exists) return

      const employee = employeeDoc.data()!
      if (!employee.email) return

      if (after.status === 'approved') {
        // Email a l employe : depense approuvee
        const approvedBody = `
          <p style="color:#cbd5e1;">Votre note de frais a ete <strong style="color:#4ade80;">approuvee</strong>.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px 12px;border:1px solid #363858;color:#94a3b8;">Montant</td><td style="padding:8px 12px;border:1px solid #363858;color:#f1f5f9;font-weight:600;">${after.amount.toFixed(2)} EUR</td></tr>
            <tr><td style="padding:8px 12px;border:1px solid #363858;color:#94a3b8;">Categorie</td><td style="padding:8px 12px;border:1px solid #363858;color:#f1f5f9;">${after.category || '-'}</td></tr>
            <tr><td style="padding:8px 12px;border:1px solid #363858;color:#94a3b8;">Statut</td><td style="padding:8px 12px;border:1px solid #363858;color:#4ade80;font-weight:600;">Approuvee</td></tr>
          </table>
        `

        await getResend().emails.send({
          from: senderEmail.value(),
          to: employee.email,
          subject: `MyKrew Spend -- Votre note de frais de ${after.amount.toFixed(2)} EUR a ete approuvee`,
          html: emailTemplate('Note de frais approuvee', approvedBody, appUrl.value(), 'Ouvrir MyKrew Spend'),
        })
        await incrementEmailCounter()

        // Email au(x) manager(s) avec le justificatif en piece jointe
        if (after.receiptUrl) {
          try {
            const bucket = admin.storage().bucket()
            const receiptPath = after.receiptPath || after.receiptUrl
            const file = bucket.file(receiptPath)

            const [fileBuffer] = await file.download()
            const base64Content = fileBuffer.toString('base64')

            const [metadata] = await file.getMetadata()
            const contentType = metadata.contentType || 'image/jpeg'
            const extension = contentType.includes('png') ? 'png' : contentType.includes('pdf') ? 'pdf' : 'jpg'
            const filename = `justificatif-${employee.firstName.toLowerCase()}-${after.amount.toFixed(2)}EUR.${extension}`

            const managerBody = `
              <p style="color:#cbd5e1;">Note de frais approuvee pour <strong style="color:#f1f5f9;">${employee.firstName} ${employee.lastName}</strong>.</p>
              <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                <tr><td style="padding:8px 12px;border:1px solid #363858;color:#94a3b8;">Montant</td><td style="padding:8px 12px;border:1px solid #363858;color:#f1f5f9;font-weight:600;">${after.amount.toFixed(2)} EUR</td></tr>
                <tr><td style="padding:8px 12px;border:1px solid #363858;color:#94a3b8;">Categorie</td><td style="padding:8px 12px;border:1px solid #363858;color:#f1f5f9;">${after.category || '-'}</td></tr>
                <tr><td style="padding:8px 12px;border:1px solid #363858;color:#94a3b8;">Description</td><td style="padding:8px 12px;border:1px solid #363858;color:#f1f5f9;">${after.description || '-'}</td></tr>
              </table>
              <p style="color:#94a3b8;font-size:13px;">Le justificatif est en piece jointe.</p>
            `

            const managersSnap = await db.collection('users').where('role', '==', 'manager').get()
            for (const managerDoc of managersSnap.docs) {
              const manager = managerDoc.data()
              if (!manager.email) continue

              await getResend().emails.send({
                from: senderEmail.value(),
                to: manager.email,
                subject: `MyKrew Spend -- Justificatif : ${employee.firstName} ${employee.lastName} - ${after.amount.toFixed(2)} EUR`,
                html: emailTemplate('Justificatif de note de frais', managerBody),
                attachments: [
                  {
                    filename,
                    content: base64Content,
                  },
                ],
              })
              await incrementEmailCounter()
            }
          } catch (attachError) {
            console.error('Erreur envoi justificatif aux managers:', attachError)
          }
        }
      } else if (after.status === 'rejected') {
        // Email a l employe : depense refusee
        const rejectedBody = `
          <p style="color:#cbd5e1;">Votre note de frais a ete <strong style="color:#f87171;">refusee</strong>.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px 12px;border:1px solid #363858;color:#94a3b8;">Montant</td><td style="padding:8px 12px;border:1px solid #363858;color:#f1f5f9;font-weight:600;">${after.amount.toFixed(2)} EUR</td></tr>
            <tr><td style="padding:8px 12px;border:1px solid #363858;color:#94a3b8;">Categorie</td><td style="padding:8px 12px;border:1px solid #363858;color:#f1f5f9;">${after.category || '-'}</td></tr>
            <tr><td style="padding:8px 12px;border:1px solid #363858;color:#94a3b8;">Statut</td><td style="padding:8px 12px;border:1px solid #363858;color:#f87171;font-weight:600;">Refusee</td></tr>
            ${after.rejectionReason ? `<tr><td style="padding:8px 12px;border:1px solid #363858;color:#94a3b8;">Motif</td><td style="padding:8px 12px;border:1px solid #363858;color:#fbbf24;">${after.rejectionReason}</td></tr>` : ''}
          </table>
        `

        await getResend().emails.send({
          from: senderEmail.value(),
          to: employee.email,
          subject: `MyKrew Spend -- Votre note de frais de ${after.amount.toFixed(2)} EUR a ete refusee`,
          html: emailTemplate('Note de frais refusee', rejectedBody, appUrl.value(), 'Ouvrir MyKrew Spend'),
        })
        await incrementEmailCounter()
      }
    } catch (error) {
      console.error('Erreur envoi email onExpenseUpdated:', error)
    }
  }
)
/**
 * Rapport quotidien : resume des depenses en attente et stats
 * Envoye tous les jours a 8h (Europe/Paris) aux managers
 */
export const dailySupervision = onSchedule(
  { schedule: '0 8 * * *', timeZone: 'Europe/Paris', region: 'europe-west1' },
  async () => {
    try {
      const pendingSnap = await db.collection('expenses').where('status', '==', 'pending').get()
      const managersSnap = await db.collection('users').where('role', '==', 'manager').get()

      if (managersSnap.empty) {
        console.log('Aucun manager trouve, supervision ignoree')
        return
      }

      // Stats du jour precedent
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      const yesterdayStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate())
      const yesterdayEnd = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 23, 59, 59)

      const yesterdayExpenses = await db.collection('expenses')
        .where('createdAt', '>=', yesterdayStart)
        .where('createdAt', '<=', yesterdayEnd)
        .get()

      const totalYesterday = yesterdayExpenses.docs.reduce((sum, doc) => sum + (doc.data().amount || 0), 0)

      // Stats globales en attente
      const totalPending = pendingSnap.docs.reduce((sum, doc) => sum + (doc.data().amount || 0), 0)

      // Depenses en attente depuis plus de 48h
      const now = new Date()
      const threshold48h = new Date(now.getTime() - 48 * 60 * 60 * 1000)
      const oldPending = pendingSnap.docs.filter((doc) => {
        const createdAt = doc.data().createdAt?.toDate?.()
        return createdAt && createdAt < threshold48h
      })

      const body = `
        <p style="color:#cbd5e1;">Voici le rapport quotidien de MyKrew Spend.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;">
          <tr><td style="padding:8px 12px;border:1px solid #363858;color:#94a3b8;">Depenses en attente</td><td style="padding:8px 12px;border:1px solid #363858;color:#f1f5f9;font-weight:600;">${pendingSnap.size}</td></tr>
          <tr><td style="padding:8px 12px;border:1px solid #363858;color:#94a3b8;">Montant total en attente</td><td style="padding:8px 12px;border:1px solid #363858;color:#f1f5f9;font-weight:600;">${totalPending.toFixed(2)} EUR</td></tr>
          <tr><td style="padding:8px 12px;border:1px solid #363858;color:#94a3b8;">En attente > 48h</td><td style="padding:8px 12px;border:1px solid #363858;color:${oldPending.length > 0 ? '#fbbf24' : '#4ade80'};font-weight:600;">${oldPending.length}</td></tr>
          <tr><td style="padding:8px 12px;border:1px solid #363858;color:#94a3b8;">Soumises hier</td><td style="padding:8px 12px;border:1px solid #363858;color:#f1f5f9;">${yesterdayExpenses.size} (${totalYesterday.toFixed(2)} EUR)</td></tr>
        </table>
        ${oldPending.length > 0 ? '<p style="color:#fbbf24;font-size:13px;">⚠️ Certaines depenses attendent une decision depuis plus de 48h.</p>' : '<p style="color:#4ade80;font-size:13px;">✓ Toutes les depenses sont traitees dans les delais.</p>'}
      `

      for (const managerDoc of managersSnap.docs) {
        const manager = managerDoc.data()
        if (!manager.email) continue

        await getResend().emails.send({
          from: senderEmail.value(),
          to: manager.email,
          subject: `MyKrew Spend -- Rapport quotidien : ${pendingSnap.size} depense(s) en attente`,
          html: emailTemplate('Rapport quotidien', body, appUrl.value(), 'Ouvrir MyKrew Spend'),
        })
        await incrementEmailCounter()
      }

      await logActivity('daily_supervision', {
        pendingCount: pendingSnap.size,
        totalPending,
        oldPendingCount: oldPending.length,
        yesterdayCount: yesterdayExpenses.size,
      })

      console.log(`Supervision quotidienne envoyee : ${pendingSnap.size} en attente, ${oldPending.length} > 48h`)
    } catch (error) {
      console.error('Erreur dailySupervision:', error)
    }
  }
)
/**
 * Backup quotidien de toutes les collections Firestore vers Cloud Storage
 * Execute tous les jours a 3h du matin
 */
export const dailyBackup = onSchedule(
  { schedule: '0 3 * * *', timeZone: 'Europe/Paris', region: 'europe-west1' },
  async () => {
    try {
      const projectId = process.env.GCLOUD_PROJECT || 'mykrew-spend'
      const bucket = admin.storage().bucket(`${projectId}-backups`)
      const now = new Date()
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      const backupPath = `backups/${dateStr}`

      const collections = ['users', 'expenses', 'emailStats', 'activityLogs', 'settings']
      const stats: Record<string, number> = {}

      for (const collectionName of collections) {
        const snap = await db.collection(collectionName).get()
        const data = snap.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }))

        const fileName = `${backupPath}/${collectionName}.json`
        const file = bucket.file(fileName)
        await file.save(JSON.stringify(data, null, 2), {
          contentType: 'application/json',
          metadata: {
            backupDate: dateStr,
            collection: collectionName,
            documentCount: String(data.length),
          },
        })

        stats[collectionName] = data.length
      }

      // Nettoyage des backups de plus de 30 jours
      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
      const oldDateStr = `${thirtyDaysAgo.getFullYear()}-${String(thirtyDaysAgo.getMonth() + 1).padStart(2, '0')}-${String(thirtyDaysAgo.getDate()).padStart(2, '0')}`

      const [files] = await bucket.getFiles({ prefix: 'backups/' })
      let deletedCount = 0
      for (const file of files) {
        const fileDateMatch = file.name.match(/backups\/(\d{4}-\d{2}-\d{2})\//)
        if (fileDateMatch && fileDateMatch[1] < oldDateStr) {
          await file.delete()
          deletedCount++
        }
      }

      await logActivity('daily_backup', {
        date: dateStr,
        stats,
        totalDocuments: Object.values(stats).reduce((a, b) => a + b, 0),
        oldBackupsDeleted: deletedCount,
      })

      // Email de confirmation a l admin
      await getResend().emails.send({
        from: senderEmail.value(),
        to: adminEmail.value(),
        subject: `MyKrew Spend -- Backup ${dateStr} termine`,
        html: emailTemplate(
          'Backup quotidien termine',
          `<p style="color:#cbd5e1;">Le backup du ${dateStr} a ete effectue avec succes.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            ${Object.entries(stats).map(([col, count]) => `<tr><td style="padding:8px 12px;border:1px solid #363858;color:#94a3b8;">${col}</td><td style="padding:8px 12px;border:1px solid #363858;color:#f1f5f9;">${count} documents</td></tr>`).join('')}
            <tr><td style="padding:8px 12px;border:1px solid #363858;color:#94a3b8;">Anciens backups supprimes</td><td style="padding:8px 12px;border:1px solid #363858;color:#f1f5f9;">${deletedCount}</td></tr>
          </table>`
        ),
      })
      await incrementEmailCounter()

      console.log(`Backup termine : ${JSON.stringify(stats)}, ${deletedCount} anciens fichiers supprimes`)
    } catch (error) {
      console.error('Erreur dailyBackup:', error)

      // Email d alerte en cas d echec
      try {
        await getResend().emails.send({
          from: senderEmail.value(),
          to: adminEmail.value(),
          subject: 'MyKrew Spend -- ERREUR Backup quotidien',
          html: emailTemplate(
            'Erreur backup quotidien',
            `<p style="color:#f87171;">Le backup quotidien a echoue.</p><p style="color:#94a3b8;font-size:13px;">${String(error)}</p>`
          ),
        })
      } catch (emailError) {
        console.error('Impossible d envoyer l alerte email:', emailError)
      }
    }
  }
)
/**
 * Nettoyage des fichiers orphelins dans Cloud Storage
 * Supprime les justificatifs dont la depense n existe plus
 * Execute tous les jours a 2h du matin
 */
export const storageCleanup = onSchedule(
  { schedule: '0 2 * * *', timeZone: 'Europe/Paris', region: 'europe-west1' },
  async () => {
    try {
      const bucket = admin.storage().bucket()
      const [files] = await bucket.getFiles({ prefix: 'receipts/' })

      if (files.length === 0) {
        console.log('Aucun fichier dans receipts/')
        return
      }

      // Recuperer tous les receiptPath des depenses existantes
      const expensesSnap = await db.collection('expenses').get()
      const validPaths = new Set<string>()
      expensesSnap.docs.forEach((doc) => {
        const data = doc.data()
        if (data.receiptPath) validPaths.add(data.receiptPath)
        if (data.receiptUrl && data.receiptUrl.startsWith('receipts/')) validPaths.add(data.receiptUrl)
      })

      let deletedCount = 0
      let deletedSize = 0

      for (const file of files) {
        if (!validPaths.has(file.name)) {
          // Verifier que le fichier a plus de 24h (eviter de supprimer un upload en cours)
          const [metadata] = await file.getMetadata()
          const createdAt = new Date(metadata.timeCreated as string)
          const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

          if (createdAt < oneDayAgo) {
            const fileSize = Number(metadata.size) || 0
            await file.delete()
            deletedCount++
            deletedSize += fileSize
          }
        }
      }

      await logActivity('storage_cleanup', {
        totalFiles: files.length,
        validFiles: validPaths.size,
        deletedCount,
        deletedSizeMB: (deletedSize / (1024 * 1024)).toFixed(2),
      })

      console.log(`Storage cleanup : ${deletedCount} fichiers orphelins supprimes (${(deletedSize / (1024 * 1024)).toFixed(2)} MB)`)
    } catch (error) {
      console.error('Erreur storageCleanup:', error)
    }
  }
)
/**
 * Endpoint de sante (health check)
 */
export const health = onRequest({ region: 'europe-west1', cors: true }, async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    // Verifier la connexion Firestore
    const testDoc = await db.collection('settings').doc('health').get()
    const firestoreOk = true

    // Stats rapides
    const usersSnap = await db.collection('users').where('isActive', '==', true).count().get()
    const pendingSnap = await db.collection('expenses').where('status', '==', 'pending').count().get()

    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      project: process.env.GCLOUD_PROJECT || 'mykrew-spend',
      region: 'europe-west1',
      services: {
        firestore: firestoreOk ? 'connected' : 'error',
      },
      stats: {
        activeUsers: usersSnap.data().count,
        pendingExpenses: pendingSnap.data().count,
      },
    })
  } catch (error) {
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: String(error),
    })
  }
})

/**
 * Endpoint billing : informations de facturation
 * Protege par header X-Billing-Key
 */
export const billingInfo = onRequest({ region: 'europe-west1', cors: true }, async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  // Verification du secret
  const billingSecret = process.env.BILLING_SECRET
  const providedKey = req.headers['x-billing-key'] as string | undefined

  if (!billingSecret || providedKey !== billingSecret) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  try {
    const now = new Date()
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

    // Utilisateurs actifs
    const usersSnap = await db.collection('users').where('isActive', '==', true).get()
    const activeUsers = usersSnap.size

    // Stats emails du mois
    const emailStatsDoc = await db.collection('emailStats').doc(monthKey).get()
    const emailsSent = emailStatsDoc.exists ? emailStatsDoc.data()?.count || 0 : 0

    // Stats depenses du mois
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const expensesSnap = await db.collection('expenses')
      .where('createdAt', '>=', monthStart)
      .get()

    const monthlyExpenses = expensesSnap.docs.reduce((sum, doc) => sum + (doc.data().amount || 0), 0)
    const approvedCount = expensesSnap.docs.filter((doc) => doc.data().status === 'approved').length
    const rejectedCount = expensesSnap.docs.filter((doc) => doc.data().status === 'rejected').length
    const pendingCount = expensesSnap.docs.filter((doc) => doc.data().status === 'pending').length

    // Stockage utilise
    const bucket = admin.storage().bucket()
    const [files] = await bucket.getFiles({ prefix: 'receipts/' })
    const totalStorageMB = files.reduce((sum, file) => {
      const size = Number(file.metadata?.size) || 0
      return sum + size
    }, 0) / (1024 * 1024)

    res.status(200).json({
      status: 'ok',
      period: monthKey,
      billing: {
        activeUsers,
        pricePerUser: 1.00,
        monthlyTotal: activeUsers * 1.00,
        currency: 'EUR',
      },
      usage: {
        emailsSent,
        expenses: {
          total: expensesSnap.size,
          approved: approvedCount,
          rejected: rejectedCount,
          pending: pendingCount,
          totalAmount: Number(monthlyExpenses.toFixed(2)),
        },
        storageMB: Number(totalStorageMB.toFixed(2)),
        receiptsCount: files.length,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: String(error),
    })
  }
})