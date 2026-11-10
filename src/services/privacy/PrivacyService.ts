import { adminDb, adminAuth } from '../../config/firebase.js';

export interface PrivacyPolicyVersion {
  version: string;
  title: string;
  effectiveDate: string;
  summary: string;
  content: string;
  publishedAt: string;
  publishedBy: string;
  status: 'active' | 'draft' | 'archived';
}

export interface UserConsentRecord {
  userId: string;
  purpose: 'MARKETING_PROMOTIONS' | 'MARKETING_SMS' | 'MARKETING_EMAIL' | 'ANALYTICS_OPTIONAL';
  granted: boolean;
  updatedAt: string;
  policyVersion: string;
  source: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface DataCorrectionPayload {
  name?: string;
  phone?: string;
  email?: string;
  savedAddresses?: any[];
}

export interface DeletionRequestRecord {
  id?: string;
  uid: string;
  email: string;
  reason: string;
  downloadDataRequested: boolean;
  status: 'pending' | 'in_review' | 'completed' | 'rejected';
  activeOrdersAtRequest: string[];
  requestedAt: string;
  gracePeriodEnd: string;
  completedAt?: string;
  notes?: string;
  ipAddress?: string;
}

export interface GrievanceTicket {
  id?: string;
  ticketId: string;
  uid: string;
  customerName: string;
  customerContact: string;
  category: 'CONSENT' | 'ACCESS_EXPORT' | 'CORRECTION' | 'ERASURE' | 'SECURITY' | 'OTHER';
  description: string;
  orderId?: string;
  status: 'submitted' | 'in_review' | 'resolved' | 'closed';
  resolutionNotes?: string;
  assignedOfficer?: string;
  createdAt: string;
  resolvedAt?: string;
  slaDeadline: string; // Statutory 30-day resolution limit
}

export interface ThirdPartyProcessor {
  id: string;
  providerName: string;
  purpose: string;
  dataCategories: string[];
  active: boolean;
  processingRegion: string;
  contractStatus: string;
  privacyContact: string;
  notes?: string;
}

export interface RetentionPolicyCategory {
  category: string;
  title: string;
  retentionPeriod: string;
  legalBasis: string;
  description: string;
  enabled: boolean;
  autoPurgeDays?: number;
}

export interface SecurityIncident {
  id?: string;
  incidentId: string;
  title: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: 'DETECTED' | 'CONTAINED' | 'INVESTIGATING' | 'RESOLVED' | 'CLOSED';
  description: string;
  affectedSystems: string[];
  affectedDataCategories: string[];
  estimatedAffectedUsers?: number;
  containmentActions: string;
  regulatoryNotificationRequired: boolean;
  regulatoryNotificationSent: boolean;
  detectedAt: string;
  resolvedAt?: string;
  postMortemNotes?: string;
  loggedBy: string;
}

export class PrivacyService {
  private static readonly POLICY_COLLECTION = 'privacy_policy_versions';
  private static readonly CONSENT_COLLECTION = 'user_consents';
  private static readonly DELETION_COLLECTION = 'deletion_requests';
  private static readonly GRIEVANCE_COLLECTION = 'privacy_grievances';
  private static readonly PROCESSORS_COLLECTION = 'privacy_processors';
  private static readonly RETENTION_COLLECTION = 'privacy_retention_policies';
  private static readonly INCIDENTS_COLLECTION = 'security_incidents';
  private static readonly AUDIT_COLLECTION = 'privacy_audit_logs';

  // ──────────────────────────────────────────────────────────────────────────
  // 1. PRIVACY NOTICE SYSTEM
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Retrieves the current active Privacy Notice. Seeds v1.0.0 default if not present.
   */
  static async getActivePolicy(): Promise<PrivacyPolicyVersion> {
    const snap = await adminDb.collection(this.POLICY_COLLECTION)
      .where('status', '==', 'active')
      .limit(1)
      .get();

    if (!snap.empty) {
      return snap.docs[0].data() as PrivacyPolicyVersion;
    }

    // Default Seed Policy (DPDP-aligned notice)
    const defaultPolicy: PrivacyPolicyVersion = {
      version: '1.0.0',
      title: 'Olive Pizza Privacy Notice & Data Subject Rights',
      effectiveDate: '2026-06-30',
      summary: 'Transparency notice regarding the collection, processing, purpose limitation, and protection of personal data in compliance with the Digital Personal Data Protection (DPDP) framework.',
      content: `### 1. Introduction & Data Fiduciary Details
Olive Pizza ("we", "us", or "our"), headquartered in Rajnandgaon, Chhattisgarh, India, operates a multi-platform food ordering, kitchen display, and delivery logistics ecosystem. We are committed to protecting your personal data in accordance with applicable Indian laws, including the Digital Personal Data Protection (DPDP) Act.

### 2. Categories of Personal Data Collected
- **Account & Identity Data**: Name, phone number, email address, profile avatar.
- **Location & Delivery Data**: Precise delivery address, GPS coordinates (collected only during address selection or checkout), delivery landmarks.
- **Order & Transaction Data**: Ordered menu items, custom instructions, billing amount, payment method, transaction reference IDs.
- **Device & Telemetry Data**: Device model, operating system, IP address, push notification tokens (for order status updates).

### 3. Lawful Purposes for Processing
- **Order Fulfilment & Delivery**: Processing your food order, kitchen preparation, and turn-by-turn rider delivery (Service-Required).
- **Billing & Tax Compliance**: Generating GST-compliant invoices and accounting ledgers (Statutory Requirement).
- **Customer Support & Communications**: Delivering real-time transactional push notifications and SMS updates regarding your order status.
- **Marketing & Promotions (Optional)**: Sending promotional discounts, coupon updates, and personalized offers ONLY with your explicit consent.

### 4. Third-Party Data Processors
We engage trusted cloud infrastructure, payment gateway, and communication providers strictly under contractual data-protection safeguards:
- **Firebase / Google Cloud**: Cloud databases, identity authentication, Phone OTP SMS delivery, push notifications.
- **Supabase**: Encrypted live GPS coordinate streaming.
- **Payment Gateways (Cashfree / Razorpay / PhonePe)**: Secure tokenized payment processing (we never store credit/debit card numbers or CVV).
- **Truecaller**: Verified 1-tap mobile identity verification (upon explicit user consent).
- **Cloudinary**: Menu and profile image asset optimization.

### 5. Your Data Rights
You possess the right to:
1. **Access & Export**: Request a complete structured copy of your personal data.
2. **Correction & Updating**: Self-service correction of inaccurate profile or address information.
3. **Consent Withdrawal**: Withdraw optional marketing/promotional consent at any time through our Privacy Center without impacting food ordering.
4. **Erasure / Account Deletion**: Request permanent account deletion, subject to statutory tax and financial ledger retention laws.
5. **Grievance Redressal**: Lodge a formal privacy complaint directly to our designated Grievance Officer.

### 6. Children's Privacy
Olive Pizza is not directed at minors under 18 years of age without parental or guardian oversight. We do not knowingly track the behavioral habits of children or engage in targeted advertising to minors.

### 7. Grievance Officer Contact
Inquiries or privacy complaints may be submitted through the in-app Privacy Center or directed to:
- **Grievance Officer**: Privacy & Compliance Redressal Team
- **Email**: privacy@olivepizza.in / olivepizzarjn@gmail.com
- **Address**: Olive Pizza, Near Reliance Trends, Gokul Nagar, Rajnandgaon, Chhattisgarh 491441, India
- **Response SLA**: Within 30 calendar days as provided under applicable rules.`,
      publishedAt: new Date().toISOString(),
      publishedBy: 'system_bootstrap',
      status: 'active'
    };

    await adminDb.collection(this.POLICY_COLLECTION).doc('v1.0.0').set(defaultPolicy);
    return defaultPolicy;
  }

  /**
   * Publishes a new privacy policy revision (Owner only).
   */
  static async publishPolicyVersion(policy: Omit<PrivacyPolicyVersion, 'publishedAt'>, publisherUid: string): Promise<void> {
    const batch = adminDb.batch();

    // Archive current active policy
    const currentActiveSnap = await adminDb.collection(this.POLICY_COLLECTION)
      .where('status', '==', 'active')
      .get();
    
    currentActiveSnap.docs.forEach((doc) => {
      batch.update(doc.ref, { status: 'archived' });
    });

    const newDocRef = adminDb.collection(this.POLICY_COLLECTION).doc(policy.version);
    batch.set(newDocRef, {
      ...policy,
      publishedAt: new Date().toISOString(),
      publishedBy: publisherUid,
      status: 'active'
    });

    await batch.commit();

    await this.recordAuditLog({
      actor: publisherUid,
      action: 'PRIVACY_POLICY_PUBLISHED',
      target: policy.version,
      details: { title: policy.title, effectiveDate: policy.effectiveDate },
      result: 'SUCCESS'
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. CONSENT MANAGEMENT
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Retrieves a user's current consent configuration.
   */
  static async getUserConsents(userId: string): Promise<Record<string, boolean>> {
    const doc = await adminDb.collection(this.CONSENT_COLLECTION).doc(userId).get();
    if (!doc.exists) {
      return {
        MARKETING_PROMOTIONS: false,
        MARKETING_SMS: false,
        MARKETING_EMAIL: false,
        ANALYTICS_OPTIONAL: false
      };
    }
    const data = doc.data() || {};
    return {
      MARKETING_PROMOTIONS: Boolean(data.MARKETING_PROMOTIONS),
      MARKETING_SMS: Boolean(data.MARKETING_SMS),
      MARKETING_EMAIL: Boolean(data.MARKETING_EMAIL),
      ANALYTICS_OPTIONAL: Boolean(data.ANALYTICS_OPTIONAL)
    };
  }

  /**
   * Records or updates a user's consent choice.
   */
  static async recordConsent(params: {
    userId: string;
    purpose: 'MARKETING_PROMOTIONS' | 'MARKETING_SMS' | 'MARKETING_EMAIL' | 'ANALYTICS_OPTIONAL';
    granted: boolean;
    policyVersion: string;
    source: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    const userRef = adminDb.collection(this.CONSENT_COLLECTION).doc(params.userId);

    await userRef.set({
      userId: params.userId,
      [params.purpose]: params.granted,
      [`${params.purpose}_updatedAt`]: now,
      [`${params.purpose}_policyVersion`]: params.policyVersion,
      [`${params.purpose}_source`]: params.source,
      updatedAt: now
    }, { merge: true });

    // Record immutable audit history
    await adminDb.collection('consent_audit_logs').add({
      ...params,
      timestamp: now
    });

    await this.recordAuditLog({
      actor: params.userId,
      action: params.granted ? 'CONSENT_GRANTED' : 'CONSENT_WITHDRAWN',
      target: params.purpose,
      details: { policyVersion: params.policyVersion, source: params.source },
      result: 'SUCCESS',
      ipAddress: params.ipAddress
    });
  }

  /**
   * Withdraws an optional consent purpose.
   */
  static async withdrawConsent(userId: string, purpose: 'MARKETING_PROMOTIONS' | 'MARKETING_SMS' | 'MARKETING_EMAIL' | 'ANALYTICS_OPTIONAL', ipAddress?: string): Promise<void> {
    const policy = await this.getActivePolicy();
    await this.recordConsent({
      userId,
      purpose,
      granted: false,
      policyVersion: policy.version,
      source: 'CUSTOMER_PRIVACY_CENTER',
      ipAddress
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. DATA ACCESS & SANITIZED EXPORT
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Generates a sanitized JSON export of all personal data belonging to the user.
   * STRICTLY strips passwords, Firebase tokens, internal authorization claims, and security logs.
   */
  static async generateDataExport(userId: string): Promise<Record<string, any>> {
    const userDoc = await adminDb.collection('users').doc(userId).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    // 1. Sanitize Profile
    const profile = {
      uid: userId,
      name: userData?.name || userData?.displayName || 'Customer',
      email: userData?.email || null,
      phone: userData?.phone || null,
      createdAt: userData?.createdAt || null,
      savedAddresses: userData?.savedAddresses || []
    };

    // 2. Fetch Orders belonging to user
    const ordersSnap = await adminDb.collection('orders')
      .where('userId', '==', userId)
      .get()
      .catch(() => ({ docs: [] } as any));

    const orders = ordersSnap.docs.map((d: any) => {
      const o = d.data();
      return {
        orderId: d.id,
        status: o.status,
        createdAt: o.createdAt,
        totalAmount: o.totalAmount,
        paymentMethod: o.paymentMethod,
        paymentStatus: o.paymentStatus,
        items: (o.items || []).map((item: any) => ({
          name: item.name,
          quantity: item.quantity,
          size: item.size,
          crust: item.crust,
          price: item.price
        })),
        deliveryAddress: o.deliveryAddress || null
      };
    });

    // 3. Fetch Consent Choices
    const consents = await this.getUserConsents(userId);

    // 4. Fetch Grievances submitted by user
    const grievancesSnap = await adminDb.collection(this.GRIEVANCE_COLLECTION)
      .where('uid', '==', userId)
      .get()
      .catch(() => ({ docs: [] } as any));

    const grievances = grievancesSnap.docs.map((d: any) => {
      const g = d.data();
      return {
        ticketId: g.ticketId,
        category: g.category,
        description: g.description,
        status: g.status,
        createdAt: g.createdAt,
        resolutionNotes: g.resolutionNotes || null
      };
    });

    await this.recordAuditLog({
      actor: userId,
      action: 'DATA_EXPORT_GENERATED',
      target: userId,
      details: { ordersCount: orders.length, grievancesCount: grievances.length },
      result: 'SUCCESS'
    });

    return {
      exportMetadata: {
        exportedAt: new Date().toISOString(),
        fiduciary: 'Olive Pizza (Rajnandgaon, India)',
        regulationNotice: 'Generated under Digital Personal Data Protection (DPDP) Right to Access'
      },
      profile,
      consents,
      orders,
      grievances
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. DATA CORRECTION
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Applies permissible customer profile corrections while strictly rejecting privilege/scoping modifications.
   */
  static async correctUserData(userId: string, payload: DataCorrectionPayload): Promise<{ success: boolean; updatedFields: string[] }> {
    const allowedKeys: (keyof DataCorrectionPayload)[] = ['name', 'phone', 'email', 'savedAddresses'];
    const updates: Record<string, any> = { updatedAt: new Date().toISOString() };
    const updatedFields: string[] = [];

    if (payload.name !== undefined && typeof payload.name === 'string') {
      const trimmed = payload.name.trim();
      if (trimmed.length > 0) {
        updates.name = trimmed;
        updates.displayName = trimmed;
        updatedFields.push('name');
      }
    }

    if (payload.email !== undefined && typeof payload.email === 'string') {
      const trimmed = payload.email.trim().toLowerCase();
      if (trimmed.includes('@')) {
        updates.email = trimmed;
        updatedFields.push('email');
      }
    }

    if (payload.phone !== undefined && typeof payload.phone === 'string') {
      const digits = payload.phone.replace(/\D/g, '');
      if (digits.length >= 10) {
        updates.phone = digits;
        updatedFields.push('phone');
      }
    }

    if (payload.savedAddresses !== undefined && Array.isArray(payload.savedAddresses)) {
      updates.savedAddresses = payload.savedAddresses;
      updatedFields.push('savedAddresses');
    }

    if (updatedFields.length === 0) {
      throw new Error('No valid modifiable fields provided.');
    }

    await adminDb.collection('users').doc(userId).set(updates, { merge: true });

    await this.recordAuditLog({
      actor: userId,
      action: 'DATA_CORRECTION_APPLIED',
      target: userId,
      details: { updatedFields },
      result: 'SUCCESS'
    });

    return { success: true, updatedFields };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. ACCOUNT / DATA DELETION & ERASURE WORKFLOW
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Submits or updates an account erasure request with statutory grace period.
   * Financial orders and invoices are retained with PII pseudonymized for GST tax compliance.
   */
  static async requestAccountDeletion(params: {
    uid: string;
    email: string;
    reason: string;
    downloadDataRequested: boolean;
    ipAddress?: string;
  }): Promise<{ requestId: string; gracePeriodEnd: string; activeOrdersCount: number }> {
    const now = new Date();
    const gracePeriodEnd = new Date(now);
    gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 30); // 30-day statutory cooling period

    // Check for active orders
    const ordersSnap = await adminDb.collection('orders')
      .where('userId', '==', params.uid)
      .get()
      .catch(() => ({ docs: [] } as any));

    const activeOrders = ordersSnap.docs
      .filter((d: any) => !['delivered', 'cancelled', 'rejected', 'failed'].includes(d.data().status))
      .map((d: any) => d.id);

    const record: DeletionRequestRecord = {
      uid: params.uid,
      email: params.email.toLowerCase(),
      reason: params.reason || 'Requested by customer',
      downloadDataRequested: Boolean(params.downloadDataRequested),
      status: 'pending',
      activeOrdersAtRequest: activeOrders,
      requestedAt: now.toISOString(),
      gracePeriodEnd: gracePeriodEnd.toISOString(),
      ipAddress: params.ipAddress
    };

    const docRef = await adminDb.collection(this.DELETION_COLLECTION).add(record);

    // Flag user record as pending deletion
    await adminDb.collection('users').doc(params.uid).set({
      deletionRequestPending: true,
      deletionRequestId: docRef.id,
      deletionRequestedAt: now.toISOString(),
      deletionScheduledFor: gracePeriodEnd.toISOString()
    }, { merge: true });

    await this.recordAuditLog({
      actor: params.uid,
      action: 'DELETION_REQUEST_SUBMITTED',
      target: params.uid,
      details: { requestId: docRef.id, gracePeriodEnd: gracePeriodEnd.toISOString(), activeOrdersCount: activeOrders.length },
      result: 'SUCCESS',
      ipAddress: params.ipAddress
    });

    return {
      requestId: docRef.id,
      gracePeriodEnd: gracePeriodEnd.toISOString(),
      activeOrdersCount: activeOrders.length
    };
  }

  /**
   * Executes permanent erasure/anonymization of an account after grace period or upon approved administrative review.
   * Wipes profile, addresses, carts, and FCM tokens. Anonymizes historical order references.
   */
  static async executeAccountErasure(uid: string, adminActor: string): Promise<void> {
    const batch = adminDb.batch();

    // 1. Scrub user profile record
    const userRef = adminDb.collection('users').doc(uid);
    batch.set(userRef, {
      name: 'Deleted User',
      displayName: 'Deleted User',
      email: `deleted_${uid.slice(0, 8)}@olivepizza.anonymized`,
      phone: null,
      photoURL: null,
      savedAddresses: [],
      isDeleted: true,
      deletedAt: new Date().toISOString(),
      deletionExecutedBy: adminActor
    }, { merge: true });

    // 2. Wipe user cart
    const cartRef = adminDb.collection('user_carts').doc(uid);
    batch.delete(cartRef);

    // 3. Wipe active consents
    const consentRef = adminDb.collection(this.CONSENT_COLLECTION).doc(uid);
    batch.delete(consentRef);

    await batch.commit();

    // 4. Anonymize orders (Preserve financial and tax totals, scrub customer names & phone numbers)
    const ordersSnap = await adminDb.collection('orders').where('userId', '==', uid).get();
    const orderBatch = adminDb.batch();
    ordersSnap.docs.forEach((docSnap) => {
      orderBatch.update(docSnap.ref, {
        customerName: 'Anonymized Customer',
        customerPhone: '0000000000',
        deliveryAddress: {
          addressLine: '[ANONYMIZED FOR PRIVACY COMPLIANCE]',
          city: 'Rajnandgaon',
          state: 'Chhattisgarh'
        }
      });
    });
    if (!ordersSnap.empty) {
      await orderBatch.commit();
    }

    // 5. Disable Firebase Auth account
    await adminAuth.updateUser(uid, { disabled: true }).catch(() => null);

    await this.recordAuditLog({
      actor: adminActor,
      action: 'ACCOUNT_ERASURE_EXECUTED',
      target: uid,
      details: { ordersAnonymized: ordersSnap.size },
      result: 'SUCCESS'
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 6. GRIEVANCE REDRESSAL MECHANISM
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Submits a formal privacy grievance.
   */
  static async submitGrievance(params: {
    uid: string;
    customerName: string;
    customerContact: string;
    category: 'CONSENT' | 'ACCESS_EXPORT' | 'CORRECTION' | 'ERASURE' | 'SECURITY' | 'OTHER';
    description: string;
    orderId?: string;
  }): Promise<{ ticketId: string; slaDeadline: string }> {
    const now = new Date();
    const slaDeadline = new Date(now);
    slaDeadline.setDate(slaDeadline.getDate() + 30); // 30-day statutory resolution limit

    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const ticketId = `GRV-${dateStr}-${randomSuffix}`;

    const grievance: GrievanceTicket = {
      ticketId,
      uid: params.uid,
      customerName: params.customerName,
      customerContact: params.customerContact,
      category: params.category,
      description: params.description,
      orderId: params.orderId || undefined,
      status: 'submitted',
      createdAt: now.toISOString(),
      slaDeadline: slaDeadline.toISOString()
    };

    await adminDb.collection(this.GRIEVANCE_COLLECTION).doc(ticketId).set(grievance);

    await this.recordAuditLog({
      actor: params.uid,
      action: 'GRIEVANCE_SUBMITTED',
      target: ticketId,
      details: { category: params.category },
      result: 'SUCCESS'
    });

    return { ticketId, slaDeadline: slaDeadline.toISOString() };
  }

  /**
   * Retrieves grievances submitted by a specific user.
   */
  static async getUserGrievances(uid: string): Promise<GrievanceTicket[]> {
    const snap = await adminDb.collection(this.GRIEVANCE_COLLECTION)
      .where('uid', '==', uid)
      .get();

    return snap.docs.map(d => d.data() as GrievanceTicket);
  }

  /**
   * Updates grievance resolution state (Owner/Grievance Officer only).
   */
  static async resolveGrievance(params: {
    ticketId: string;
    status: 'in_review' | 'resolved' | 'closed';
    resolutionNotes: string;
    assignedOfficer: string;
  }): Promise<void> {
    await adminDb.collection(this.GRIEVANCE_COLLECTION).doc(params.ticketId).update({
      status: params.status,
      resolutionNotes: params.resolutionNotes,
      assignedOfficer: params.assignedOfficer,
      resolvedAt: params.status === 'resolved' ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString()
    });

    await this.recordAuditLog({
      actor: params.assignedOfficer,
      action: 'GRIEVANCE_STATUS_UPDATED',
      target: params.ticketId,
      details: { status: params.status, notes: params.resolutionNotes },
      result: 'SUCCESS'
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 7. THIRD-PARTY PROCESSOR REGISTRY
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Retrieves the centralized registry of third-party data processors.
   * Pre-populates with actual project processors if empty.
   */
  static async getProcessors(): Promise<ThirdPartyProcessor[]> {
    const snap = await adminDb.collection(this.PROCESSORS_COLLECTION).get();
    if (!snap.empty) {
      let docs = snap.docs.map(d => d.data() as ThirdPartyProcessor);
      const hasInfobip = docs.some(d => d.id === 'proc_infobip');
      if (hasInfobip) {
        await adminDb.collection(this.PROCESSORS_COLLECTION).doc('proc_infobip').delete().catch(() => {});
        docs = docs.filter(d => d.id !== 'proc_infobip');
      }
      if (!docs.some(d => d.id === 'proc_truecaller')) {
        const truecallerProcessor: ThirdPartyProcessor = {
          id: 'proc_truecaller',
          providerName: 'Truecaller',
          purpose: 'Consent-based 1-tap phone identity verification.',
          dataCategories: ['Mobile Phone Number', 'Truecaller Profile Name'],
          active: true,
          processingRegion: 'India / Global',
          contractStatus: 'Active Developer Partner Agreement',
          privacyContact: 'privacy@truecaller.com',
          notes: 'Strictly invoked upon explicit user tap of Truecaller verification CTA.'
        };
        await adminDb.collection(this.PROCESSORS_COLLECTION).doc('proc_truecaller').set(truecallerProcessor).catch(() => {});
        docs.push(truecallerProcessor);
      }
      return docs;
    }

    const defaultProcessors: ThirdPartyProcessor[] = [
      {
        id: 'proc_firebase',
        providerName: 'Google Cloud / Firebase',
        purpose: 'Identity authentication, application database (Firestore), and push notification delivery (FCM).',
        dataCategories: ['Identity Data', 'Order Data', 'Device Tokens'],
        active: true,
        processingRegion: 'asia-south1 (Mumbai, India) / global',
        contractStatus: 'Active Service Terms',
        privacyContact: 'dpo@google.com',
        notes: 'Authoritative data store for operational application state.'
      },
      {
        id: 'proc_supabase',
        providerName: 'Supabase (PostgreSQL)',
        purpose: 'Live delivery driver GPS coordinates streaming & real-time telemetry.',
        dataCategories: ['Rider Location Telemetry', 'Active Order Channel IDs'],
        active: true,
        processingRegion: 'ap-south-1 (Mumbai, India)',
        contractStatus: 'Active Service Agreement',
        privacyContact: 'privacy@supabase.com',
        notes: 'Subject to automated 5-minute raw breadcrumb purge policy.'
      },
      {
        id: 'proc_truecaller',
        providerName: 'Truecaller',
        purpose: 'Consent-based 1-tap phone identity verification.',
        dataCategories: ['Mobile Phone Number', 'Truecaller Profile Name'],
        active: true,
        processingRegion: 'India / Global',
        contractStatus: 'Active Developer Partner Agreement',
        privacyContact: 'privacy@truecaller.com',
        notes: 'Strictly invoked upon explicit user tap of Truecaller verification CTA.'
      },
      {
        id: 'proc_razorpay',
        providerName: 'Razorpay / Cashfree / PhonePe',
        purpose: 'Tokenized digital payment processing (UPI, Cards, Net Banking).',
        dataCategories: ['Transaction Reference IDs', 'Payment Status', 'Billing Amount'],
        active: true,
        processingRegion: 'India (RBI Compliant)',
        contractStatus: 'Active Merchant Agreement',
        privacyContact: 'privacy@razorpay.com',
        notes: 'PCI-DSS Level 1 certified. No raw card or CVV details are stored on Olive Pizza systems.'
      },
      {
        id: 'proc_cloudinary',
        providerName: 'Cloudinary',
        purpose: 'Menu item photography asset storage and proof-of-delivery image processing.',
        dataCategories: ['Food Menu Images', 'Proof of Delivery Photo Uploads'],
        active: true,
        processingRegion: 'Global CDN',
        contractStatus: 'Active Commercial License',
        privacyContact: 'privacy@cloudinary.com',
        notes: 'Strictly handles static media assets.'
      },
      {
        id: 'proc_cloudflare',
        providerName: 'Cloudflare (R2 & Turnstile)',
        purpose: 'Bot protection on checkout/OTP and encrypted object storage for backups.',
        dataCategories: ['Encrypted Backups', 'Client IP for Bot Verification'],
        active: true,
        processingRegion: 'Global Anycast Network',
        contractStatus: 'Active Enterprise Agreement',
        privacyContact: 'privacy@cloudflare.com',
        notes: 'Zero personal data sold or used for ad targeting.'
      }
    ];

    const batch = adminDb.batch();
    defaultProcessors.forEach((p) => {
      batch.set(adminDb.collection(this.PROCESSORS_COLLECTION).doc(p.id), p);
    });
    await batch.commit();

    return defaultProcessors;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 8. DATA RETENTION POLICY MATRIX
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Retrieves data retention rules for all categories.
   */
  static async getRetentionPolicies(): Promise<RetentionPolicyCategory[]> {
    const snap = await adminDb.collection(this.RETENTION_COLLECTION).get();
    if (!snap.empty) {
      return snap.docs.map(d => d.data() as RetentionPolicyCategory);
    }

    const defaultPolicies: RetentionPolicyCategory[] = [
      {
        category: 'CUSTOMER_PROFILE',
        title: 'Customer Profile & Account Data',
        retentionPeriod: 'Duration of active account + 30-day grace period upon deletion request.',
        legalBasis: 'Service Agreement & DPDP Right to Erasure',
        description: 'Retained while customer actively maintains account; purged upon confirmed erasure.',
        enabled: true
      },
      {
        category: 'ORDER_RECORDS_FINANCIAL',
        title: 'Order Records & Tax Invoices',
        retentionPeriod: '8 Years (Statutory Indian GST & Income Tax Mandate)',
        legalBasis: 'Section 36 of CGST Act, 2017 & Income Tax Act',
        description: 'Invoice numbers, bill amounts, tax calculations, and timestamps must be preserved for tax audit compliance. Customer identifiers are pseudonymized upon account deletion.',
        enabled: true
      },
      {
        category: 'GPS_BREADCRUMBS',
        title: 'Live Rider GPS Telemetry',
        retentionPeriod: '5 Minutes after delivery completion',
        legalBasis: 'Data Minimization Principle',
        description: 'Automated minutely cron sweeps delete all raw navigation breadcrumbs older than 5 minutes from Supabase PostgreSQL.',
        enabled: true,
        autoPurgeDays: 0
      },
      {
        category: 'SECURITY_AUDIT_LOGS',
        title: 'Security & Access Logs',
        retentionPeriod: '1 Year',
        legalBasis: 'CERT-In Cyber Security Directions',
        description: 'System access and authentication logs retained to detect and investigate unauthorized attempts.',
        enabled: true,
        autoPurgeDays: 365
      },
      {
        category: 'GRIEVANCE_RECORDS',
        title: 'Privacy Complaints & Grievance Tickets',
        retentionPeriod: '3 Years post-resolution',
        legalBasis: 'Statutory Limitation & Regulatory Compliance',
        description: 'Complaint details and officer resolution summaries retained to demonstrate regulatory compliance.',
        enabled: true,
        autoPurgeDays: 1095
      }
    ];

    const batch = adminDb.batch();
    defaultPolicies.forEach((p) => {
      batch.set(adminDb.collection(this.RETENTION_COLLECTION).doc(p.category), p);
    });
    await batch.commit();

    return defaultPolicies;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 9. SECURITY INCIDENT / BREACH WORKFLOW (Owner Only)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Logs a detected security incident or data breach.
   */
  static async recordSecurityIncident(params: Omit<SecurityIncident, 'incidentId' | 'detectedAt'>): Promise<string> {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const incidentId = `INC-${dateStr}-${randomSuffix}`;

    const incident: SecurityIncident = {
      ...params,
      incidentId,
      detectedAt: now.toISOString()
    };

    await adminDb.collection(this.INCIDENTS_COLLECTION).doc(incidentId).set(incident);

    await this.recordAuditLog({
      actor: params.loggedBy,
      action: 'SECURITY_INCIDENT_CREATED',
      target: incidentId,
      details: { severity: params.severity, title: params.title },
      result: 'SUCCESS'
    });

    return incidentId;
  }

  /**
   * Retrieves logged security incidents.
   */
  static async getSecurityIncidents(): Promise<SecurityIncident[]> {
    const snap = await adminDb.collection(this.INCIDENTS_COLLECTION)
      .orderBy('detectedAt', 'desc')
      .limit(50)
      .get();

    return snap.docs.map(d => d.data() as SecurityIncident);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 10. CENTRALIZED AUDIT LOGGING
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Records an immutable entry in privacy_audit_logs. Never logs credentials or secrets.
   */
  static async recordAuditLog(params: {
    actor: string;
    action: string;
    target: string;
    details?: Record<string, any>;
    result: 'SUCCESS' | 'FAILED' | 'DENIED';
    franchiseId?: string;
    branchId?: string;
    ipAddress?: string;
  }): Promise<void> {
    try {
      await adminDb.collection(this.AUDIT_COLLECTION).add({
        ...params,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      console.error('[PrivacyService] Failed to record audit log:', err);
    }
  }

  /**
   * Retrieves privacy audit logs (Owner only).
   */
  static async getAuditLogs(limitCount = 100): Promise<any[]> {
    const snap = await adminDb.collection(this.AUDIT_COLLECTION)
      .orderBy('timestamp', 'desc')
      .limit(limitCount)
      .get();

    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
}
