import type { PaprIPCRequest, PaprIPCResponse } from '@codepapr/types';

export function isPaprMessage(data: unknown): data is PaprIPCRequest {
  return (
    typeof data === 'object' &&
    data !== null &&
    '__papr' in data &&
    (data as PaprIPCRequest).__papr === true &&
    typeof (data as PaprIPCRequest).reqId === 'string' &&
    typeof (data as PaprIPCRequest).type === 'string'
  );
}

export function createPaprResponse(
  reqId: string,
  result?: unknown,
  error?: { code: string; message: string },
): PaprIPCResponse {
  const resp: PaprIPCResponse = { __papr: true, reqId };
  if (error) {
    resp.error = error;
  } else {
    resp.result = result;
  }
  return resp;
}
