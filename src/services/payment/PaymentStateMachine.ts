export type PaymentState =
  | 'CREATED'
  | 'INTENT_CREATED'
  | 'PAYMENT_PENDING'
  | 'PAYMENT_AUTHORIZED'
  | 'PAYMENT_CAPTURED'
  | 'ORDER_CREATED'
  | 'NOTIFICATIONS_SENT'
  | 'COMPLETED'
  | 'FAILED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'RECOVERY_PENDING'
  | 'RECOVERY_COMPLETED';

const ALLOWED_TRANSITIONS: Record<PaymentState, PaymentState[]> = {
  CREATED: ['INTENT_CREATED', 'FAILED', 'CANCELLED'],
  INTENT_CREATED: ['PAYMENT_PENDING', 'PAYMENT_AUTHORIZED', 'PAYMENT_CAPTURED', 'FAILED', 'EXPIRED', 'CANCELLED'],
  PAYMENT_PENDING: ['PAYMENT_AUTHORIZED', 'PAYMENT_CAPTURED', 'FAILED', 'EXPIRED', 'CANCELLED', 'RECOVERY_PENDING'],
  PAYMENT_AUTHORIZED: ['PAYMENT_CAPTURED', 'FAILED', 'CANCELLED', 'REFUNDED'],
  PAYMENT_CAPTURED: ['ORDER_CREATED', 'RECOVERY_PENDING', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  ORDER_CREATED: ['NOTIFICATIONS_SENT', 'COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  NOTIFICATIONS_SENT: ['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  COMPLETED: ['REFUNDED', 'PARTIALLY_REFUNDED'],

  FAILED: ['RECOVERY_PENDING', 'INTENT_CREATED'], // Allow retry
  REFUNDED: [],
  PARTIALLY_REFUNDED: ['REFUNDED'],
  EXPIRED: ['INTENT_CREATED'], // Allow retry
  CANCELLED: [],
  RECOVERY_PENDING: ['ORDER_CREATED', 'RECOVERY_COMPLETED', 'FAILED', 'REFUNDED'],
  RECOVERY_COMPLETED: ['ORDER_CREATED', 'COMPLETED'],
};

export class PaymentStateMachine {
  public static validateTransition(currentState: PaymentState, nextState: PaymentState): boolean {
    const allowed = ALLOWED_TRANSITIONS[currentState] || [];
    return allowed.includes(nextState);
  }

  public static transition(currentState: PaymentState, nextState: PaymentState): PaymentState {
    if (!this.validateTransition(currentState, nextState)) {
      throw new Error(`Illegal Payment State Machine Transition: Cannot move from "${currentState}" to "${nextState}"`);
    }
    console.log(`[PaymentStateMachine] State Transition: ${currentState} ➔ ${nextState}`);
    return nextState;
  }
}
