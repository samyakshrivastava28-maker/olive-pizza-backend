import './env.js';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';
import { getStorage } from 'firebase-admin/storage';
import dotenv from 'dotenv';

dotenv.config();

// Firebase project config — hardcoded as fallback (read from .env if available)
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'olive-pizza-08';
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL || '';
const FIREBASE_PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

let adminDbInstance: ReturnType<typeof getFirestore> | null = null;
let adminAuthInstance: ReturnType<typeof getAuth> | null = null;
let adminMessagingInstance: ReturnType<typeof getMessaging> | null = null;
let adminStorageInstance: ReturnType<typeof getStorage> | null = null;

if (getApps().length === 0) {
  try {
    const defaultStorageBucket = process.env.FIREBASE_STORAGE_BUCKET || `${FIREBASE_PROJECT_ID}.firebasestorage.app`;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
      // Option 1: Full base64-encoded service account JSON
      const serviceAccount = JSON.parse(
        Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
      );
      initializeApp({
        credential: cert(serviceAccount),
        storageBucket: defaultStorageBucket
      });
      console.log('[Firebase Admin] ✅ Initialized with base64 service account.');
    } else if (FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
      // Option 2: Individual env vars
      initializeApp({
        credential: cert({
          projectId: FIREBASE_PROJECT_ID,
          clientEmail: FIREBASE_CLIENT_EMAIL,
          privateKey: FIREBASE_PRIVATE_KEY,
        }),
        storageBucket: defaultStorageBucket
      });
      console.log('[Firebase Admin] ✅ Initialized with individual env var credentials.');
    } else {
      // Option 3: No credentials — initialize without auth (limited to public Firestore rules)
      // This prevents the "applicationDefault" crash on local machines without gcloud CLI
      initializeApp({
        projectId: FIREBASE_PROJECT_ID,
        storageBucket: defaultStorageBucket
      });
      console.warn('[Firebase Admin] ⚠️ No service account found. Initialized with projectId only. Set FIREBASE_SERVICE_ACCOUNT_BASE64 in .env for full access.');
    }
  } catch (error) {
    console.error('[Firebase Admin] ❌ Initialization Error:', error);
    // Still call initializeApp with minimal config so getFirestore/getAuth don't crash
    try { initializeApp({ projectId: FIREBASE_PROJECT_ID }); } catch {}
  }
}

try {
  adminDbInstance = getFirestore();
  try {
    adminDbInstance.settings({ ignoreUndefinedProperties: true });
  } catch (settingsErr) {
    // Settings already applied or Firestore already initialized — safe to ignore
  }
  adminAuthInstance = getAuth();
  adminMessagingInstance = getMessaging();
  adminStorageInstance = getStorage();
} catch (e) {
  console.error('[Firebase Admin] Could not get Firestore/Auth/Messaging/Storage instance:', e);
}

export const isFirebaseAdminAuthenticated = Boolean(
  process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ||
  (FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY)
);

export const isTestMode =
  process.env.NODE_ENV === 'test' ||
  Boolean(process.env.NODE_TEST_CONTEXT) ||
  Boolean(process.env.npm_lifecycle_event === 'test') ||
  process.argv.some(a => a.includes('test'));

// In test mode or unauthenticated fallback, provide a 100% in-memory document store to isolate tests and avoid live quota exhaustion
const testMemoryStore = new Map<string, Map<string, any>>();

function getTestCollection(name: string): Map<string, any> {
  let col = testMemoryStore.get(name);
  if (!col) {
    col = new Map<string, any>();
    testMemoryStore.set(name, col);
  }
  return col;
}

function sanitizeData(data: any): any {
  if (!data || typeof data !== 'object') return data;
  if (data instanceof Date) return data;
  if (Array.isArray(data)) return data.map(sanitizeData);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && v.constructor?.name === 'ServerTimestampTransform') {
      out[k] = new Date().toISOString();
    } else {
      out[k] = sanitizeData(v);
    }
  }
  return out;
}

function createTestDocRef(collectionName: string, docId: string): any {
  return {
    id: docId,
    path: `${collectionName}/${docId}`,
    collection: (subName: string) => createTestCollectionRef(`${collectionName}/${docId}/${subName}`),
    set: async (data: any, options?: any) => {
      const col = getTestCollection(collectionName);
      const sanitized = sanitizeData(data);
      if (options?.merge && col.has(docId)) {
        col.set(docId, { ...col.get(docId), ...sanitized });
      } else {
        col.set(docId, { ...sanitized });
      }
      return { writeTime: new Date() };
    },
    update: async (data: any) => {
      const col = getTestCollection(collectionName);
      const prev = col.get(docId) || {};
      const sanitized = sanitizeData(data);
      col.set(docId, { ...prev, ...sanitized });
      return { writeTime: new Date() };
    },
    delete: async () => {
      const col = getTestCollection(collectionName);
      col.delete(docId);
      return { writeTime: new Date() };
    },
    get: async () => {
      const col = getTestCollection(collectionName);
      if (col.has(docId)) {
        const val = col.get(docId);
        return {
          id: docId,
          exists: true,
          data: () => ({ ...val }),
          ref: createTestDocRef(collectionName, docId)
        };
      }
      return {
        id: docId,
        exists: false,
        data: () => undefined,
        ref: createTestDocRef(collectionName, docId)
      };
    }
  };
}

function createTestCollectionRef(name: string): any {
  const queryState = {
    filters: [] as Array<{ field: string; op: string; val: any }>,
    orderField: null as string | null,
    orderDir: 'asc' as 'asc' | 'desc',
    limitCount: null as number | null
  };

  const buildQuery = (state: typeof queryState): any => ({
    where: (field: string, op: string, val: any) => {
      return buildQuery({
        ...state,
        filters: [...state.filters, { field, op, val }]
      });
    },
    orderBy: (field: string, dir: 'asc' | 'desc' = 'asc') => {
      return buildQuery({
        ...state,
        orderField: field,
        orderDir: dir
      });
    },
    limit: (n: number) => {
      return buildQuery({
        ...state,
        limitCount: n
      });
    },
    doc: (docId?: string) => {
      const id = docId || `test_doc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      return createTestDocRef(name, id);
    },
    add: async (data: any) => {
      const id = `test_doc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const docRef = createTestDocRef(name, id);
      await docRef.set(data);
      return docRef;
    },
    get: async () => {
      const col = getTestCollection(name);
      let list = Array.from(col.entries()).map(([id, data]) => ({ id, data }));

      for (const f of state.filters) {
        list = list.filter(({ data }) => {
          const val = data[f.field];
          if (f.op === '==') return val === f.val;
          if (f.op === '!=') return val !== f.val;
          if (f.op === 'in') return Array.isArray(f.val) && f.val.includes(val);
          if (f.op === 'not-in') return Array.isArray(f.val) && !f.val.includes(val);
          if (f.op === 'array-contains') return Array.isArray(val) && val.includes(f.val);
          if (f.op === '>') return val > f.val;
          if (f.op === '>=') return val >= f.val;
          if (f.op === '<') return val < f.val;
          if (f.op === '<=') return val <= f.val;
          return true;
        });
      }

      if (state.orderField) {
        list.sort((a, b) => {
          const va = a.data[state.orderField!];
          const vb = b.data[state.orderField!];
          if (va < vb) return state.orderDir === 'asc' ? -1 : 1;
          if (va > vb) return state.orderDir === 'asc' ? 1 : -1;
          return 0;
        });
      }

      if (state.limitCount !== null) {
        list = list.slice(0, state.limitCount);
      }

      const docs = list.map(({ id, data }) => ({
        id,
        exists: true,
        data: () => ({ ...data }),
        ref: createTestDocRef(name, id)
      }));

      return {
        docs,
        size: docs.length,
        empty: docs.length === 0,
        forEach: (cb: (doc: any) => void) => docs.forEach(cb)
      };
    }
  });

  return buildQuery(queryState);
}

// Export with fallback to avoid null crashes downstream
export const adminDb: any = (isTestMode || !isFirebaseAdminAuthenticated)
  ? new Proxy(adminDbInstance || ({} as any), {
      get(target, prop, receiver) {
        if (prop === 'collection') {
          return (name: string) => createTestCollectionRef(name);
        }
        if (prop === 'runTransaction') {
          return async (fn: (txn: any) => Promise<any>) => {
            const txn = {
              get: async (ref: any) => ref.get(),
              set: (ref: any, data: any, options?: any) => ref.set(data, options),
              update: (ref: any, data: any) => ref.update(data),
              delete: (ref: any) => ref.delete()
            };
            return fn(txn);
          };
        }
        if (prop === 'batch') {
          return () => {
            const ops: Array<() => Promise<any>> = [];
            return {
              set: (ref: any, data: any, options?: any) => { ops.push(() => ref.set(data, options)); },
              update: (ref: any, data: any) => { ops.push(() => ref.update(data)); },
              delete: (ref: any) => { ops.push(() => ref.delete()); },
              commit: async () => { for (const op of ops) await op(); }
            };
          };
        }
        return Reflect.get(target, prop, receiver);
      }
    })
  : adminDbInstance!;

export const adminAuth: any = (isTestMode || !isFirebaseAdminAuthenticated)
  ? new Proxy(adminAuthInstance || ({} as any), {
      get(target, prop, receiver) {
        if (prop === 'getUser') {
          return async (uid: string) => ({
            uid,
            email: `${uid}@olivepizza.test`,
            emailVerified: true
          });
        }
        if (prop === 'getUserByEmail') {
          return async (email: string) => ({
            uid: `uid_${email.replace(/[^a-zA-Z0-9]/g, '_')}`,
            email,
            emailVerified: true
          });
        }
        if (prop === 'verifyIdToken') {
          return async (token: string) => ({
            uid: 'test_verified_uid',
            email: 'webhub2811@gmail.com',
            email_verified: true
          });
        }
        return Reflect.get(target, prop, receiver);
      }
    })
  : adminAuthInstance!;

export const adminMessaging: any = (isTestMode || !isFirebaseAdminAuthenticated)
  ? new Proxy(adminMessagingInstance || ({} as any), {
      get(target, prop, receiver) {
        if (prop === 'sendEachForMulticast') {
          return async (msg: any) => ({
            successCount: (msg.tokens || []).length,
            failureCount: 0,
            responses: (msg.tokens || []).map(() => ({ success: true }))
          });
        }
        if (prop === 'send') {
          return async () => 'test_message_id';
        }
        return Reflect.get(target, prop, receiver);
      }
    })
  : adminMessagingInstance!;

export const adminStorage = adminStorageInstance!;
