export interface SpooledRequest {
  url: string;
  method: 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  enqueuedAt: number;
}

export interface DrainResult {
  attempted: number;
  drained: number;
  remaining: number;
}
