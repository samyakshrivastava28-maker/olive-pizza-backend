/**
 * toolExecutor.ts (Backend) — Server-side Tool Execution & Validation
 *
 * Validates auth, parameters, and role permissions before either:
 *  - executing server-side (Firestore queries, KB lookups)
 *  - forwarding to frontend tool bridge (cart, navigation, UI state)
 *
 * Never duplicates business logic — queries existing Firestore collections only.
 */

import { isAuthRequiredForTool, isClientSideTool } from './toolSchemas.js';
import kb from '../KnowledgeBaseService.js';
import { adminDb } from '../../config/firebase.js';

export interface ToolCallRequest {
  id: string;
  name: string;
  args: Record<string, any>;
}

export interface ToolCallResponse {
  toolCallId: string;
  toolName: string;
  status: 'executed_server' | 'forward_client' | 'auth_required' | 'error';
  result?: any;
  userMessage?: string;
  toolLatencyMs?: number;
}

export async function executeBackendTool(
  toolCall: ToolCallRequest,
  user?: { uid: string; email?: string; role?: string }
): Promise<ToolCallResponse> {
  const { id: toolCallId, name: toolName, args } = toolCall;
  const toolStart = Date.now();

  // ── Auth Guard ───────────────────────────────────────────────────────────────
  const requiresAuth = isAuthRequiredForTool(toolName);
  if (requiresAuth && !user) {
    return {
      toolCallId,
      toolName,
      status: 'auth_required',
      userMessage: `Please log in to your Olive Pizza account to use "${toolName.replace(/_/g, ' ')}".`,
      result: { requiresAuth: true },
      toolLatencyMs: Date.now() - toolStart,
    };
  }

  // ── Client-side tools: forward immediately ──────────────────────────────────
  if (isClientSideTool(toolName)) {
    return {
      toolCallId,
      toolName,
      status: 'forward_client',
      result: args,
      userMessage: `Executing ${toolName}...`,
      toolLatencyMs: Date.now() - toolStart,
    };
  }

  // ── Server-side tool execution ──────────────────────────────────────────────
  try {
    switch (toolName) {

      // ─── MENU SEARCH ──────────────────────────────────────────────────────
      case 'search_menu': {
        const query = (args.query || '').trim();
        if (!query) {
          return { toolCallId, toolName, status: 'error', userMessage: 'Search query is required.' };
        }
        let items = kb.searchProducts(query, 6);
        if (typeof args.isVeg === 'boolean') {
          items = items.filter(i => i.isVeg === args.isVeg);
        }
        if (typeof args.maxPrice === 'number' && args.maxPrice > 0) {
          items = items.filter(i => (i.discountedPrice || i.price) <= args.maxPrice);
        }
        if (args.category) {
          const cat = args.category.toLowerCase();
          items = items.filter(i => i.category?.toLowerCase().includes(cat));
        }

        return {
          toolCallId,
          toolName,
          status: 'executed_server',
          result: {
            items: items.map(i => ({
              id: i.id,
              name: i.name,
              category: i.category,
              price: i.price,
              discountedPrice: i.discountedPrice,
              isVeg: i.isVeg,
              isAvailable: i.isAvailable,
              description: i.description,
              sizes: i.sizes || ['Small', 'Medium', 'Large'],
              toppings: i.toppings || [],
              rating: i.rating,
              preparationTime: i.preparationTime,
              imageUrl: i.imageUrl,
              ingredients: i.ingredients,
            })),
            count: items.length,
          },
          userMessage: `Found ${items.length} matching menu item(s).`,
          toolLatencyMs: Date.now() - toolStart,
        };
      }

      // ─── PRODUCT DETAILS ─────────────────────────────────────────────────
      case 'get_product_details': {
        const query = (args.productId || args.productName || '').trim();
        const items = kb.searchProducts(query, 1);
        const item = items[0] || null;

        // Try Firestore for most up-to-date data
        let firestoreData: any = null;
        if (item?.id && adminDb) {
          try {
            const docSnap = await adminDb.collection('products').doc(item.id).get();
            if (docSnap.exists) firestoreData = { id: docSnap.id, ...docSnap.data() };
          } catch { /* fall back to KB data */ }
        }

        const product = firestoreData || item;
        return {
          toolCallId,
          toolName,
          status: 'executed_server',
          result: { product },
          userMessage: product ? `Fetched details for ${product.name}` : 'Product not found in our menu.',
          toolLatencyMs: Date.now() - toolStart,
        };
      }

      // ─── ORDER TRACKING ───────────────────────────────────────────────────
      case 'track_order': {
        if (!user?.uid) {
          return { toolCallId, toolName, status: 'auth_required', userMessage: 'Please log in to track your order.' };
        }

        let orderDoc: any = null;
        if (args.orderId) {
          const doc = await adminDb.collection('orders').doc(args.orderId).get();
          // Strict ownership check — never expose other users' orders
          if (doc.exists && doc.data()?.userId === user.uid) {
            orderDoc = { id: doc.id, ...doc.data() };
          }
        } else {
          // Fetch latest active order for this user only
          const snapshot = await adminDb.collection('orders')
            .where('userId', '==', user.uid)
            .orderBy('createdAt', 'desc')
            .limit(1)
            .get();
          if (!snapshot.empty) {
            const doc = snapshot.docs[0];
            orderDoc = { id: doc.id, ...doc.data() };
          }
        }

        // Sanitize: strip internal fields not meant for customer view
        if (orderDoc) {
          delete orderDoc.deliveryPartnerPhone;
          delete orderDoc.internalNotes;
          delete orderDoc.paymentGatewayRef;
        }

        return {
          toolCallId,
          toolName,
          status: 'executed_server',
          result: { order: orderDoc },
          userMessage: orderDoc
            ? `Order #${orderDoc.id.slice(0, 8)} — Status: ${orderDoc.status || 'Processing'}`
            : 'No active orders found for your account.',
          toolLatencyMs: Date.now() - toolStart,
        };
      }



      // ─── UNKNOWN / CLIENT-ONLY FALLBACK ──────────────────────────────────
      default: {
        return {
          toolCallId,
          toolName,
          status: 'forward_client',
          result: args,
          userMessage: `Executing ${toolName}...`,
          toolLatencyMs: Date.now() - toolStart,
        };
      }
    }
  } catch (error: any) {
    console.error(`[BackendToolExecutor] Error executing ${toolName}:`, error.message);
    return {
      toolCallId,
      toolName,
      status: 'error',
      userMessage: `Failed to execute ${toolName.replace(/_/g, ' ')}. Please try again.`,
      result: { error: error.message },
      toolLatencyMs: Date.now() - toolStart,
    };
  }
}
