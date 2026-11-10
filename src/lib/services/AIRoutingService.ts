import { OlivePizzaAISDK } from '../../services/OlivePizzaAISDK.js';
import { aiHealthMonitor } from './AIHealthMonitor.js';

export type IntentType = 'CUSTOMER_CHAT' | 'RECOMMENDATION' | 'MENU' | 'CHECKOUT' | 'TRACKING' | 'DELIVERY' | 'ANALYTICS' | 'REPORT';

interface AIResponse {
  reply: string;
  action?: any;
}

export class AIRoutingService {
  constructor() {
    console.log('[AIRoutingService] Delegating all routing to Olive Pizza AI Platform via OlivePizzaAISDK');
  }

  async processRequest(
    message: string,
    history: { role: string; content: string }[],
    intent: IntentType,
    context?: any
  ): Promise<AIResponse> {
    const startTime = Date.now();
    try {
      const result = await OlivePizzaAISDK.chat({
        message,
        history: history.map(h => ({
          role: h.role === 'assistant' ? 'assistant' : 'user',
          content: h.content,
        })),
        userContext: { intent, ...context },
      });

      aiHealthMonitor.recordRequest('nvidia', Date.now() - startTime, true, 0);

      return {
        reply: result.reply,
        action: null,
      };
    } catch (err: any) {
      console.error('[AIRoutingService] Request error via OlivePizzaAISDK:', err.message);
      aiHealthMonitor.recordRequest('nvidia', Date.now() - startTime, false, 1);
      return {
        reply: 'Olive Pizza AI is currently processing your request.',
      };
    }
  }
}

export const aiRoutingService = new AIRoutingService();
