import dotenv from 'dotenv';
import { adminDb as db } from '../../config/firebase.js';
import { WebsiteConfigService } from '../websiteConfig/WebsiteConfigService.js';
import { OlivePizzaAISDK } from '../OlivePizzaAISDK.js';

dotenv.config();

export class OwnerAIService {
  /**
   * Process Natural Language website command from Owner
   * Delegates AI reasoning to Olive Pizza AI via OlivePizzaAISDK while executing
   * website draft/theme updates in Main Backend.
   */
  static async processOwnerCommand(
    command: string,
    userId: string,
    sessionId = `session_${Date.now()}`
  ): Promise<{
    success: boolean;
    explanation: string;
    diff: any;
    previewReady: boolean;
    suggestions: string[];
    latencyMs: number;
    modelUsed: string;
    componentGenerated?: any;
  }> {
    const startTime = Date.now();
    const currentDraft = await WebsiteConfigService.getHomepageDraft();
    const currentTheme = await WebsiteConfigService.getTheme();

    let modelUsed = 'OlivePizzaAI Platform';
    let explanation = '';
    let diff: any = {};
    let suggestions: string[] = [];

    try {
      const sdkResult = await OlivePizzaAISDK.processOwnerCommand(command, userId, sessionId);
      explanation = sdkResult.explanation || `Processed website command: "${command}".`;
      diff = sdkResult.diff || {};
      suggestions = sdkResult.suggestions || ['Publish changes when ready', 'Adjust layout in SDUI Designer'];
      modelUsed = sdkResult.modelUsed || 'OlivePizzaAI Platform';


    } catch (e: any) {
      console.warn('[OwnerAIService] Rule-based fallback execution:', e.message);
      modelUsed = 'rule-based-fallback';
      const lower = command.toLowerCase();
      if (lower.includes('dark') || lower.includes('night')) {
        diff = { theme: { mode: 'dark', colors: { ...currentTheme.colors, background: '#0B0F14' } } };
        explanation = 'Switched theme to dark mode with rich olive background.';
      } else if (lower.includes('light')) {
        diff = { theme: { mode: 'light', colors: { ...currentTheme.colors, background: '#ffffff', surface: '#f3f4f6', text: '#111827' } } };
        explanation = 'Switched theme to clean light mode.';
      } else {
        explanation = `Processed command: "${command}". Preview is ready.`;
        diff = { sections: currentDraft.sections };
      }
    }

    const latencyMs = Date.now() - startTime;

    if (diff.sections) {
      await WebsiteConfigService.saveHomepageDraft({ sections: diff.sections }, userId);
    }
    if (diff.theme) {
      await WebsiteConfigService.saveTheme(diff.theme, userId);
    }

    try {
      await db.collection('owner_ai_sessions').add({
        sessionId,
        userId,
        command,
        explanation,
        diff,
        modelUsed,
        latencyMs,
        createdAt: new Date().toISOString(),
      });
    } catch {}

    return {
      success: true,
      explanation,
      diff,
      previewReady: true,
      suggestions,
      latencyMs,
      modelUsed,
    };
  }

  /**
   * Get AI Sessions history for Developer Dashboard AI Monitor
   */
  static async getAISessionHistory(limitCount = 50): Promise<any[]> {
    try {
      const snap = await db
        .collection('owner_ai_sessions')
        .orderBy('createdAt', 'desc')
        .limit(limitCount)
        .get();
      return snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    } catch (e) {
      return [];
    }
  }
}
