// Contract of the payment provider (ЮKassa). Implemented in ./yookassa.ts.

export type PaymentStatus = 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';

export interface PaymentProvider {
  // Creates a payment with automatic capture; idempotent per orderId
  create(orderId: number, amountRub: number, description: string, returnUrl: string): Promise<{ id: string; url: string }>;
  status(paymentId: string): Promise<PaymentStatus>;
}
