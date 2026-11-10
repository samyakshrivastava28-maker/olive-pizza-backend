import { adminDb, adminAuth } from '../../config/firebase.js';
import { sendEmailDirect } from '../email.service.js';
import { AuthAuditService } from './AuthAuditService.js';

export type PasswordResetStatus = 'PENDING_OWNER_ACTION' | 'RESET_EMAIL_SENT' | 'REJECTED';

export interface PasswordResetRequestData {
  id: string;
  email: string;
  posId?: string;
  franchiseId?: string;
  requestedAt: string;
  status: PasswordResetStatus;
  handledAt?: string;
  handledBy?: string;
  rejectReason?: string;
}

export class PasswordResetWorkflowService {
  private static readonly COLLECTION = 'password_reset_requests';

  /**
   * POS operator submits a password reset request.
   */
  public static async requestReset(email: string, appTarget: string = 'POS'): Promise<{ success: boolean; message: string; requestId?: string }> {
    if (!email || !email.includes('@')) {
      return { success: false, message: 'A valid email address is required.' };
    }

    const cleanEmail = email.toLowerCase().trim();

    if (!adminDb) {
      return { success: false, message: 'Database service unavailable.' };
    }

    // Check if user exists in Firebase Auth
    let uid = '';
    let franchiseId = '';
    try {
      if (adminAuth) {
        const user = await adminAuth.getUserByEmail(cleanEmail);
        uid = user.uid;
      }
    } catch (err) {
      return { success: false, message: 'No registered account found with this email address.' };
    }

    // Check if user has a franchise mapping
    try {
      const userDoc = await adminDb.collection('users').doc(uid).get();
      if (userDoc.exists) {
        franchiseId = userDoc.data()?.franchiseId || '';
      }
    } catch (err) {
      // Ignore
    }

    // Check for recent pending request
    const existing = await adminDb
      .collection(this.COLLECTION)
      .where('email', '==', cleanEmail)
      .where('status', '==', 'PENDING_OWNER_ACTION')
      .limit(1)
      .get();

    if (!existing.empty) {
      return {
        success: true,
        message: 'A password reset request is already pending Owner review. Your Owner will be notified.',
        requestId: existing.docs[0].id,
      };
    }

    const requestRecord = {
      email: cleanEmail,
      posId: uid,
      franchiseId,
      appTarget,
      status: 'PENDING_OWNER_ACTION' as PasswordResetStatus,
      requestedAt: new Date().toISOString(),
    };

    const docRef = await adminDb.collection(this.COLLECTION).add(requestRecord);

    await AuthAuditService.logEvent({
      eventType: 'PASSWORD_RESET_REQUESTED',
      userId: uid,
      identifier: cleanEmail,
      franchiseId,
      appTarget,
      status: 'SUCCESS',
      metadata: { requestId: docRef.id },
    });

    return {
      success: true,
      message: 'Password reset request submitted. Your store owner will review and dispatch your reset link.',
      requestId: docRef.id,
    };
  }

  /**
   * Owner approves request and sends Firebase Auth password reset link.
   */
  public static async sendResetEmail(requestId: string, ownerEmail: string): Promise<{ success: boolean; message: string }> {
    if (!adminDb || !adminAuth) {
      return { success: false, message: 'Authentication service unavailable.' };
    }

    const ref = adminDb.collection(this.COLLECTION).doc(requestId);
    const snap = await ref.get();

    if (!snap.exists) {
      return { success: false, message: 'Password reset request not found.' };
    }

    const reqData = snap.data() as PasswordResetRequestData;
    const cleanEmail = reqData.email;

    try {
      // Generate Firebase Auth Password Reset Link securely
      const resetLink = await adminAuth.generatePasswordResetLink(cleanEmail);

      // Deliver via styled email using existing direct transporter
      const emailHtml = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #f0f0f0; box-shadow: 0 4px 20px rgba(0,0,0,0.05);">
          <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 32px 24px; text-align: center;">
            <h1 style="color: #ffffff; margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -0.5px;">OLIVE PIZZA</h1>
            <p style="color: #d1fae5; margin: 6px 0 0 0; font-size: 14px; font-weight: 500;">Password Reset Authorization</p>
          </div>
          <div style="padding: 32px 28px;">
            <p style="color: #374151; font-size: 15px; line-height: 22px; margin: 0 0 16px 0;">
              Hello,
            </p>
            <p style="color: #374151; font-size: 15px; line-height: 22px; margin: 0 0 24px 0;">
              Your store owner has approved your password reset request for Olive Pizza POS. Click the button below to set your new password:
            </p>
            <div style="text-align: center; margin-bottom: 28px;">
              <a href="${resetLink}" target="_blank" style="display: inline-block; background: #059669; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-size: 15px; font-weight: 700; box-shadow: 0 4px 12px rgba(5, 150, 105, 0.3);">
                Reset My Password
              </a>
            </div>
            <div style="border-left: 4px solid #3b82f6; background: #eff6ff; padding: 12px 16px; border-radius: 0 8px 8px 0; margin-bottom: 20px;">
              <p style="color: #1e40af; font-size: 13px; margin: 0; line-height: 18px;">
                For security reasons, this link can only be used once. If you did not request this, please contact your store manager immediately.
              </p>
            </div>
            <p style="color: #9ca3af; font-size: 11px; margin: 0; line-height: 16px; word-break: break-all;">
              Direct link: ${resetLink}
            </p>
          </div>
          <div style="background: #f9fafb; padding: 16px 24px; text-align: center; border-top: 1px solid #f3f4f6;">
            <p style="color: #9ca3af; font-size: 12px; margin: 0;">
              © ${new Date().getFullYear()} Olive Pizza Ecosystem. All rights reserved.
            </p>
          </div>
        </div>
      `;

      await sendEmailDirect(cleanEmail, 'Reset Your Olive Pizza Password', emailHtml);

      const now = new Date().toISOString();
      await ref.update({
        status: 'RESET_EMAIL_SENT',
        handledAt: now,
        handledBy: ownerEmail,
      });

      await AuthAuditService.logEvent({
        eventType: 'PASSWORD_RESET_APPROVED',
        userId: reqData.posId,
        identifier: cleanEmail,
        franchiseId: reqData.franchiseId,
        status: 'SUCCESS',
        metadata: { handledBy: ownerEmail },
      });

      return { success: true, message: `Password reset link has been dispatched to ${cleanEmail}.` };
    } catch (err: any) {
      console.error('[PasswordResetWorkflowService] ❌ Failed to dispatch reset link:', err);
      return { success: false, message: `Failed to dispatch reset link: ${err.message}` };
    }
  }

  /**
   * Owner rejects request.
   */
  public static async rejectReset(requestId: string, ownerEmail: string, reason?: string): Promise<{ success: boolean; message: string }> {
    if (!adminDb) return { success: false, message: 'Database service unavailable.' };

    const ref = adminDb.collection(this.COLLECTION).doc(requestId);
    const snap = await ref.get();

    if (!snap.exists) {
      return { success: false, message: 'Password reset request not found.' };
    }

    const now = new Date().toISOString();
    await ref.update({
      status: 'REJECTED',
      handledAt: now,
      handledBy: ownerEmail,
      rejectReason: reason || 'Rejected by Owner',
    });

    const data = snap.data() as PasswordResetRequestData;
    await AuthAuditService.logEvent({
      eventType: 'PASSWORD_RESET_REJECTED',
      userId: data.posId,
      identifier: data.email,
      franchiseId: data.franchiseId,
      status: 'SUCCESS',
      metadata: { handledBy: ownerEmail, reason },
    });

    return { success: true, message: 'Password reset request has been rejected.' };
  }

  /**
   * List all pending password reset requests for Owner dashboard.
   */
  public static async listPendingRequests(): Promise<PasswordResetRequestData[]> {
    if (!adminDb) return [];
    const snapshot = await adminDb
      .collection(this.COLLECTION)
      .where('status', '==', 'PENDING_OWNER_ACTION')
      .get();

    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as PasswordResetRequestData));
  }
}
