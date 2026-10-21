// Contract of the payment provider (ЮKassa). Implemented in ./yookassa.ts.

export type PaymentStatus = 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';

export interface PaymentProvider {
  // Creates a payment with automatic capture. idempotenceKey must be unique per payment across orders and the ledger
  // (e.g. `order-12-500`, `payment-34`): ЮKassa returns the same payment for a repeated key.
  create(idempotenceKey: string, amountRub: number, description: string, returnUrl: string): Promise<{ id: string; url: string }>;
  status(paymentId: string): Promise<PaymentStatus>;
}
