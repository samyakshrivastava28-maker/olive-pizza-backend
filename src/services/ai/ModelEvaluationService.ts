import dotenv from 'dotenv';
import { OlivePizzaAISDK } from '../OlivePizzaAISDK.js';

dotenv.config();

export interface ModelEvalResult {
  modelName: string;
  modelId: string;
  promptType: 'conversation' | 'tool_calling';
  promptText: string;
  output: string;
  latencyMs: number;
  success: boolean;
  notes?: string;
}

export async function evaluateLLMs(): Promise<{ results: ModelEvalResult[]; summary: string; winner: string }> {
  const start = Date.now();
  try {
    const health = await OlivePizzaAISDK.getAIHealthStatus();
    const latencyMs = Date.now() - start;

    const result: ModelEvalResult = {
      modelName: 'Olive Pizza AI Platform Router',
      modelId: 'olive-pizza-ai-v1',
      promptType: 'conversation',
      promptText: 'System AI Health check',
      output: health.ok ? 'Olive Pizza AI Platform is fully operational.' : 'Olive Pizza AI Platform status check failed.',
      latencyMs,
      success: health.ok,
      notes: `Platform: ${health.platform}, Version: ${health.version}`,
    };

    return {
      results: [result],
      summary: health.ok ? 'Olive Pizza AI Platform is active and healthy.' : 'Olive Pizza AI Platform is offline or unreachable.',
      winner: 'Olive Pizza AI Platform',
    };
  } catch (err: any) {
    return {
      results: [],
      summary: `Evaluation error: ${err.message}`,
      winner: 'None',
    };
  }
}
