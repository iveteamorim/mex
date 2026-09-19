export function execute(amount: number): string {
  return settlePayment(amount);
}

export function settlePayment(amount: number): string {
  return `settled:${amount}`;
}
