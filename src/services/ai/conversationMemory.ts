/**
 * conversationMemory.ts — Memory Adapter for Olive Pizza AI Integration
 * 
 * Main Project MUST NOT store internal AI conversation memory.
 * Session history & memory are managed exclusively by Olive Pizza AI Platform.
 */

export class ConversationMemoryAdapter {
  getOrCreateSession(sessionId: string, userId?: string, userRole = 'guest') {
    return { id: sessionId, userId, role: userRole, messages: [] };
  }

  addMessage(_sessionId: string, _message: { role: string; content: string }) {
    // No-op: Managed by Olive Pizza AI Platform
  }

  updateLanguage(_sessionId: string, _lang: string) {
    // No-op: Managed by Olive Pizza AI Platform
  }

  clearSession(_sessionId: string) {}
  clearUserSessions(_userId: string) {}

  getStats() {
    return { activeSessions: 0, totalMessages: 0, platform: 'Olive Pizza AI' };
  }
}

export const conversationMemory = new ConversationMemoryAdapter();
